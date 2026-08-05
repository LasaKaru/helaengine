import { Worker, UnrecoverableError, type Job } from 'bullmq';
import type IORedis from 'ioredis';
import { trace, type Tracer } from '@opentelemetry/api';
import { STAGE_PROGRESS, migrateScene, type Scene } from '@helaengine/schema';
import { EXPORT_QUEUE, type ExportJobPayload } from '@helaengine/api/queue';
import { completeExportJob, updateExportJob } from '@helaengine/api/exportJobs';
import type { Db } from '@helaengine/api/db';
import {
  createLogger,
  inSpan,
  serviceMetrics,
  withCarrier,
  withCorrelation,
  type Logger,
  type ServiceMetrics,
} from '@helaengine/telemetry';
import { buildAndZip, type AssetSource } from './build.js';

/**
 * The export worker.
 *
 * Its own deployable process, and the argument is the same one the co-op server makes: this spends
 * minutes of CPU and hundreds of megabytes of memory on a single job, while the API answers in
 * milliseconds. Sharing a container means a big export makes every request slow, and an API restart
 * throws away work somebody is waiting for.
 *
 *   pnpm --filter @helaengine/export-worker start
 */

export interface ArtifactStorage {
  put(key: string, bytes: Uint8Array): string;
  read(key: string): Uint8Array | null;
}

export interface WorkerOptions {
  db: Db;
  connection: IORedis;
  storage: ArtifactStorage;
  source: AssetSource;
  /** How many jobs at once. One per core is the sane default; see the note below. */
  concurrency?: number;
  /** Traces, metrics and logs. Absent means instrumented but exporting nowhere — see the API. */
  telemetry?: WorkerTelemetry;
}

export interface WorkerTelemetry {
  tracer: Tracer;
  metrics: ServiceMetrics;
  log: Logger;
}

function defaultTelemetry(): WorkerTelemetry {
  return {
    tracer: trace.getTracer('helaengine-export-worker'),
    metrics: serviceMetrics(),
    log: createLogger({ service: 'export-worker', level: 'warn' }),
  };
}

/**
 * Failures that will fail again.
 *
 * A scene that does not validate produces the same error on attempt three as on attempt one, and
 * retrying it wastes two backoff delays before telling the user something they could have heard at
 * once. BullMQ's `UnrecoverableError` is how a handler says "do not bother" — everything else is
 * assumed transient and retried, which is the right default because the failures nobody anticipates
 * are usually the temporary ones.
 */
function permanent(message: string): UnrecoverableError {
  return new UnrecoverableError(message);
}

