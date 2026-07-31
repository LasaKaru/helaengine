import { z } from 'zod';
import { IdSchema, Vec3Schema } from './primitives.js';

/**
 * What coming back at a checkpoint restores.
 *
 * Per checkpoint rather than per game, because the two ends of a level want different answers: the
 * one before the boss hands your health back, and the one halfway through a scarcity stretch
 * deliberately does not. A single global rule would make one of those two impossible to express.
 */
export const CheckpointResetSchema = z
  .object({
    health: z.enum(['full', 'partial', 'none']).default('full'),
    /** Fraction of maximum health restored when `health` is `partial`. */
    healthFraction: z.number().min(0).max(1).default(0.5),
    /** `full` refills every carried weapon to its clip and reserve ceiling. */
    ammo: z.enum(['full', 'none']).default('none'),
  })
  .default({});
export type CheckpointReset = z.infer<typeof CheckpointResetSchema>;

/** One weapon as it stood when the game was saved. */
export const SavedWeaponSchema = z.object({
  weaponId: IdSchema,
  clip: z.number().int().min(0).max(9999),
  reserve: z.number().int().min(0).max(9999),
});
export type SavedWeapon = z.infer<typeof SavedWeaponSchema>;

/**
 * A player's progress through one scene.
 *
 * Validated on the way *in* as well as out, and that is the point of it being a schema at all:
 * `localStorage` is a text field the player can edit, and an exported game reading it back is
 * reading untrusted input in exactly the sense the rest of this codebase means. A save that fails
 * to parse is discarded and the game starts fresh, which is a worse outcome than resuming and a far
 * better one than a crash on load or a document quietly poisoned by hand-edited JSON.
 *
 * Nothing in here names a file, a URL or a behaviour — a save restores *state*, never structure, so
 * no save can change what a scene contains.
 */
export const SaveStateSchema = z.object({
  version: z.literal(1),
  /** The scene this belongs to. A save from another scene is not applied to this one. */
  sceneId: IdSchema,
  savedAt: z.number().int().nonnegative(),

  /** Object id of the last checkpoint reached, or null for "never reached one". */
  checkpointId: IdSchema.nullable().default(null),
  /** Where to put the player. Stored rather than looked up, so a moved checkpoint is still valid. */
  checkpointPosition: Vec3Schema,

  health: z.number().min(0).max(10_000),
  weapons: z.array(SavedWeaponSchema).max(16).default([]),
  currentWeaponId: IdSchema.nullable().default(null),
  unlockedIds: z.array(IdSchema).max(32).default([]),
  /** Seconds of play, so a timer HUD element survives the reload too. */
  elapsedSeconds: z.number().min(0).default(0),
});
export type SaveState = z.infer<typeof SaveStateSchema>;

export function safeParseSaveState(input: unknown): z.SafeParseReturnType<unknown, SaveState> {
  return SaveStateSchema.safeParse(input);
}
