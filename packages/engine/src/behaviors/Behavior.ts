import type * as THREE from 'three';
import type { z } from 'zod';

/**
 * The runtime handle a behaviour is given for the object it is attached to.
 *
 * Deliberately narrow: a behaviour can move its object, read the clock, look up siblings and
 * raise events. It cannot reach the DOM, the editor, or the store — because the same instance
 * runs inside an exported project where none of those exist.
 */
export interface GameObject {
  readonly id: string;
  readonly assetId: string;
  /** The object's node in the scene graph. Transforms applied here are what the player sees. */
  readonly node: THREE.Object3D;
  /** Sibling lookup by scene-document id. */
  find(objectId: string): GameObject | undefined;
  /** Raises a named event on the world's event bus. */
  emit(event: string, payload?: unknown): void;
}

export interface BehaviorContext {
  /** Seconds since the runtime started. */
  readonly elapsed: number;
}

/**
 * A unit of gameplay.
 *
 * Every hook is optional so a behaviour only implements what it needs. Instances are created by a
 * `BehaviorDefinition.create`, never by name lookup and never from a string — see the note on
 * `BehaviorDefinition` for why that matters.
 */
export interface Behavior {
  onInit?(object: GameObject, context: BehaviorContext): void;
  onUpdate?(object: GameObject, deltaSeconds: number, context: BehaviorContext): void;
  onEvent?(object: GameObject, event: string, payload: unknown): void;
  onDestroy?(object: GameObject): void;
}

/**
 * How a behaviour type is registered.
 *
 * `params` is a Zod schema, and it is the whole safety story for export. Behaviours are a closed
 * vocabulary: a scene document can only ask for a registered `type` with params that satisfy that
 * type's schema. Nothing in a document is ever interpreted as code — no `eval`, no `new Function`,
 * no string that becomes a callback — so an exported project cannot be made to run something its
 * author did not put there. Sprint 22 re-verifies this by grepping for dynamic execution.
 *
 * The schema doubles as the editor's form description: the inspector reads it to render fields,
 * so adding a behaviour does not mean hand-writing UI for it.
 */
export interface BehaviorDefinition<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  type: string;
  /** Shown in the editor's "Add behaviour" list. */
  label: string;
  description: string;
  /**
   * Generic over the schema rather than over the params type, so `create` receives exactly what
   * the schema produces — including every field the schema fills in by default.
   */
  params: TSchema;
  create(params: z.infer<TSchema>): Behavior;
}
