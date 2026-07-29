import * as THREE from 'three';
import { SceneObjectSchema, type Player, type Scene, type SceneObject } from '@helaengine/schema';
import type { AssetResolver } from './assets.js';
import { BehaviorRuntime } from './BehaviorRuntime.js';
import { buildScenePhysics, resolveColliderType } from './physics/buildScenePhysics.js';
import type { PhysicsWorld } from './physics/PhysicsWorld.js';
import type { PlayerController } from './physics/PlayerController.js';
import type { LoadedScene, SceneLoader } from './SceneLoader.js';
import { TriggerRuntime } from './TriggerRuntime.js';
import type { SpawnRequest, WorldHandle } from './world.js';

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
}

const nextPosition = new THREE.Vector3();

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

  #player: PlayerController | null;
  #health: number;
  #spawnCounter = 0;
  #started = false;

  constructor(options: GameRuntimeOptions) {
    this.#loader = options.loader;
    this.#loaded = options.loaded;
    this.#resolver = options.resolver;
    this.#physics = options.physics ?? null;
    this.#player = options.player ?? null;
    this.#playerSettings = options.scene.player;
    this.#health = options.scene.player.health;
    this.#documentObjects = new Map(options.scene.objects.map((object) => [object.id, object]));
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
  }

  /** Hands the runtime the character, when one is created after the world is built. */
  setPlayer(player: PlayerController | null): void {
    this.#player = player;
  }

  get playerAlive(): boolean {
    return this.#health > 0;
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
  }

  /** One frame: triggers first, so a spawn is alive for the behaviours running right after it. */
  update(deltaSeconds: number): void {
    if (!this.#started) return;
    this.triggers.update();
    this.behaviors.update(deltaSeconds);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;

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

    this.#health = Math.max(0, this.#health - amount);
    this.behaviors.emit('playerDamaged', { amount, health: this.#health });
    if (this.#health === 0) this.behaviors.emit('playerDied', {});
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
