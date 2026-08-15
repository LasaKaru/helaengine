import * as THREE from 'three';
import {
  SceneObjectSchema,
  type AnimationState,
  type PickupKind,
  type Player,
  type Scene,
  type SceneObject,
  type CarriedState,
} from '@helaengine/schema';
import type { AssetResolver } from './assets.js';
import { BehaviorRuntime } from './BehaviorRuntime.js';
import { buildScenePhysics, resolveColliderType } from './physics/buildScenePhysics.js';
import { DestructibleSystem, type FragmentRequest } from './combat/DestructibleSystem.js';
import type { PhysicsWorld } from './physics/PhysicsWorld.js';
import type { PlayerController } from './physics/PlayerController.js';
import type { LoadedScene, SceneLoader } from './SceneLoader.js';
import { TriggerRuntime } from './TriggerRuntime.js';
import { Inventory } from './combat/Inventory.js';
import { UnlockRuntime } from './unlock/UnlockRuntime.js';
import { GraphRuntime, graphHasContent } from './graph/GraphRuntime.js';
import { WeaponSystem, type ShotHit, type WeaponInput } from './combat/WeaponSystem.js';
import type { PickupRequest, SpawnRequest, WorldHandle } from './world.js';
import type { CheckpointReset, SaveState, UnlockKey } from '@helaengine/schema';
import type { CheckpointRequest } from './world.js';

export interface GameRuntimeOptions {
  loader: SceneLoader;
  loaded: LoadedScene;
  scene: Scene;
  resolver: AssetResolver;
  /** Optional: without one, movement falls back to writing node transforms and nothing collides. */
  physics?: PhysicsWorld | null;
  /** Optional: without one, `playerPosition()` answers null and enemies never find anybody. */
  player?: PlayerController | null;
  warn?: (message: string) => void;
  /**
   * Where a dead player comes back.
   *
   * Separate from `scene.player.spawn` because the host has usually already corrected that point
   * against the terrain, and respawning a metre inside a hill is not an improvement on being dead.
   */
  spawnPoint?: THREE.Vector3;
}

const nextPosition = new THREE.Vector3();
const shotOrigin = new THREE.Vector3();
const breakPoint = new THREE.Vector3();

/**
 * Everything that has to be true for a scene to be *running* rather than merely loaded.
 *
 * Behaviours, triggers, physics and the player are four things that each need the other three:
 * an enemy needs to know where the player is and whether a wall is in the way, a trigger needs to
 * be able to spawn that enemy, and the spawned enemy needs a collider. Something has to own the
 * introductions, and this is it — deliberately the only class in the engine that knows about all
 * four, so nothing else has to.
 *
 * It is also what an exported project will construct at startup (Sprint 21): the editor's Play
 * Preview is not a special path, it is this class with a viewport attached.
 */
export class GameRuntime implements WorldHandle {
  readonly behaviors: BehaviorRuntime;
  readonly triggers: TriggerRuntime;
  readonly inventory: Inventory;
  readonly weapons: WeaponSystem;
  readonly destructibles: DestructibleSystem;
  readonly unlocks: UnlockRuntime;
  /** The scene's visual script, or null when it has none. */
  readonly graph: GraphRuntime | null;

  readonly #loader: SceneLoader;
  readonly #loaded: LoadedScene;
  readonly #resolver: AssetResolver;
  readonly #physics: PhysicsWorld | null;
  readonly #playerSettings: Player;
  readonly #warn: (message: string) => void;
  /** Ids of objects this runtime created, so stopping can put the world back as it found it. */
  readonly #spawned: string[] = [];
  /** Document objects the preview destroyed, kept so stopping can put them back. */
  readonly #removed = new Map<string, SceneObject>();
  /** The document's own objects, by id — the set that must survive a preview unchanged. */
  readonly #documentObjects: Map<string, SceneObject>;
  /** Which scene a save belongs to. Refusing another scene's save is the only use. */
  readonly #sceneId: string;