export function createExportWorker(options: WorkerOptions): Worker<ExportJobPayload> {
  const { db, storage, source } = options;
  const { tracer, metrics, log } = options.telemetry ?? defaultTelemetry();

  return new Worker<ExportJobPayload>(
    EXPORT_QUEUE,
    async (job: Job<ExportJobPayload>) => {
      const { jobId, projectId, sceneVersion, correlationId, carrier } = job.data;
      const startedAt = process.hrtime.bigint();

      /**
       * The seam where a trace crosses a process boundary.
       *
       * `withCarrier` makes everything below a child of the HTTP request that enqueued this job,
       * and `withCorrelation` makes every log line here carry the same id that request did. Both
       * are no-ops when the fields are absent, so a job from an older API still builds — it simply
       * starts a trace of its own.
       */
      const correlated = <T>(body: () => T): T =>
        // Absent rather than `"unknown"`: a log line with no correlation id says truthfully that
        // this job arrived without one, while a placeholder becomes a bucket that every
        // uncorrelated job in the system shares and somebody eventually searches for.
        correlationId ? withCorrelation(correlationId, body) : body();

      return withCarrier(carrier, () =>
        correlated(async () => {
          try {
            const result = await inSpan(
              tracer,
              'export.job',
              {
                'hela.job_id': jobId,
                'hela.project_id': projectId,
                'hela.scene_version': sceneVersion,
                'hela.attempt': job.attemptsMade + 1,
              },
              async (span) => {
                // `attemptsMade` is zero-based on the first run; the row records how many times it
                // has been *tried*, which is what a person reading it expects.
                await updateExportJob(db, jobId, {
                  status: 'processing',
                  stage: 'loading',
                  progress: STAGE_PROGRESS.loading,
                  attempts: job.attemptsMade + 1,
                  error: null,
                });

                const scene = await inSpan(tracer, 'export.load_scene', {}, () =>
                  loadScene(db, projectId, sceneVersion),
                );

                const built = await inSpan(
                  tracer,
                  'export.build',
                  { 'hela.objects': scene.objects.length },
                  async () =>
                    buildAndZip({ scene, projectName: scene.name, source }, async (stage) => {
                      // An event rather than a span per stage: the stages are contiguous phases of
                      // one build, and six spans that exactly tile their parent add depth without
                      // adding information. A timeline of events shows the same shape.
                      span.addEvent(`stage:${stage}`);
                      await updateExportJob(db, jobId, { stage, progress: STAGE_PROGRESS[stage] });
                      // Reported to BullMQ as well, so `queue.getJobs()` and any dashboard see the
                      // same thing the database does rather than a job that looks stuck.
                      await job.updateProgress(STAGE_PROGRESS[stage]);
                    }),
                );

                await updateExportJob(db, jobId, {
                  stage: 'storing',
                  progress: STAGE_PROGRESS.storing,
                });

                const key = `exports/${jobId}.zip`;
                await inSpan(
                  tracer,
                  'export.store',
                  { 'hela.artifact_bytes': built.zip.byteLength },
                  async () => {
                    storage.put(key, built.zip);
                    await completeExportJob(db, jobId, {
                      path: key,
                      bytes: built.zip.byteLength,
                    });
                  },
                );

                span.setAttribute('hela.artifact_bytes', built.zip.byteLength);
                return { bytes: built.zip.byteLength, warnings: built.plan.warnings };
              },
            );

            record(metrics, 'done', startedAt);
            log.info('export built', { jobId, projectId, bytes: result.bytes });
            return result;
          } catch (error) {
            // Counted here rather than in the `failed` handler because this is where the *attempt*
            // ends — a job that succeeds on its third try still cost three builds, and a duration
            // histogram that only sees successes hides the retries that made the queue slow.
            record(metrics, 'failed', startedAt);
            log.error('export failed', { jobId, projectId, error });
            throw error;
          }
        }),
      );
    },
    {
      connection: options.connection,
      /**
       * One at a time by default.
       *
       * An export holds the whole build in memory before it is zipped, so concurrency multiplies
       * peak memory rather than merely sharing CPU. Two large jobs on a small container is how a
       * worker gets killed by the OOM reaper, and a killed worker loses every job it was holding —
       * far worse than a queue that is briefly slow. Scale by running more workers, not by raising
       * this.
       */
      concurrency: options.concurrency ?? 1,
    },
  );
}

function record(metrics: ServiceMetrics, outcome: 'done' | 'failed', startedAt: bigint): void {
  const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
  metrics.jobsProcessed.increment({ outcome });
  metrics.jobDuration.observe(seconds, { outcome });
}

/**
 * The exact version this job was asked to build.
 *
 * By version rather than "latest": a job is a snapshot. Somebody who presses Export and then keeps
 * editing should get the build they asked for, not whatever the project happened to be when a
 * worker got round to it.
 */
async function loadScene(db: Db, projectId: string, version: number): Promise<Scene> {
  const found = await db.query<{ document: unknown }>(
    'select document from scene_versions where project_id = $1 and version = $2',
    [projectId, version],
  );

  const document = found.rows[0]?.document;
  if (document === undefined) {
    // The version is gone, or the project is. Neither improves on a retry.
    throw permanent(`version ${version} of that project no longer exists`);
  }

  try {
    return migrateScene(document);
  } catch (error) {
    throw permanent(
      `that scene could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Records a job's final failure.
 *
 * Attached to the worker's `failed` event rather than done inside the handler, because a handler
 * that throws never reaches its own cleanup — and the distinction that matters here is between a
 * failure with retries left (the user is still waiting, and should still see `processing`) and one
 * that has run out (the user needs to be told, in a sentence).
 */
export function recordFailures(worker: Worker<ExportJobPayload>, db: Db, log?: Logger): void {
  const say = log ?? createLogger({ service: 'export-worker', level: 'warn' });

  worker.on('failed', (job, error) => {
    if (!job) return;

    const attemptsLeft = (job.opts.attempts ?? 1) - job.attemptsMade;
    const willRetry = attemptsLeft > 0 && !(error instanceof UnrecoverableError);

    void updateExportJob(db, job.data.jobId, {
      attempts: job.attemptsMade,
      ...(willRetry
        ? // Still `processing`: from the user's side nothing has gone wrong yet, and showing an
          // error for a job that is about to succeed is worse than showing nothing.
          { status: 'processing' as const, error: null }
        : {
            status: 'failed' as const,
            error: error.message,
          }),
    }).catch((problem: unknown) => {
      // The job failed *and* recording that failed. Logged loudly: the row will sit on
      // `processing` forever, and knowing why is the difference between a bug and a mystery.
      say.error('could not record failure', { jobId: job.data.jobId, error: problem });
    });
  });
}
