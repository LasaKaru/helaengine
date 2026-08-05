import { z } from 'zod';

/**
 * Exporting as a job somebody waits for, rather than as something the tab does.
 *
 * Sprints 21–23 built the exporter in the browser, and for a small level that is the right place
 * for it: no round trip, no server, works offline. It stops being right at scale for two reasons
 * that are not about speed. A large project is assembled *entirely in tab memory* before the zip is
 * written, and a tab that runs out of memory mid-export gives no useful error at all. And an export
 * that takes ninety seconds is ninety seconds during which closing the tab loses the work.
 *
 * A job fixes both by moving the work somewhere it can be watched: the browser posts, polls, and
 * downloads a link at the end — and closing the tab costs nothing.
 */

/**
 * Where a job is, as a closed vocabulary.
 *
 * Four states and no others. The temptation is a fifth for "retrying", and it is worth resisting:
 * a retry is still `processing` from the outside — the user is still waiting and the job may still
 * succeed — and a state that means "failed but not really" is one every consumer has to learn about
 * to avoid showing an error for a job that is fine.
 */
export const ExportJobStatusSchema = z.enum(['queued', 'processing', 'done', 'failed']);
export type ExportJobStatus = z.infer<typeof ExportJobStatusSchema>;

/** Terminal states, in one place, so nothing polls forever waiting for a job that has finished. */
export const TERMINAL_STATUSES: readonly ExportJobStatus[] = ['done', 'failed'];

export function isTerminal(status: ExportJobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/**
 * What the worker is doing, for a progress bar that means something.
 *
 * Named stages rather than a raw percentage, because a percentage invented from nothing is a lie
 * that users learn to distrust. These are the actual phases of `buildExport`, and each one's share
 * of the bar is a guess *about duration* rather than about what is happening.
 */
export const ExportStageSchema = z.enum([
  'queued',
  'loading',
  'building',
  'compressing',
  'storing',
  'done',
]);
export type ExportStage = z.infer<typeof ExportStageSchema>;

/** Roughly how far through a stage is, for the bar. Ordered, and the last one is 100. */
export const STAGE_PROGRESS: Record<ExportStage, number> = {
  queued: 0,
  loading: 10,
  building: 40,
  compressing: 75,
  storing: 90,
  done: 100,
};

export const ExportJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  organizationId: z.string().min(1),
  /** Which saved version was exported. A job is a snapshot, not a live view of the project. */
  sceneVersion: z.number().int().positive(),
  status: ExportJobStatusSchema,
  stage: ExportStageSchema,
  progress: z.number().int().min(0).max(100),
  /** How many times the worker has picked it up. Retries are transparent to the user. */
  attempts: z.number().int().nonnegative(),
  /** Set on `failed`, and phrased for the person who pressed Export. */
  error: z.string().nullable().default(null),
  /** Set on `done`. The path the download route serves, never a URL the client builds itself. */
  artifactPath: z.string().nullable().default(null),
  artifactBytes: z.number().int().nonnegative().nullable().default(null),
  /** When the artifact stops being downloadable. A finished export is not storage. */
  expiresAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExportJob = z.infer<typeof ExportJobSchema>;

/**
 * How long a finished build stays downloadable.
 *
 * Twenty-four hours, as the plan asks. The point is not thrift — it is that an export is a
 * *derived* artefact. The project is the durable thing, and a build that lives forever is a build
 * somebody eventually links to publicly, at which point deleting it breaks a page. Making it expire
 * from the start means nobody comes to depend on it.
 */
export const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Plan tiers, and what they may do.
 *
 * There is **no billing in this product**. These exist because export is the expensive operation —
 * minutes of CPU and hundreds of megabytes of storage per run — and an endpoint anyone can hammer
 * without limit is an endpoint that decides your infrastructure bill for you. The quota is real and
 * enforced today; which tier an organisation is on is a column somebody sets by hand until there is
 * a checkout to set it.
 */
export const PlanTierSchema = z.enum(['free', 'pro', 'studio', 'enterprise']);
export type PlanTier = z.infer<typeof PlanTierSchema>;

/**
 * Exports allowed per rolling 30 days, by tier.
 *
 * A rolling window rather than a calendar month, because a calendar month means everybody's quota
 * resets at midnight on the first and the queue takes its heaviest load of the month at once.
 */
export const EXPORTS_PER_PERIOD: Record<PlanTier, number> = {
  free: 5,
  pro: 100,
  studio: 500,
  // Not unlimited: an unbounded number is a runaway script nobody notices. High enough that a
  // human never meets it, low enough that a loop does.
  enterprise: 10_000,
};

export const QUOTA_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

/** How many exports a tier has left, given how many it has already used. */
export function remainingExports(tier: PlanTier, used: number): number {
  return Math.max(0, EXPORTS_PER_PERIOD[tier] - used);
}

/**
 * What to tell somebody who has run out.
 *
 * A sentence rather than a status code, and it says what the limit *is* — "you have used your 5"
 * is actionable in a way that "quota exceeded" is not.
 */
export function quotaMessage(tier: PlanTier, used: number): string {
  const limit = EXPORTS_PER_PERIOD[tier];
  return (
    `You have used all ${limit} exports on the ${tier} plan for this 30-day period ` +
    `(${used} used). Exports already built are still downloadable until they expire.`
  );
}

export function parseExportJob(input: unknown): ExportJob {
  return ExportJobSchema.parse(input);
}