  readonly #spawnPoint: THREE.Vector3;
  /** The last checkpoint reached, or null for "the spawn point is still the answer". */
  #checkpoint: { objectId: string; position: THREE.Vector3; reset: CheckpointReset } | null = null;
  /** Seconds of play, carried into a save so a timer survives a reload. */
  #elapsed = 0;

  #player: PlayerController | null;
  #health: number;
  #spawnCounter = 0;
  #started = false;
  /** Seconds until damage can land again — see `player.damageCooldown`. */
  #damageCooldown = 0;
  /** Seconds until a dead player is put back on their feet, or null when they are alive. */
  #respawnIn: number | null = null;

  /**
   * A level change the graph has asked for, waiting for the host to act on it.
   *
   * A field the host polls rather than a callback the runtime fires. Loading a level tears down the
   * very objects whose update is on the stack at the moment the request is made, so doing it there
   * would be freeing memory a running behaviour is holding. The host reads this between frames,
   * where there is nothing in flight to invalidate.
   *
   * First request wins. A frame in which two doors both fire is a level design question with no
   * right answer, and picking the last one would make it depend on document order.
   */
  #pendingLevel: { levelId: string; carryState: boolean } | null = null;

  constructor(options: GameRuntimeOptions) {
    this.#loader = options.loader;
    this.#loaded = options.loaded;
    this.#resolver = options.resolver;
    this.#physics = options.physics ?? null;
    this.#player = options.player ?? null;
    this.#playerSettings = options.scene.player;
    this.#health = options.scene.player.health;
    this.#documentObjects = new Map(options.scene.objects.map((object) => [object.id, object]));
    this.#sceneId = options.scene.sceneId;
    this.#spawnPoint = (
      options.spawnPoint ?? new THREE.Vector3(...options.scene.player.spawn)
    ).clone();
    this.inventory = new Inventory(options.scene.inventory);
    this.#warn = options.warn ?? ((message) => console.warn(`[helaengine] ${message}`));

    this.behaviors = new BehaviorRuntime({
      loaded: options.loaded,
      scene: options.scene,
      world: this,
      ...(options.warn ? { warn: options.warn } : {}),
    });
    this.triggers = new TriggerRuntime({
      loaded: options.loaded,
      scene: options.scene,
      world: this,
      bus: this.behaviors,
    });
    this.unlocks = new UnlockRuntime({
      unlockables: options.scene.unlockables,
      world: this,
      bus: this.behaviors,
    });
    this.weapons = new WeaponSystem({
      inventory: this.inventory,
      cast: (origin, direction, range) => this.#castShot(origin, direction, range),
      emit: (event, payload) => this.emit(event, payload),
    });

    this.destructibles = new DestructibleSystem({
      positionOf: (objectId) => {
        const node = this.#loaded.objects.get(objectId);
        if (!node) return null;
        node.getWorldPosition(breakPoint);
        return [breakPoint.x, breakPoint.y, breakPoint.z];
      },
      destroy: (objectId) => this.destroy(objectId),
      spawnDebris: (request) => this.#spawnDebris(request),
      emit: (event, payload) => this.emit(event, payload),
    });

    for (const object of options.scene.objects) {
      if (object.destructible) this.destructibles.register(object.id, object.destructible);
    }

    // Breaking listens for the same `damage` message an enemy answers to, rather than weapons
    // learning what a crate is. That is why shooting a destructible needed no change to
    // `WeaponSystem` at all — and why a trigger, a graph node or a script can break something by
    // raising the event everything else already raises.
    this.behaviors.on('damage', (payload) => {
      const hit = payload as { targetId?: unknown; amount?: unknown } | undefined;
      if (typeof hit?.targetId !== 'string' || typeof hit.amount !== 'number') return;
      this.destructibles.damage(hit.targetId, hit.amount);
    });

