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
  /**
   * Fetching the Electron runtime for a desktop build.
   *
   * Its own stage, and it has to be: it is a ~90 MB download and by far the longest phase of a
   * desktop export. Folded into `building` the bar would sit still for a minute on a job that is
   * working perfectly, which is exactly how a user learns to distrust a progress bar.
   *
   * A web export never enters it.
   */
  'fetching-runtime',
  /** Wrapping the export in the desktop shell and stamping the executable. Desktop builds only. */
  'packaging',
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
  // The two desktop-only stages sit between building and compressing, so a web export walks
  // 40 → 75 exactly as it always did and a desktop one has somewhere honest to report from.
  'fetching-runtime': 50,
  packaging: 68,
  compressing: 75,
  storing: 90,
  done: 100,
};

/**
 * What an export is *for*: a page to host, or a program to double-click.
 *
 * `web` is the default and is what every job written before this existed means, so nothing about an
 * existing export changes. `desktop` runs the same build and then wraps it — the export goes into
 * the shell unchanged, which is what keeps the two the same game rather than near-relatives.
 */
export const EXPORT_TARGETS = ['web', 'desktop'] as const;
export const ExportTargetSchema = z.enum(EXPORT_TARGETS);
export type ExportTarget = z.infer<typeof ExportTargetSchema>;

/**
 * Platforms a desktop build can be produced for.
 *
 * No macOS, and it is not an oversight. A Mac build has to be signed and notarised by Apple to
 * launch at all on a modern system, which needs an Apple developer account and either a Mac or a
 * paid service in the build path. Offering a `.app` that refuses to open would be worse than not
 * offering one.
 */
export const DESKTOP_PLATFORMS = ['win32-x64', 'win32-arm64', 'linux-x64'] as const;
export const DesktopPlatformSchema = z.enum(DESKTOP_PLATFORMS);
export type DesktopPlatform = z.infer<typeof DesktopPlatformSchema>;

export const DESKTOP_PLATFORM_LABELS: Readonly<Record<DesktopPlatform, string>> = {
  'win32-x64': 'Windows (Intel/AMD)',
  'win32-arm64': 'Windows (ARM)',
  'linux-x64': 'Linux',
};

export const DesktopOptionsSchema = z.object({
  platform: DesktopPlatformSchema.default('win32-x64'),
  /** Becomes the executable's name and its title bar. Defaults to the scene's name at build time. */
  productName: z.string().max(60).default(''),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/, 'Use three numbers, like 1.0.0')
    .default('1.0.0'),
  /** Start full-screen. Off by default: a game that seizes the display on first run is alarming. */
  fullscreen: z.boolean().default(false),
});
export type DesktopOptions = z.infer<typeof DesktopOptionsSchema>;

/**
 * Roughly how large a build will be, in megabytes, before anybody waits for one.
 *
 * Said up front rather than discovered after a five-minute job, because the number is startling and
 * the decision it informs — link or file — is one the author should make knowing it. Almost all of
 * a desktop build is Chromium, so the figure barely moves with the size of the game.
 */
export function estimatedDownloadMb(target: ExportTarget): number {
  return target === 'desktop' ? 111 : 5;
}

export const ExportJobSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  organizationId: z.string().min(1),
  /** Which saved version was exported. A job is a snapshot, not a live view of the project. */
  sceneVersion: z.number().int().positive(),
  status: ExportJobStatusSchema,
  /**
   * Web or desktop. Defaults to `web`, so every job recorded before this existed reads correctly
   * rather than needing a migration.
   */
  target: ExportTargetSchema.default('web'),
  /** Only meaningful when `target` is `desktop`. Null for a web export rather than defaulted. */
  desktop: DesktopOptionsSchema.nullable().default(null),
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
  /**
   * The request that asked for this build (Sprint 33).
   *
   * Surfaced to the client rather than kept server-side, because the moment it earns its keep is
   * when somebody is looking at a failed export and wants to say what went wrong. "Reference
   * hela_9f3c…" turns a support thread into one query. Null for jobs made before this existed.
   */
  correlationId: z.string().nullable().default(null),
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

/**
 * What an author should know before waiting for a desktop build.
 *
 * Warnings rather than errors: none of these stops a build, and all of them are things people
 * discover afterwards and are annoyed by. Windows in particular will refuse to run the result
 * without a click-through, and finding that out from a player is much worse than from this list.
 */
export function desktopWarnings(options: DesktopOptions): string[] {
  const warnings: string[] = [];

  if (options.platform.startsWith('win32')) {
    warnings.push(
      'Windows will show "Windows protected your PC" the first time a player runs this. The ' +
        'build is unsigned, and there is no free way round it — stopping the warning needs a ' +
        'paid code-signing certificate. Players click More info, then Run anyway.',
    );
  }

  warnings.push(
    `About ${estimatedDownloadMb('desktop')} MB zipped, against ` +
      `${estimatedDownloadMb('web')} MB for the web export. Almost all of it is the browser ` +
      'engine, so the figure hardly changes with the size of the game.',
  );

  if (options.fullscreen) {
    warnings.push(
      'This build starts full-screen. Players who have not been warned tend to read that as the ' +
        'game having crashed their machine.',
    );
  }

  return warnings;
}
