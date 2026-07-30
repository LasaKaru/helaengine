import { z } from 'zod';
import { PickupKindSchema } from './inventory.js';
import { IdSchema, Vec3Schema } from './primitives.js';
import { EventNameSchema } from './trigger.js';

/**
 * The buttons a secret sequence can be made of.
 *
 * A named vocabulary rather than raw `KeyboardEvent.code` values, because a secret has to be
 * enterable on a gamepad as well as a keyboard, and "the B button" is the same intent whether it
 * arrived as `KeyB` or as standard-mapping button 1. It also keeps the editor's picker a list of
 * ten readable things instead of a free-text field where a typo produces a secret nobody can enter.
 */
export const UnlockKeySchema = z.enum([
  'Up',
  'Down',
  'Left',
  'Right',
  'A',
  'B',
  'X',
  'Y',
  'Start',
]);
export type UnlockKey = z.infer<typeof UnlockKeySchema>;

/**
 * How a secret is discovered.
 *
 * A discriminated union, and that union *is* the closed vocabulary — the same guarantee behaviours
 * get from their registry, obtained here at both ends at once: Zod rejects a `type` it has never
 * heard of when the document is parsed, and TypeScript refuses to compile a runtime that does not
 * handle every arm. There is no path from a document to arbitrary work, which is the whole reason
 * an exported project is safe to hand to somebody else.
 */
export const UnlockMethodSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('inputSequence'),
    sequence: z.array(UnlockKeySchema).min(2).max(24),
    /**
     * Seconds allowed between one key and the next before the attempt lapses.
     *
     * Without a window, a sequence entered over the course of an hour of ordinary play counts —
     * which means a long enough game unlocks every keyboard secret by accident.
     */
    withinSeconds: z.number().min(0.2).max(30).default(2),
  }),
  z.object({
    type: z.literal('triggerVolume'),
    /** Object id of the trigger volume. Entering it is the secret. */
    triggerId: IdSchema,
  }),
  z.object({
    type: z.literal('event'),
    /** Any event on the bus — what makes this composable with behaviours and trigger actions. */
    event: EventNameSchema,
  }),
  z.object({
    type: z.literal('itemCount'),
    kind: PickupKindSchema,
    /** How many of that kind of pickup have to be collected. */
    count: z.number().int().min(1).max(999).default(5),
  }),
]);
export type UnlockMethod = z.infer<typeof UnlockMethodSchema>;

/** What discovering a secret does. Closed for the same reason, and by the same mechanism. */
export const UnlockActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('teleportPlayer'), target: Vec3Schema }),
  z.object({ type: z.literal('unlockInventoryItem'), weaponId: IdSchema }),
  z.object({
    type: z.literal('revealArea'),
    /**
     * Objects that appear.
     *
     * They start hidden precisely *because* something reveals them — the runtime hides everything
     * named here at startup rather than making the author remember a second "hidden" flag that
     * could disagree with this list.
     */
    objectIds: z.array(IdSchema).min(1).max(64),
  }),
  z.object({
    type: z.literal('emit'),
    event: EventNameSchema,
    payload: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
  }),
]);
export type UnlockAction = z.infer<typeof UnlockActionSchema>;

export const UnlockableSchema = z.object({
  id: IdSchema,
  /** Shown in the editor, and in the notice the HUD shows when it fires. */
  label: z.string().min(1).max(80).default('Secret'),
  unlockMethod: UnlockMethodSchema,
  actions: z.array(UnlockActionSchema).min(1).max(8),
  /** Fire once and stay unlocked, or re-arm every time. Almost always once. */
  once: z.boolean().default(true),
});
export type Unlockable = z.infer<typeof UnlockableSchema>;

export const UnlockablesSchema = z
  .array(UnlockableSchema)
  .max(32)
  .default([])
  .superRefine((unlockables, ctx) => {
    const seen = new Set<string>();
    for (const [index, unlockable] of unlockables.entries()) {
      if (seen.has(unlockable.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `duplicate unlockable id "${unlockable.id}"`,
        });
      }
      seen.add(unlockable.id);
    }
  });