    // Null when the scene has no events to run, which is every scene saved before graphs existed.
    // Constructing one anyway would validate an empty document and subscribe to nothing, sixty
    // times a second, for no reason.
    this.graph = graphHasContent(options.scene.graph)
      ? new GraphRuntime({
          graph: options.scene.graph,
          world: this,
          bus: this.behaviors,
          ...(options.warn ? { warn: options.warn } : {}),
        })
      : null;
  }

  /** Hands the runtime the character, when one is created after the world is built. */
  setPlayer(player: PlayerController | null): void {
    this.#player = player;
  }

  get playerAlive(): boolean {
    return this.#health > 0;
  }

  /** Object id of the checkpoint currently held, or null. */
  get checkpointId(): string | null {
    return this.#checkpoint?.objectId ?? null;
  }

  get elapsedSeconds(): number {
    return this.#elapsed;
  }

  /** Ids of objects spawned since start — none of which are in the document. */
  get spawnedIds(): readonly string[] {
    return this.#spawned;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.behaviors.start();
    this.triggers.start();
    // Before unlocks and after triggers: an `onStart` chain should reach a world whose triggers
    // are listening, and a secret hidden by an unlock should be hidden after the graph has had its
    // say about the same object.
    this.graph?.start();
    // Last, so that hiding a secret area happens after the behaviours that might be attached to it
    // have initialised — and so an unlock firing on frame one reaches a fully built world.
    this.unlocks.start();
  }

  /**
   * One frame: triggers first, so a spawn is alive for the behaviours running right after it.
   *
   * `weapons` is optional because plenty of callers — a headless behaviour test, a scene with no
   * inventory at all — have no aim to give. Combat then simply does not advance, which is the
   * truthful outcome rather than a shot fired from the origin.
   */
  update(deltaSeconds: number, weapons?: WeaponInput, sequenceKeys?: readonly UnlockKey[]): void {
    if (!this.#started) return;

    this.#elapsed += deltaSeconds;
    this.#damageCooldown = Math.max(0, this.#damageCooldown - deltaSeconds);
    this.#tickRespawn(deltaSeconds);

    this.triggers.update();
    this.behaviors.update(deltaSeconds);
    this.unlocks.update(deltaSeconds, sequenceKeys ?? []);
    // After the behaviours, so a `wait` that resumes this frame sees the world as it is now rather
    // than as it was before the enemies moved.
    this.graph?.update(deltaSeconds);
    // Weapons last: a shot should see the world as it is at the end of the frame the player fired
    // in, not as it was before the enemies moved.
    if (weapons && this.playerAlive) this.weapons.update(deltaSeconds, weapons);
    // After weapons, so debris created by this frame's shot starts its life with a full lifetime
    // rather than one already a frame short.
    this.destructibles.update(deltaSeconds);
  }

  /**
   * Puts a dead player back on their feet.
   *
   * The whole of Sprint 16's death handling, and deliberately a stub: Sprint 18 replaces the spawn
   * point with the last checkpoint and restores inventory from a save, and neither of those changes
   * the shape of this. What matters now is that dying is recoverable rather than terminal.
   */
  respawnPlayer(): void {
    const checkpoint = this.#checkpoint;
    const maximum = this.#playerSettings.health;

    if (checkpoint) {
      // The rules the checkpoint was *reached* under, not the rules the document says now. A save
      // records what happened.
      switch (checkpoint.reset.health) {
        case 'full':
          this.#health = maximum;
          break;
        case 'partial':
          this.#health = Math.max(1, Math.round(maximum * checkpoint.reset.healthFraction));
          break;
        case 'none':
          // Coming back on zero health would be an instant second death, so the floor is one.
          this.#health = Math.max(1, this.#health);
          break;
      }
      if (checkpoint.reset.ammo === 'full') this.inventory.refillAll();
    } else {
      this.#health = maximum;
    }

    this.#respawnIn = null;
    this.#damageCooldown = this.#playerSettings.damageCooldown;

    const where = checkpoint?.position ?? this.#spawnPoint;
    this.#player?.teleport(where);
    this.behaviors.emit('playerRespawned', {
      position: where.toArray(),
      checkpointId: checkpoint?.objectId ?? null,
    });
  }

  /**
   * Everything worth carrying across a reload.
   *
   * State, never structure: a save says how much health and which weapons, never which objects a
   * scene contains — so no save, however edited, can change what the game *is*.
   */
  captureSave(): SaveState {
    const where = this.#checkpoint?.position ?? this.#spawnPoint;
    return {
      version: 1,
      sceneId: this.#sceneId,
      savedAt: Date.now(),
      checkpointId: this.#checkpoint?.objectId ?? null,
      checkpointPosition: [where.x, where.y, where.z],
      health: this.#health,
      weapons: this.inventory.snapshot(),
      currentWeaponId: this.inventory.current?.weapon.id ?? null,
      unlockedIds: this.unlocks.unlockedIds,
      elapsedSeconds: this.#elapsed,
    };
  }

  /**
   * Puts a saved run back.
   *
   * Returns false for a save from another scene rather than applying it — respawning somebody at a
   * checkpoint from a different level is worse than starting them over. The checkpoint's *rules*
   * are not saved: a resumed run that then dies falls back to a full restore, which is the generous
   * reading and avoids inventing rules the document may no longer contain.
   */
  restoreSave(state: SaveState): boolean {
    if (state.sceneId !== this.#sceneId) return false;

    this.#health = Math.min(state.health, this.#playerSettings.health);
    this.#elapsed = state.elapsedSeconds;
    this.#respawnIn = null;
    this.inventory.restore(state.weapons, state.currentWeaponId);
    this.unlocks.restore(state.unlockedIds);

    if (state.checkpointId) {
      this.#checkpoint = {
        objectId: state.checkpointId,
        position: new THREE.Vector3(...state.checkpointPosition),
        reset: { health: 'full', healthFraction: 0.5, ammo: 'none' },
      };
      this.#player?.teleport(this.#checkpoint.position);
    }

    this.behaviors.emit('progressRestored', { checkpointId: state.checkpointId });
    return true;
  }

  #tickRespawn(deltaSeconds: number): void {
    if (this.#respawnIn === null) return;

    this.#respawnIn -= deltaSeconds;
    if (this.#respawnIn <= 0) this.respawnPlayer();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;

    // First, so its bus subscriptions are gone before the bus itself is torn down — a listener
    // left behind would keep a stopped preview reacting to the next one's events.
    this.graph?.stop();
    this.unlocks.stop();
    this.triggers.stop();
    this.behaviors.stop();
    // Everything this runtime added goes away with it. A preview that left spawned enemies lying
    // around would be quietly editing the scene, which is exactly what preview must never do.
    for (const objectId of [...this.#spawned]) this.destroy(objectId);
    this.#spawned.length = 0;

    // And everything it killed comes back. The document still lists them, so leaving them out
    // would mean the viewport quietly disagreeing with the scene until the next full rebuild.
    for (const object of this.#removed.values()) {
      this.#loader.instantiateInto(this.#loaded, object);
    }
    this.#removed.clear();
    this.#health = this.#playerSettings.health;
    this.#respawnIn = null;
    this.#damageCooldown = 0;
    this.#checkpoint = null;
    this.#elapsed = 0;
  }

  // ---- WorldHandle ----------------------------------------------------------------------

  playerPosition(): THREE.Vector3 | null {
    return this.#player?.position ?? null;
  }

  playerHealth(): number | null {
    return this.#player ? this.#health : null;
  }

  damagePlayer(amount: number): void {
    if (!this.#player || amount <= 0 || this.#health <= 0) return;
    // Two enemies swinging in the same frame would otherwise do double damage, and a crowd would
    // kill the player in a way that reads as a bug rather than as a fight.
    if (this.#damageCooldown > 0) return;

    this.#damageCooldown = this.#playerSettings.damageCooldown;
    this.#health = Math.max(0, this.#health - amount);
    this.behaviors.emit('playerDamaged', { amount, health: this.#health });
    if (this.#health === 0) {
      this.#respawnIn = this.#playerSettings.respawnSeconds;
      this.behaviors.emit('playerDied', {});
    }
  }

  collect(request: PickupRequest): boolean {
    if (!this.#player || this.#health <= 0) return false;

    switch (request.kind) {
      case 'weapon':
        return this.inventory.give(request.weaponId);
      case 'ammo':
        return this.inventory.addAmmo(request.weaponId, request.amount);
      case 'health': {
        const maximum = this.#playerSettings.health;
        // Full health means the medkit is worth keeping for later, so it stays in the world.
        if (this.#health >= maximum || request.amount <= 0) return false;

        this.#health = Math.min(maximum, this.#health + request.amount);
        this.behaviors.emit('playerHealed', { amount: request.amount, health: this.#health });
        return true;
      }
    }
  }

  teleportPlayer(position: THREE.Vector3): void {
    this.#player?.teleport(position);
  }

  setCheckpoint(request: CheckpointRequest): boolean {
    // Already holding this one is not news, and saying so is what stops a repeatable checkpoint
    // writing a save on every frame the player stands in it.
    if (this.#checkpoint?.objectId === request.objectId) return false;

    this.#checkpoint = {
      objectId: request.objectId,
      position: new THREE.Vector3(...request.position),
      reset: request.reset,
    };
    this.behaviors.emit('checkpointReached', {
      checkpointId: request.objectId,
      position: request.position,
    });
    return true;
  }

  setObjectHidden(objectId: string, hidden: boolean): boolean {
    const node = this.#loaded.objects.get(objectId);
    if (!node) return false;

    node.visible = !hidden;
    // The collider goes with it. An invisible wall the player still walks into is the most
    // confusing possible reading of a secret area.
    this.#physics?.setObjectEnabled(objectId, !hidden);
    return true;
  }

  /**
   * Traces a shot, ignoring the shooter's own capsule.
   *
   * Without the exclusion every shot lands on the player at zero distance, because the ray starts
   * inside the character controller's collider. It is the same trap `lineOfSight` fell into from
   * the other direction in Sprint 11.
   */
  #castShot(origin: THREE.Vector3, direction: THREE.Vector3, range: number): ShotHit | null {
    const physics = this.#physics;
    if (!physics) return null;

    shotOrigin.copy(origin);
    return physics.castObject(shotOrigin, direction, range, this.#player?.colliderHandle);
  }

  lineOfSight(from: THREE.Vector3, to: THREE.Vector3, ignoreObjectId?: string): boolean {
    const physics = this.#physics;
    // Without a physics world there is nothing to be blocked by, and answering "yes" is the honest
    // response: the caller is running in a world with no walls in it.
    if (!physics) return true;

    nextPosition.copy(to).sub(from);
    const distance = nextPosition.length();
    if (distance < 1e-4) return true;
    nextPosition.divideScalar(distance);

    const ignore = ignoreObjectId ? physics.bodyFor(ignoreObjectId) : undefined;
    const hit = physics.world.castRay(
      new physics.rapier.Ray(
        { x: from.x, y: from.y, z: from.z },
        { x: nextPosition.x, y: nextPosition.y, z: nextPosition.z },
      ),
      distance,
      true,
      undefined,
      undefined,
      undefined,
      ignore?.body,
    );

    if (hit === null) return true;
    // The ray is aimed at the player, so hitting the player is the answer "yes, I can see them".
    // Stopping the ray short instead would need the player's radius here, and would still be wrong
    // for anything standing right against them.
    return this.#player !== null && hit.collider.handle === this.#player.colliderHandle;
  }

  groundHeight(x: number, z: number): number {
    return this.#loaded.terrainField?.sampleHeight(x, z) ?? 0;
  }

  moveTo(objectId: string, position: THREE.Vector3): void {
    const record = this.#physics?.bodyFor(objectId);
    if (record && record.type === 'kinematic') {
      record.body.setNextKinematicTranslation({ x: position.x, y: position.y, z: position.z });
      return;
    }

    // No kinematic body: move the node directly. Less correct — it will pass through walls — but a
    // scene whose author never set a body type should still see its enemies move.
    const node = this.#loaded.objects.get(objectId);
    node?.position.copy(position);
  }

  /**
   * How much of a kind of thing the player has.
   *
   * Three kinds, because `PickupKind` has three, and each answers the question a level designer
   * would actually ask of it: how many guns, how much spare ammunition for the one in hand, and how
   * much health. Health overlaps with `playerHealthBelow` deliberately — one is a threshold and one
   * is a count, and a graph reads better with whichever the author was thinking in.
   */
  itemCount(kind: PickupKind): number {
    switch (kind) {
      case 'weapon':
        return this.inventory.carried.length;
      case 'ammo':
        return this.inventory.reserve;
      case 'health':
        return this.#health;
    }
  }

  /**
   * The level change waiting to happen, or null.
   *
   * Read between frames by whatever owns the frame loop — `PhysicsPreview` in the editor, `main.js`
   * in an export. Clearing it is the host's job, by way of `takeLevelRequest`.
   */
  get pendingLevel(): { levelId: string; carryState: boolean } | null {
    return this.#pendingLevel;
  }

  requestLevel(levelId: string, carryState: boolean): void {
    if (levelId === '') return;
    // First wins: see `#pendingLevel`.
    this.#pendingLevel ??= { levelId, carryState };
  }

  /** Takes the pending request and clears it, so one door cannot fire twice. */
  takeLevelRequest(): { levelId: string; carryState: boolean } | null {
    const request = this.#pendingLevel;
    this.#pendingLevel = null;
    return request;
  }

  /**
   * What the player takes with them.
   *
   * Health is clamped by the *next* level rather than here, because this runtime does not know what
   * that level allows — a player leaving a 200 HP level for a 100 HP one arrives at 100, and the
   * decision belongs to whoever is being entered.
   */
  captureCarriedState(): CarriedState {
    return {
      health: this.#health,
      weapons: this.inventory.snapshot(),
      currentWeaponId: this.inventory.current?.weapon.id ?? null,
      unlockedIds: this.unlocks.unlockedIds,
      variables: this.graph?.variables() ?? {},
    };
  }

  /**
   * Puts carried state into a freshly started level.
   *
   * Applied after `start`, so the level's own defaults exist to clamp against and its graph has
   * declared its variables. A variable the new level does not declare is dropped rather than
   * created: a level has to be openable on its own, and one that silently inherited an undeclared
   * variable would only run correctly when reached from the right direction.
   */
  applyCarriedState(state: CarriedState): void {
    if (state.health !== null) {
      this.#health = Math.min(Math.max(state.health, 1), this.#playerSettings.health);
    }
    this.inventory.restore(state.weapons, state.currentWeaponId);
    this.unlocks.restore(state.unlockedIds);
    this.graph?.restoreVariables(state.variables);
  }

  setAnimationState(objectId: string, state: AnimationState): boolean {
    const animator = this.#loaded.animator(objectId);
    if (!animator) return false;
    animator.play(state);
    return true;
  }

  spawn(request: SpawnRequest): string | null {
    this.#spawnCounter += 1;
    const id = `spawn_${String(this.#spawnCounter).padStart(4, '0')}`;

    let object: SceneObject;
    try {
      // Parsed rather than trusted: a spawn request comes from a document, and a document is
      // never trusted anywhere else either.
      object = SceneObjectSchema.parse({
        id,
        assetId: request.assetId,
        transform: {
          position: request.position,
          rotation: [0, request.rotationY ?? 0, 0],
        },
        behaviors: request.behaviors ?? [],
        ...(request.physics ? { physics: request.physics } : {}),
      });
    } catch (error) {
      this.#warn(`spawn rejected: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }

    if (!this.#resolver.has(object.assetId)) {
      this.#warn(`spawn rejected: unknown assetId "${object.assetId}"`);
      return null;
    }

    // Drop it onto the ground rather than at whatever y the caller guessed.
    object.transform.position[1] = Math.max(
      object.transform.position[1],
      this.groundHeight(object.transform.position[0], object.transform.position[2]),
    );

    const node = this.#loader.instantiateInto(this.#loaded, object);
    this.#spawned.push(id);

    if (this.#physics) {
      const entry = this.#resolver.get(object.assetId);
      const shape = resolveColliderType(object, entry?.colliderType ?? 'box');
      const bounds = entry?.bounds ?? [1, 1, 1];
      const scale = entry?.defaultScale ?? [1, 1, 1];
      if (shape !== 'none') {
        this.#physics.addObject({
          objectId: id,
          node,
          shape,
          body: object.physics.body,
          size: [bounds[0] * scale[0], bounds[1] * scale[1], bounds[2] * scale[2]],
          mass: object.physics.mass,
        });
      }
    }

    this.behaviors.addObject(object);
    this.triggers.addObject(object);
    this.behaviors.emit('objectSpawned', { objectId: id, assetId: object.assetId });
    return id;
  }

  destroy(objectId: string): void {
    if (!this.#loaded.objects.has(objectId)) return;

    this.behaviors.removeObject(objectId);
    this.triggers.removeObject(objectId);
    this.#physics?.removeObject(objectId);
    // Recycled rather than released: the next wave will want a node exactly like this one.
    this.#loader.recycle(this.#loaded, objectId);

    const at = this.#spawned.indexOf(objectId);
    if (at >= 0) this.#spawned.splice(at, 1);

    const fromDocument = this.#documentObjects.get(objectId);
    if (fromDocument) this.#removed.set(objectId, fromDocument);
    this.behaviors.emit('objectDestroyed', { objectId });
  }

  emit(event: string, payload?: unknown): void {
    this.behaviors.emit(event, payload);
  }

  /**
   * Places one piece of debris and throws it.
   *
   * Debris is spawned dynamic regardless of what the manifest says the asset usually is: the whole
   * point of a fragment is that it falls. A `spawn` that inherited `static` from a crate's own
   * entry would leave the pieces hanging in the air exactly where the crate used to be, which reads
   * as the break having failed rather than as a setting.
   */
  #spawnDebris(request: FragmentRequest): string | null {
    const id = this.spawn({
      assetId: request.assetId,
      position: request.position,
      physics: { body: 'dynamic', collider: 'auto' },
    });
    if (id === null) return null;

    const node = this.#loaded.objects.get(id);
    if (node && request.scale !== 1) {
      node.scale.multiplyScalar(request.scale);
      node.updateMatrixWorld(true);
    }

    const record = this.#physics?.bodyFor(id);
    if (record && record.type === 'dynamic') {
      // A velocity rather than an impulse: an impulse is scaled by mass, and mass here is usually
      // derived from the collider's volume — so identical fragments of two different debris models
      // would fly apart at visibly different speeds for a reason nobody authored.
      record.body.setLinvel(
        { x: request.velocity[0], y: request.velocity[1], z: request.velocity[2] },
        true,
      );
    }

    return id;
  }
}

/** Builds the physics for a scene and a runtime to drive it — the whole "press play" path. */
export function startScene(options: GameRuntimeOptions): GameRuntime {
  if (options.physics) {
    buildScenePhysics({
      world: options.physics,
      scene: options.scene,
      loaded: options.loaded,
      resolver: options.resolver,
    });
  }

  const runtime = new GameRuntime(options);
  runtime.start();
  return runtime;
}
