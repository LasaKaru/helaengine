import { z } from 'zod';
import { BehaviorSchema } from './behavior.js';
import { ObjectAnimationSchema } from './animation.js';
import { MaterialOverrideSchema } from './rendering.js';
import { ObjectPhysicsSchema } from './physics.js';
import { OptionalDestructibleSchema } from './destructible.js';
import { OptionalVehicleSchema } from './vehicle.js';
import { OptionalRagdollSchema } from './ragdoll.js';
import { TriggerSchema } from './trigger.js';
import { IdSchema, TransformSchema } from './primitives.js';
import { SwayOverrideSchema } from './wind.js';

/**
 * A placed instance in the world.
 *
 * `assetId` points at an asset manifest entry, never a file path — that indirection is what lets
 * assets be re-versioned, recompressed or relocated without rewriting every saved scene.
 */
export const SceneObjectSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  /**
   * Parent object id, or null for a root object.
   *
   * A nested object's `transform` is expressed in its parent's space, exactly as in a Three.js
   * scene graph — moving a building carries its attached props along.
   */
  parentId: IdSchema.nullable().default(null),
  transform: TransformSchema.default({}),
  /** Gameplay attached to this object, in the order it should be applied. */
  behaviors: z.array(BehaviorSchema).max(32).default([]),
  /** How this instance collides. Defaults defer to the asset manifest, so most objects say nothing. */
  physics: ObjectPhysicsSchema,
  /**
   * How this object's rig is animated, or null for anything that is not rigged.
   *
   * Null by default and null for almost everything: a rock has no skeleton, and a field that every
   * object had to carry would be noise in every document. It is also what makes this addition
   * invisible to every scene saved before it existed.
   */
  animation: ObjectAnimationSchema.nullable().default(null),
  /**
   * Whether the wind moves this object, and as what.
   *
   * `auto` asks the rule in `wind.ts`, which reads the asset id — and which will be wrong
   * sometimes, because it is a rule over names. This field is how that is fixed: a potted plant
   * indoors takes `none`, an imported model the rule has never heard of takes a group by name.
   * Every document written before wind existed says `auto`, and `auto` with no wind is no sway.
   */
  sway: SwayOverrideSchema.default('auto'),
  /**
   * Overrides for this instance's material, or null to use whatever the model shipped with.
   *
   * Per instance rather than per asset, which is the point: one crate painted red should not
   * repaint every other crate placed from the same asset. It also means an override costs a
   * material clone, so null — the overwhelming majority — costs nothing.
   */
  material: MaterialOverrideSchema.nullable().default(null),
  /**
   * What happens when this object takes enough damage, or null for something that does not break.
   *
   * Null by default and null for almost everything, which is what makes it invisible to every scene
   * saved before it existed: no destructible is no listener, no hit points and no debris.
   */
  destructible: OptionalDestructibleSchema,
  /**
   * Turns this object into something the player can drive, or null for everything else.
   *
   * Null by default, so it is invisible to every scene saved before it existed: no vehicle is no
   * controller, no wheels and no seat.
   */
  vehicle: OptionalVehicleSchema,
  /**
   * How this character's skeleton behaves once physics takes it over, or null for anything that
   * does not go limp — which is everything without a rig, and most things with one.
   */
  ragdoll: OptionalRagdollSchema,
  /**
   * Turns this object into a trigger volume: it stops being something you look at and becomes
   * something that notices. Null for the overwhelming majority of objects.
   */
  trigger: TriggerSchema.nullable().default(null),
  metadata: z
    .object({
      label: z.string().max(200).optional(),
      layer: z.string().max(64).optional(),
    })
    .default({}),
});
export type SceneObject = z.infer<typeof SceneObjectSchema>;
