import { z } from 'zod';

/**
 * What a build is checked for before anybody is allowed to have it.
 *
 * A **closed vocabulary**, for the same reason behaviours and trigger actions are one. Sprint 25's
 * auto-repair maps a failed check to a repair strategy, and that mapping has to be exhaustive: a
 * `switch` over this union that forgets an arm is a compile error, whereas a free-form `checkId`
 * string would mean a failure nobody wrote a repair for silently becoming a failure nobody notices.
 *
 * The order here is the order they run in, and it is deliberate — each one is only meaningful if
 * the ones before it passed. There is nothing to say about whether the player can move in a build
 * whose scene never loaded.
 */
export const SmokeCheckIdSchema = z.enum([
  /** The page loaded and threw nothing uncaught. */
  'page-loads',
  /** Every request the page made came back. A 404 on a GLB is a missing model, silently. */
  'assets-resolve',
  /** The engine said the scene was ready, within a timeout. Catches hangs. */
  'scene-loaded',
  /** Rapier's WebAssembly actually initialised. Catches the MIME-type hosting problem. */
  'physics-initialises',
  /** Synthetic input for a few seconds actually moved the player. */
  'player-moves',
  /** Health did not fall while standing still. Catches a damage volume sitting on the spawn. */
  'player-survives-idle',
  /** The heap did not climb without bound over a short window. */
  'memory-stable',
]);
export type SmokeCheckId = z.infer<typeof SmokeCheckIdSchema>;

/**
 * How a check ended.
 *
 * The two non-passing, non-failing outcomes are kept apart on purpose, because collapsing them is
 * how a gate stops being one:
 *
 * - `skipped` — the check could not be run, because something before it failed. Never a soft pass.
 *   A build with a skipped check has not been proved to work, and is not releasable.
 * - `not-applicable` — the check is meaningless for this kind of build, and would be a lie either
 *   way. A static export has no physics to initialise and no player to move; failing it for that
 *   would be failing it for doing exactly what was asked.
 */
export const SmokeCheckStatusSchema = z.enum(['passed', 'failed', 'skipped', 'not-applicable']);
export type SmokeCheckStatus = z.infer<typeof SmokeCheckStatusSchema>;

export const SmokeCheckResultSchema = z.object({
  id: SmokeCheckIdSchema,
  status: SmokeCheckStatusSchema,
  /**
   * One sentence a person can act on.
   *
   * Not a stack trace: Sprint 26 shows this to whoever pressed Export, and "Cannot read properties
   * of undefined (reading 'x')" tells them nothing about their level.
   */
  detail: z.string(),
  /**
   * The machine-readable evidence — measured numbers, failing URLs, error messages.
   *
   * Deliberately loose, because each check knows different things. Sprint 25 reads this to build a
   * repair prompt, so it holds what a fix would need: the spawn position for a fall-through, the
   * failing asset id for a missing reference.
   */
  evidence: z.record(z.unknown()).default({}),
  durationMs: z.number().nonnegative().default(0),
});
export type SmokeCheckResult = z.infer<typeof SmokeCheckResultSchema>;

/** A console error or an unhandled rejection, as the page reported it. */
export const CapturedErrorSchema = z.object({
  message: z.string(),
  source: z.enum(['console', 'pageerror', 'requestfailed']),
  url: z.string().optional(),
});
export type CapturedError = z.infer<typeof CapturedErrorSchema>;

export const SmokeReportSchema = z.object({
  /** The build that was tested — a staging path, never a public one. */
  buildId: z.string(),
  sceneName: z.string(),
  passed: z.boolean(),
  checks: z.array(SmokeCheckResultSchema),
  errors: z.array(CapturedErrorSchema).default([]),
  startedAt: z.string(),
  durationMs: z.number().nonnegative(),
});
export type SmokeReport = z.infer<typeof SmokeReportSchema>;

export function parseSmokeReport(value: unknown): SmokeReport {
  return SmokeReportSchema.parse(value);
}

/**
 * The checks, in the order they must run.
 *
 * Exported as a value rather than left implicit in the runner, because the ordering *is* a rule:
 * a report whose checks are out of order is a report where a skip means something different.
 */
export const SMOKE_CHECK_ORDER: readonly SmokeCheckId[] = SmokeCheckIdSchema.options;

/**
 * Whether a report says the build may be handed to a human.
 *
 * Note what is *not* accepted: a skipped check. A build whose scene never loaded has six checks
 * that could not run, and "nothing failed" is not the same claim as "it works".
 */
export function isReleasable(report: SmokeReport): boolean {
  return (
    report.passed &&
    report.checks.every(
      (check) => check.status === 'passed' || check.status === 'not-applicable',
    ) &&
    report.checks.length === SMOKE_CHECK_ORDER.length
  );
}
