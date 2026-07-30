import * as THREE from 'three';
import type { Scene, SceneObject, Trigger, TriggerAction } from '@helaengine/schema';
import type { LoadedScene } from './SceneLoader.js';
import type { WorldHandle } from './world.js';

/** What the runtime needs from an event bus. `BehaviorRuntime` satisfies it. */
export interface EventBus {
  emit(event: string, payload?: unknown): void;
  on(event: string, listener: (payload: unknown) => void): () => void;
  /**
   * Subscribes to every event. Returns an unsubscribe function.
   *
   * Needed by anything that watches for one of a set of events chosen by the document rather than
   * by the code — the unlock runtime, and Sprint 19's audio mapping. Subscribing per name would
   * mean re-subscribing whenever the document changed.
   */
  onAny(listener: (event: string, payload: unknown) => void): () => void;
}

export interface TriggerRuntimeOptions {
  loaded: LoadedScene;
  scene: Scene;
  world: WorldHandle;
  bus: EventBus;
}

interface Volume {
  objectId: string;
  trigger: Trigger;
  node: THREE.Object3D;
  /** Ids currently inside — `player`, or object ids. */
  occupants: Set<string>;
  fired: boolean;
}

const local = new THREE.Vector3();
const spawnAt = new THREE.Vector3();

/**
 * Is a world-space point inside this volume?
 *
 * Tested in the node's own space rather than the world's, which means a rotated or non-uniformly
 * scaled trigger works for free: a trigger stretched into a long corridor is an ellipsoid or an
 * oblong box, and the same two lines of maths cover both.
 */
function contains(volume: Volume, point: THREE.Vector3): boolean {
  volume.node.updateWorldMatrix(true, false);
  local.copy(point);
  volume.node.worldToLocal(local);

  // The volume straddles its object: local y runs 0..1, matching the outline the editor draws.
  if (volume.trigger.shape === 'sphere') {
    return local.x ** 2 + (local.y - 0.5) ** 2 + local.z ** 2 <= 0.25;
  }
  return Math.abs(local.x) <= 0.5 && local.y >= 0 && local.y <= 1 && Math.abs(local.z) <= 0.5;
}

/**
 * Trigger volumes: the part of a scene that watches rather than being watched.
 *
 * Kept apart from `BehaviorRuntime` because a trigger is not attached to anything — it is a
 * property of a place. Its actions are a closed set for exactly the reason behaviours are: a
 * document that could describe arbitrary work would be a document an export could not safely run.
 */
export class TriggerRuntime {
  readonly #volumes: Volume[] = [];
  readonly #world: WorldHandle;
  readonly #loaded: LoadedScene;
  readonly #bus: EventBus;
  readonly #unsubscribes: Array<() => void> = [];
  #started = false;

  constructor(options: TriggerRuntimeOptions) {
    this.#world = options.world;
    this.#loaded = options.loaded;
    this.#bus = options.bus;

    for (const object of options.scene.objects) {
      if (!object.trigger) continue;
      const node = options.loaded.objects.get(object.id);
      if (!node) continue;

      this.#volumes.push({
        objectId: object.id,
        trigger: object.trigger,
        node,
        occupants: new Set(),
        fired: false,
      });
    }
  }

  get volumeCount(): number {
    return this.#volumes.length;
  }

  /** Ids inside a volume right now, for tests and the editor's debug readout. */
  occupantsOf(objectId: string): string[] {
    const volume = this.#volumes.find((entry) => entry.objectId === objectId);
    return volume ? [...volume.occupants] : [];
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;

    for (const volume of this.#volumes) {
      for (const listener of volume.trigger.onEvent) {
        this.#unsubscribes.push(
          this.#bus.on(listener.event, () => {
            if (volume.trigger.once && volume.fired) return;
            volume.fired = true;
            this.#run(volume, listener.actions);
          }),
        );
      }
    }
  }

  /**
   * Re-tests occupancy and fires the transitions.
   *
   * Enter and exit are computed from set differences rather than from collision callbacks: a
   * volume is a question about where things are right now, and asking it directly means a spawned
   * object that appears inside a trigger is noticed, which a contact event would miss entirely.
   */
  update(): void {
    if (!this.#started) return;

    for (const volume of this.#volumes) {
      if (volume.trigger.once && volume.fired) continue;

      const inside = new Set<string>();
      const player = this.#world.playerPosition();
      if (player && contains(volume, player)) inside.add('player');

      if (volume.trigger.detects === 'any') {
        for (const [objectId, node] of this.#loaded.objects) {
          if (objectId === volume.objectId) continue;
          if (node.userData['isTrigger']) continue;
          if (contains(volume, node.getWorldPosition(local.clone()))) inside.add(objectId);
        }
      }

      for (const id of inside) {
        if (volume.occupants.has(id)) continue;
        volume.fired = true;
        // Announced whether or not the author configured any actions: "something entered this
        // volume" is a fact about the world, and a secret or a sound cue wants it without the
        // volume having to be given a dummy action to make it observable.
        this.#bus.emit('triggerEntered', { triggerId: volume.objectId, subjectId: id });
        this.#run(volume, volume.trigger.onEnter, id);
      }
      for (const id of volume.occupants) {
        if (inside.has(id)) continue;
        this.#bus.emit('triggerExited', { triggerId: volume.objectId, subjectId: id });
        this.#run(volume, volume.trigger.onExit, id);
      }

      volume.occupants = inside;
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.length = 0;
    for (const volume of this.#volumes) volume.occupants.clear();
  }

  /** Adds a volume for an object spawned after the scene loaded. */
  addObject(object: SceneObject): void {
    if (!object.trigger) return;
    const node = this.#loaded.objects.get(object.id);
    if (!node) return;

    this.#volumes.push({
      objectId: object.id,
      trigger: object.trigger,
      node,
      occupants: new Set(),
      fired: false,
    });
  }

  removeObject(objectId: string): void {
    const at = this.#volumes.findIndex((volume) => volume.objectId === objectId);
    if (at >= 0) this.#volumes.splice(at, 1);
  }

  #run(volume: Volume, actions: readonly TriggerAction[], subjectId?: string): void {
    for (const action of actions) {
      if (action.type === 'emit') {
        this.#bus.emit(action.event, {
          ...action.payload,
          triggerId: volume.objectId,
          ...(subjectId === undefined ? {} : { subjectId }),
        });
        continue;
      }

      if (action.type === 'destroy') {
        this.#world.destroy(action.targetId);
        continue;
      }

      volume.node.getWorldPosition(spawnAt);
      this.#world.spawn({
        assetId: action.assetId,
        position: [
          spawnAt.x + action.offset[0],
          spawnAt.y + action.offset[1],
          spawnAt.z + action.offset[2],
        ],
        behaviors: action.behaviors,
        physics: action.physics,
      });
    }
  }
}
