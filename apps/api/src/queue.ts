import { Queue } from 'bullmq';
import IORedis from 'ioredis';

/**
 * The export queue.
 *
 * BullMQ on Redis, as the plan asks, and this is the first sprint where the named product is
 * actually present rather than substituted for. It earns its place: the API and the worker are
 * separate processes that must not share memory, jobs have to survive a restart of either, and
 * retry-with-backoff is exactly the thing that is tedious to write and easy to get subtly wrong.
 *
 * What is deliberately *not* in Redis is the job's history. See `exportJobs.ts`: the row is the
 * record, the queue is the delivery. A queue flush should lose pending work, not the user's list of
 * what they have exported.
 */

export const EXPORT_QUEUE = 'helaengine-export';

export interface ExportJobPayload {
  /** The database row this message is about. Everything else is looked up from it. */
  jobId: string;
  projectId: string;
  organizationId: string;
  sceneVersion: number;
  /**
   * Diagnostics that have to cross the queue, because a queue has no headers (Sprint 33).
   *
   * Both are optional and neither affects what gets built. A message enqueued before this sprint,
   * or by anything that does not carry telemetry, still exports correctly — it simply starts its
   * own trace instead of continuing the request's.
   */
  correlationId?: string | null;
  /** A W3C `traceparent` carrier, injected by the API and extracted by the worker. */
  carrier?: Record<string, string>;
}

/**
 * Connects to Redis.
 *
 * `maxRetriesPerRequest: null` is required by BullMQ rather than chosen: its blocking commands sit
 * on a connection for long stretches, and ioredis's default would abandon them as timed out.
 */
export function createRedis(url?: string): IORedis {
  return new IORedis(url ?? process.env['REDIS_URL'] ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
  });
}

/**
 * Retry policy.
 *
 * Three attempts with exponential backoff. The failures worth retrying are transient — a storage
 * write that timed out, a database blip — and they clear in seconds. The failures not worth
 * retrying are a scene that does not validate or an asset that is missing, which will fail
 * identically three times and then tell the user something they could have been told at once.
 *
 * That is the argument for *three* rather than more: a permanent failure costs the user three times
 * as long to hear about, and beyond a handful of attempts the wait stops being invisible.
 */
export const JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2_000 },
  // Kept briefly after success so a worker crash mid-completion is diagnosable, then dropped —
  // the database row is the durable record and Redis is not where history lives.
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 24 * 3_600 },
};

export function createExportQueue(connection: IORedis): Queue<ExportJobPayload> {
  return new Queue<ExportJobPayload>(EXPORT_QUEUE, { connection });
}

export type ExportQueue = Queue<ExportJobPayload>;
