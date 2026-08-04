import { z } from 'zod';
import { Vec3Schema } from './primitives.js';
import { ColliderChoiceSchema } from './physics.js';
import { SmokeCheckIdSchema } from './smoke.js';

/**
 * What an automatic repair is allowed to do to somebody's scene.
 *
 * This is the most safety-critical vocabulary in the product, because it is the one a *model*
 * writes into. The discipline is the same one behaviours, trigger actions and unlock methods
 * follow, and it is not a convention here — it is the entire security argument:
 *
 * - Every patch is **data**, describing a field to set on a document. There is no operation that
 *   carries code, an expression, a path to evaluate, or a name to look up in a registry. There is
 *   nothing a model can put in one of these that ever reaches `eval`, `new Function`, or a
 *   dynamic import, because no arm of this union has anywhere to put it.
 * - The union is **closed**. A proposal naming an operation that is not here fails to parse, and
 *   the loop discards it. Adding an operation is a schema change, a code change and a test — not
 *   something a sufficiently persuasive model response can accomplish.
 * - Every patch is **narrow**. There is deliberately no "replace the scene", no "set this JSON
 *   path", no "merge this object". A repair moves a spawn point or clears one collider; it cannot
 *   rewrite a level, so the worst case of a wrong repair is a wrong spawn point.
 *
 * The model is a *proposer*. It never applies anything, never executes anything, and its output is
 * parsed before a single field is read.
 */
export const RepairPatchSchema = z.discriminatedUnion('op', [
  z.object({
    /** Move where the player starts. The fix for stuck, buried and off-the-map spawns. */
    op: z.literal('setPlayerSpawn'),
    spawn: Vec3Schema,
  }),
  z.object({
    /** Move one placed object. The fix for a prop sitting where the player has to stand. */
    op: z.literal('setObjectPosition'),
    objectId: z.string().min(1),
    position: Vec3Schema,
  }),
  z.object({
    /**
     * Change one object's collider, including to `none`.
     *
     * The fix for a marker or a decoration that was never meant to be solid — the fence used as a
     * checkpoint post in Sprint 18 was exactly this bug, found by hand.
     */
    op: z.literal('setObjectCollider'),
    objectId: z.string().min(1),
    collider: ColliderChoiceSchema,
  }),
  z.object({
    /** Take the trigger volume off an object, leaving the object itself alone. */
    op: z.literal('clearObjectTrigger'),
    objectId: z.string().min(1),
  }),
  z.object({
    /**
     * Remove one object entirely.
     *
     * The last resort, and listed last on purpose. It is the only patch that destroys something a
     * person made, so a proposer should reach for it only when nothing smaller will do, and the
     * disclosure Sprint 26 shows has to say so in those words.
     */
    op: z.literal('removeObject'),
    objectId: z.string().min(1),
  }),
]);
export type RepairPatch = z.infer<typeof RepairPatchSchema>;

/** Every operation name, for exhaustiveness checks and for prompting. */
export const REPAIR_OPS = RepairPatchSchema.options.map(
  (option) => option.shape.op.value,
) as ReadonlyArray<RepairPatch['op']>;

/**
 * What a proposer hands back.
 *
 * The reason is not decoration: Sprint 26 shows it to the person whose scene was changed, in place
 * of the change itself. "We moved your spawn point up 1.2 m so the player would not fall through
 * the terrain" is a sentence somebody can agree or disagree with; a JSON diff is not.
 */
export const RepairProposalSchema = z.object({
  patch: RepairPatchSchema,
  /** One sentence, addressed to the author of the scene. */
  reason: z.string().min(1).max(400),
  /** Which failed check this is meant to fix. */
  fixes: SmokeCheckIdSchema,
});
export type RepairProposal = z.infer<typeof RepairProposalSchema>;

/** Why an attempt ended where it did. */
export const RepairOutcomeSchema = z.enum([
  /** The patch was applied and the build passed afterwards. */
  'repaired',
  /** The patch was applied, the build was re-tested, and it still failed. */
  'still-failing',
  /** The proposer had nothing to suggest for this failure. */
  'no-proposal',
  /** The proposal did not parse, or named an object that is not in the scene. */
  'rejected',
  /** The patch parsed but produced a document the scene schema refuses. */
  'invalid-result',
]);
export type RepairOutcome = z.infer<typeof RepairOutcomeSchema>;

/**
 * One turn of the loop, recorded whether it worked or not.
 *
 * The rejected attempts are the important ones. An audit trail that only lists successful edits
 * cannot answer "did the model try to do something it should not have been able to do", which is
 * the question anybody evaluating this feature will ask first.
 */
export const RepairAttemptSchema = z.object({
  attempt: z.number().int().min(1),
  /** The check that was failing when this attempt began. */
  failing: SmokeCheckIdSchema,
  outcome: RepairOutcomeSchema,
  /** Absent when the proposal was rejected or never made. */
  proposal: RepairProposalSchema.optional(),
  /** Why it was rejected, when it was. */
  rejection: z.string().optional(),
  /** Names the proposer, so a log says who suggested what. */
  proposedBy: z.string(),
});
export type RepairAttempt = z.infer<typeof RepairAttemptSchema>;

export const RepairLogSchema = z.object({
  buildId: z.string(),
  attempts: z.array(RepairAttemptSchema),
  /** True when the build passed the harness at the end, repaired or not. */
  releasable: z.boolean(),
  /** The patches that were actually applied and kept, in order. */
  applied: z.array(RepairProposalSchema),
});
export type RepairLog = z.infer<typeof RepairLogSchema>;

export function parseRepairProposal(value: unknown): RepairProposal {
  return RepairProposalSchema.parse(value);
}

/**
 * The disclosure Sprint 26 will show, built from the log rather than written twice.
 *
 * Silence about an automatic edit is the thing to avoid here: a tool that quietly rewrites what
 * somebody built and then congratulates them on it has spent trust it cannot earn back.
 */
export function describeRepairs(log: RepairLog): string[] {
  return log.applied.map((proposal) => proposal.reason);
}
