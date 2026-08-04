/**
 * Automatic repair: propose, validate, apply, re-verify, disclose.
 *
 * The safety argument for this package is the same one behaviours make, and it is worth stating in
 * one place. A model proposes into a **closed, typed vocabulary it cannot escape**; the proposal is
 * **parsed by Zod** before a field of it is read; the patch is **narrow** — one spawn point, one
 * collider — so a wrong repair is small; the result is **re-verified by a deterministic play-test**
 * before it is kept; and every attempt, including the rejected ones, is **logged**. At no point
 * does model output become executable code, because no operation in the vocabulary has anywhere to
 * put any.
 *
 * The loop that drives all this lives in `tools/smoke`, because re-verification means building and
 * playing a real export. Everything here is pure and testable without a browser.
 */
export { applyPatch } from './apply.js';
export type { ApplyResult } from './apply.js';
export { extractContext, firstRepairableFailure, isRepairable } from './context.js';
export type { RepairContext, CandidateObject } from './context.js';
export {
  buildRepairPrompt,
  extractJson,
  LlmRepairModel,
  REPAIR_SYSTEM_PROMPT,
  validateProposal,
} from './model.js';
export type { ModelTransport, RepairModel } from './model.js';
export { proposeByRule, RuleBasedRepairModel } from './rules.js';
