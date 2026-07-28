import { z } from 'zod';

/**
 * A behaviour attached to an object.
 *
 * The document names a `type` and carries plain `params`. It never carries code — no expression
 * strings, no callbacks, nothing that gets interpreted. Which `type` values are legal is decided
 * by the engine's behaviour registry at load time, not here, so a document written by a newer
 * build still parses in an older one: the unknown behaviour is reported and skipped rather than
 * making the whole scene unopenable.
 */
export const BehaviorSchema = z.object({
  type: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'behaviour types are identifiers, not expressions'),
  params: z.record(z.unknown()).default({}),
});

export type BehaviorEntry = z.infer<typeof BehaviorSchema>;
