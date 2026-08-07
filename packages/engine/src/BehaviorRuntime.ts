import type { BehaviorEntry, Scene, SceneObject } from '@helaengine/schema';
import type { Behavior, BehaviorContext, GameObject } from './behaviors/Behavior.js';
import { behaviorRegistry, type BehaviorRegistry } from './behaviors/BehaviorRegistry.js';
import type { AnimationState } from '@helaengine/schema';
import type { LoadedScene } from './SceneLoader.js';
import { INERT_WORLD, type WorldHandle } from './world.js';

export interface BehaviorRuntimeOptions {
  loaded: LoadedScene;
  scene: Scene;
  registry?: BehaviorRegistry;
  /** What gameplay can ask of the world around it. Defaults to a world that answers "nothing". */
  world?: WorldHandle;
  /** Sink for non-fatal problems: unknown types, bad params. Default: `console.warn`. */
  warn?: (message: string) => void;
}

export interface BehaviorProblem {
  objectId: string;
  behaviorType: string;
  reason: string;
}

interface Attachment {
  objectId: string;
  object: GameObject;
  behavior: Behavior;
}

interface Claim {
  priority: number;
  owner: Attachment;
}

/**
 * Instantiates the behaviours a scene document asks for and drives them.
 *
 * The runtime is separate from `SceneLoader` because loading and running are different questions:
 * the editor loads a scene constantly and runs it only when asked, while an exported project does
 * both once. Keeping them apart is also what makes "edit mode" and "play mode" a matter of
 * starting and stopping this, rather than rebuilding the world.
 *
 * A behaviour that cannot be created — unknown type, params that fail its schema — is reported and
 * skipped. One bad entry in a document must not cost the user their whole scene.
 */
export class BehaviorRuntime {
  readonly problems: BehaviorProblem[] = [];

  readonly #attachments: Attachment[] = [];
  readonly #objects = new Map<string, GameObject>();
  readonly #assetIds = new Map<string, string>();
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly #anyListeners = new Set<(event: string, payload: unknown) => void>();
  readonly #claims = new Map<string, Claim>();
  readonly #context: { elapsed: number } = { elapsed: 0 };
  readonly #registry: BehaviorRegistry;
  readonly #loaded: LoadedScene;
  readonly #warn: (message: string) => void;

  #world: WorldHandle;
  #started = false;

  constructor(options: BehaviorRuntimeOptions) {
    this.#registry = options.registry ?? behaviorRegistry;
    this.#loaded = options.loaded;
    this.#world = options.world ?? INERT_WORLD;
    this.#warn = options.warn ?? ((message) => console.warn(`[helaengine] ${message}`));

    for (const object of options.scene.objects) {
      this.#registerObject(object.id, object.assetId);
    }
    for (const object of options.scene.objects) {
      this.#attach(object.id, object.behaviors);
    }
  }

  get attachmentCount(): number {
    return this.#attachments.length;
  }

  /**
   * Points the runtime at a real world.
   *
   * Construction and having somewhere to run are separate moments: the game runtime builds its
   * behaviours first and only then has a world handle to give them, because the handle needs the
   * runtime it is being handed to.
   */
  setWorld(world: WorldHandle): void {
    this.#world = world;
  }

