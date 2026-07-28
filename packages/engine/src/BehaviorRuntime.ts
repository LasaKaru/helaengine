import type { Scene } from '@helaengine/schema';
import type { Behavior, BehaviorContext, GameObject } from './behaviors/Behavior.js';
import { behaviorRegistry, type BehaviorRegistry } from './behaviors/BehaviorRegistry.js';
import type { LoadedScene } from './SceneLoader.js';

export interface BehaviorRuntimeOptions {
  loaded: LoadedScene;
  scene: Scene;
  registry?: BehaviorRegistry;
  /** Sink for non-fatal problems: unknown types, bad params. Default: `console.warn`. */
  warn?: (message: string) => void;
}

export interface BehaviorProblem {
  objectId: string;
  behaviorType: string;
  reason: string;
}

interface Attachment {
  object: GameObject;
  behavior: Behavior;
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
  readonly #listeners = new Map<string, Set<(payload: unknown) => void>>();
  readonly #context: { elapsed: number } = { elapsed: 0 };

  #started = false;

  constructor(options: BehaviorRuntimeOptions) {
    const registry = options.registry ?? behaviorRegistry;
    const warn = options.warn ?? ((message) => console.warn(`[helaengine] ${message}`));

    for (const object of options.scene.objects) {
      const node = options.loaded.objects.get(object.id);
      if (!node) continue;

      const gameObject: GameObject = {
        id: object.id,
        assetId: object.assetId,
        node,
        find: (objectId) => this.#objects.get(objectId),
        emit: (event, payload) => this.emit(event, payload),
      };
      this.#objects.set(object.id, gameObject);
    }

    for (const object of options.scene.objects) {
      const gameObject = this.#objects.get(object.id);
      if (!gameObject) continue;

      for (const entry of object.behaviors) {
        try {
          this.#attachments.push({
            object: gameObject,
            behavior: registry.create(entry.type, entry.params),
          });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          this.problems.push({ objectId: object.id, behaviorType: entry.type, reason });
          warn(`object "${object.id}": ${reason}`);
        }
      }
    }
  }

  get attachmentCount(): number {
    return this.#attachments.length;
  }

  /** Runs every `onInit`. Safe to call once; further calls do nothing. */
  start(): void {
    if (this.#started) return;
    this.#started = true;

    const context: BehaviorContext = this.#context;
    for (const { object, behavior } of this.#attachments) {
      behavior.onInit?.(object, context);
    }
  }

  /** Advances every behaviour. `deltaSeconds` is clamped, so a stalled tab cannot teleport actors. */
  update(deltaSeconds: number): void {
    if (!this.#started) return;

    const delta = Math.min(Math.max(deltaSeconds, 0), 0.1);
    this.#context.elapsed += delta;

    const context: BehaviorContext = this.#context;
    for (const { object, behavior } of this.#attachments) {
      behavior.onUpdate?.(object, delta, context);
    }
  }

  emit(event: string, payload?: unknown): void {
    for (const { object, behavior } of this.#attachments) {
      behavior.onEvent?.(object, event, payload);
    }
    for (const listener of this.#listeners.get(event) ?? []) listener(payload);
  }

  /** Subscribes to an event. Returns an unsubscribe function. */
  on(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
    return () => listeners.delete(listener);
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;

    for (const { object, behavior } of this.#attachments) {
      behavior.onDestroy?.(object);
    }
    this.#listeners.clear();
  }
}
