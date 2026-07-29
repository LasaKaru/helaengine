import { z } from 'zod';
import { BehaviorSchema } from './behavior.js';
import { ObjectPhysicsSchema } from './physics.js';
import { IdSchema, Vec3Schema } from './primitives.js';

/**
 * A named event on the world's bus.
 *
 * Same rule as a behaviour type: an identifier, never an expression. Events are how a trigger
 * reaches the rest of the world, so if a document could smuggle code through this field the
 * closed-vocabulary guarantee would have a hole in it exactly where the wiring is.
 */
export const EventNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'event names are identifiers, not expressions');

/**
 * What a trigger does when it fires.
 *
 * A closed set, for the same reason behaviours are: an exported project must never be able to run
 * something its author did not put in the document. `emit` covers everything that can be expressed
 * as "tell the world something happened"; `spawn` and `destroy` are the two world edits common
 * enough that expressing them as events with bespoke listeners would be busywork.
 */
export const TriggerActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('emit'),
    event: EventNameSchema,
    payload: z.record(z.unknown()).default({}),
  }),
  z.object({
    type: z.literal('spawn'),
    assetId: IdSchema,
    /** Where, relative to the trigger's own position. */
    offset: Vec3Schema.default([0, 0, 0]),
    behaviors: z.array(BehaviorSchema).max(8).default([]),
    physics: ObjectPhysicsSchema,
  }),
  z.object({
    type: z.literal('destroy'),
    targetId: IdSchema,
  }),
]);
export type TriggerAction = z.infer<typeof TriggerActionSchema>;

export const TriggerListenerSchema = z.object({
  event: EventNameSchema,
  actions: z.array(TriggerActionSchema).max(8).default([]),
});
export type TriggerListener = z.infer<typeof TriggerListenerSchema>;

/**
 * A volume that notices things entering and leaving it.
 *
 * The volume's size is the object's own `transform.scale` — a unit box or unit sphere scaled by
 * the gizmo the user already knows. Giving it a second size field would mean two sources of truth
 * for how big the thing is, and a scale gizmo that silently did nothing.
 */
export const TriggerSchema = z.object({
  shape: z.enum(['box', 'sphere']).default('box'),
  /** `player` is the common case; `any` also counts spawned and placed objects. */
  detects: z.enum(['player', 'any']).default('player'),
  /** Fire once and then stay quiet — a spawn point rather than a doorway. */
  once: z.boolean().default(false),
  onEnter: z.array(TriggerActionSchema).max(8).default([]),
  onExit: z.array(TriggerActionSchema).max(8).default([]),
  /** Actions run when a named event reaches the bus, whoever raised it. */
  onEvent: z.array(TriggerListenerSchema).max(8).default([]),
});
export type Trigger = z.infer<typeof TriggerSchema>;