  /** Runs every `onInit`. Safe to call once; further calls do nothing. */
  start(): void {
    if (this.#started) return;
    this.#started = true;

    const context: BehaviorContext = this.#context;
    for (const { object, behavior } of [...this.#attachments]) {
      behavior.onInit?.(object, context);
    }
  }

  /** Advances every behaviour. `deltaSeconds` is clamped, so a stalled tab cannot teleport actors. */
  update(deltaSeconds: number): void {
    if (!this.#started) return;

    const delta = Math.min(Math.max(deltaSeconds, 0), 0.1);
    this.#context.elapsed += delta;

    const context: BehaviorContext = this.#context;
    // Iterated over a copy, because a behaviour may spawn or destroy objects mid-update. The
    // membership check then skips anything removed during this same pass.
    for (const attachment of [...this.#attachments]) {
      if (!this.#attachments.includes(attachment)) continue;
      attachment.behavior.onUpdate?.(attachment.object, delta, context);
    }
  }

  emit(event: string, payload?: unknown): void {
    for (const attachment of [...this.#attachments]) {
      if (!this.#attachments.includes(attachment)) continue;
      attachment.behavior.onEvent?.(attachment.object, event, payload);
    }
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(payload);
    for (const listener of [...this.#anyListeners]) listener(event, payload);
  }

  /** Subscribes to an event. Returns an unsubscribe function. */
  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  /**
   * Subscribes to every event. Returns an unsubscribe function.
   *
   * For listeners whose set of interesting events comes from the document rather than from code —
   * the unlock runtime asks about all of them because which ones matter is a property of the scene.
   */
  onAny(listener: (event: string, payload: unknown) => void): () => void {
    this.#anyListeners.add(listener);
    return () => this.#anyListeners.delete(listener);
  }

  /**
   * Adds an object that was not in the document — something a trigger spawned.
   *
   * Its behaviours are initialised immediately when the runtime is already running, so a spawned
   * enemy starts thinking on the frame it appears rather than whenever something next restarts.
   */
  addObject(object: SceneObject): void {
    this.#registerObject(object.id, object.assetId);
    const added = this.#attach(object.id, object.behaviors);
    if (!this.#started) return;

    const context: BehaviorContext = this.#context;
    for (const attachment of added) attachment.behavior.onInit?.(attachment.object, context);
  }

  /** Removes an object's behaviours, running their teardown. */
  removeObject(objectId: string): void {
    for (let index = this.#attachments.length - 1; index >= 0; index -= 1) {
      const attachment = this.#attachments[index]!;
      if (attachment.objectId !== objectId) continue;
      attachment.behavior.onDestroy?.(attachment.object);
      this.#attachments.splice(index, 1);
    }
    this.#claims.delete(objectId);
    this.#objects.delete(objectId);
    this.#assetIds.delete(objectId);
  }

  /** The behaviour instances attached to an object, for tests and debug readouts. */
  behaviorsFor(objectId: string): Behavior[] {
    return this.#attachments
      .filter((attachment) => attachment.objectId === objectId)
      .map((attachment) => attachment.behavior);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;

    for (const { object, behavior } of [...this.#attachments]) {
      behavior.onDestroy?.(object);
    }
    this.#listeners.clear();
    this.#anyListeners.clear();
    this.#claims.clear();
  }

  #registerObject(objectId: string, assetId: string): void {
    if (!this.#loaded.objects.has(objectId)) return;
    this.#assetIds.set(objectId, assetId);
    this.#objects.set(objectId, this.#makeHandle(objectId, null));
  }

  /**
   * Builds the handle a behaviour sees.
   *
   * One per attachment rather than one per object, because the movement claim has to know *who* is
   * asking. `find()` hands out the object-level handle instead: a behaviour looking up a sibling
   * has no business claiming that sibling's movement.
   */
  #makeHandle(objectId: string, owner: Attachment | null): GameObject {
    const node = this.#loaded.objects.get(objectId)!;
    const assetId = this.#assetIds.get(objectId) ?? '';
    const find = (id: string): GameObject | undefined => this.#objects.get(id);
    const emit = (event: string, payload?: unknown): void => this.emit(event, payload);
    // A getter rather than a captured value: the world handle arrives after construction, and
    // every handle has to see the same one when it does.
    const world = (): WorldHandle => this.#world;
    const requestControl = (priority = 0): boolean =>
      owner ? this.#requestControl(owner, priority) : false;
    const releaseControl = (): void => {
      if (owner) this.#releaseControl(owner);
    };
    const hasControl = (): boolean => (owner ? this.#claims.get(objectId)?.owner === owner : false);
    // Looked up per call rather than captured: an object can be recycled out of and back into the
    // pool, and a captured animator would be the one belonging to its previous life.
    const setAnimationState = (state: AnimationState): void => {
      this.#loaded.animator(objectId)?.play(state);
    };

    return {
      id: objectId,
      assetId,
      node,
      find,
      emit,
      get world(): WorldHandle {
        return world();
      },
      requestControl,
      releaseControl,
      hasControl,
      setAnimationState,
    };
  }

  #requestControl(owner: Attachment, priority: number): boolean {
    const claim = this.#claims.get(owner.objectId);
    if (claim && claim.owner !== owner && priority < claim.priority) return false;

    this.#claims.set(owner.objectId, { priority, owner });
    return true;
  }

  #releaseControl(owner: Attachment): void {
    if (this.#claims.get(owner.objectId)?.owner === owner) this.#claims.delete(owner.objectId);
  }

  #attach(objectId: string, entries: readonly BehaviorEntry[]): Attachment[] {
    if (!this.#objects.has(objectId)) return [];

    const added: Attachment[] = [];
    for (const entry of entries) {
      try {
        const behavior = this.#registry.create(entry.type, entry.params);
        const attachment: Attachment = {
          objectId,
          object: this.#objects.get(objectId)!,
          behavior,
        };
        attachment.object = this.#makeHandle(objectId, attachment);
        this.#attachments.push(attachment);
        added.push(attachment);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.problems.push({ objectId, behaviorType: entry.type, reason });
        this.#warn(`object "${objectId}": ${reason}`);
      }
    }
    return added;
  }
}
