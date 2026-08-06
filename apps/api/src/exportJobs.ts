import {
  ARTIFACT_TTL_MS,
  EXPORTS_PER_PERIOD,
  QUOTA_PERIOD_MS,
  quotaMessage,
  type ExportJob,
  type ExportJobStatus,
  type ExportStage,
  type PlanTier,
} from '@helaengine/schema';
import type { Db } from './db.js';
import { Forbidden, NotFound } from './roles.js';

/**
 * Export jobs, in the database.
 *
 * The queue (BullMQ, on Redis) carries the *work*; this table carries the *record*. Two stores for
 * one concept looks redundant until the process restarts: Redis is where a job waits its turn, and
 * a job that only existed there would vanish from the user's history the moment the queue was
 * flushed. So the row is the truth about what was requested and what came of it, and the queue is
 * how it gets picked up.
 *
 * That split is also what makes the quota trustworthy. Counting queued messages would let somebody
 * exhaust their allowance and get it back by waiting for the queue to drain; counting rows does not.
 */

interface JobRow {
  id: string;
  project_id: string;
  organization_id: string;
  scene_version: number;
  status: ExportJobStatus;
  stage: ExportStage;
  progress: number;
  attempts: number;
  error: string | null;
  artifact_path: string | null;
  artifact_bytes: string | number | null;
  expires_at: Date | null;
  correlation_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `id, project_id, organization_id, scene_version, status, stage, progress,
                 attempts, error, artifact_path, artifact_bytes, expires_at, correlation_id,
                 created_at, updated_at`;

function toJob(row: JobRow): ExportJob {
  return {
    id: row.id,
    projectId: row.project_id,
    organizationId: row.organization_id,
    sceneVersion: row.scene_version,
    status: row.status,
    stage: row.stage,
    progress: row.progress,
    attempts: row.attempts,
    error: row.error,
    artifactPath: row.artifact_path,
    // `bigint` comes back from pg as a string, because a JavaScript number cannot hold all of one.
    // An export size fits comfortably, but the conversion has to be deliberate rather than implicit.
    artifactBytes: row.artifact_bytes === null ? null : Number(row.artifact_bytes),
    expiresAt: row.expires_at?.toISOString() ?? null,
    correlationId: row.correlation_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class QuotaExceeded extends Error {
  readonly status = 429;
}

/** How many exports an organisation has started in the current rolling window. */
export async function exportsUsed(db: Db, organizationId: string): Promise<number> {
  const since = new Date(Date.now() - QUOTA_PERIOD_MS);
  const counted = await db.query<{ count: string }>(
    'select count(*)::text as count from export_jobs where organization_id = $1 and created_at >= $2',
    [organizationId, since],
  );
  return Number(counted.rows[0]?.count ?? 0);
}

export async function planTier(db: Db, organizationId: string): Promise<PlanTier> {
  const found = await db.query<{ plan_tier: PlanTier }>(
    'select plan_tier from organizations where id = $1',
    [organizationId],
  );
  const tier = found.rows[0]?.plan_tier;
  if (!tier) throw new NotFound('no such organization');
  return tier;
}

/**
 * Records a requested export, refusing when the organisation is out of allowance.
 *
 * **The lock is the whole point.** The obvious version puts the count in the insert's `where` and
 * looks atomic — one statement, surely one answer. It is not: Postgres reads `READ COMMITTED` by
 * default, so two inserts firing together both take a snapshot showing four used, both find four
 * less than five, and both write. Ten simultaneous requests against a limit of five let six
 * through, which is precisely the "double-click to beat the quota" this was supposed to prevent.
 * A test caught it doing exactly that.
 *
 * `pg_advisory_xact_lock` fixes it by serialising the *check* per organisation: concurrent exports
 * from different customers never wait for each other, and two from the same one queue behind a lock
 * that is released when the transaction ends, however it ends. `SERIALIZABLE` would also work and
 * would need every caller to handle a retry on serialisation failure — real complexity, spread out,
 * for a guard that only ever contends with itself.
 */
export async function createExportJob(
  db: Db,
  input: {
    projectId: string;
    organizationId: string;
    sceneVersion: number;
    userId: string;
    /** The request that asked for this build. Null when the caller carries no telemetry. */
    correlationId?: string | null;
  },
): Promise<ExportJob> {
  const client = await db.connect();

  try {
    await client.query('begin');

    // Transaction-scoped, so it is released by the commit or the rollback rather than by a
    // `finally` somebody might one day forget.
    await client.query('select pg_advisory_xact_lock(hashtext($1)::bigint)', [
      input.organizationId,
    ]);

    /**
     * The tier comes from the subscription now (Sprint 35), inside the same transaction.
     *
     * Same query the guards use, so there is one answer to "what may this organisation do" rather
     * than an export-shaped copy of it. Left join, because no subscription row means the free tier
     * or whatever an operator set by hand — see `loadSubscription`.
     */
    const tierRow = await client.query<{ tier: PlanTier; status: string }>(
      `select coalesce(s.tier, o.plan_tier) as tier,
              coalesce(s.status, case when o.plan_tier = 'free' then 'none' else 'active' end) as status
         from organizations o
         left join subscriptions s on s.organization_id = o.id
        where o.id = $1`,
      [input.organizationId],
    );
    const row = tierRow.rows[0];
    if (!row) throw new NotFound('no such organization');

    const tier = row.status === 'none' ? 'free' : row.tier;
    const limit = EXPORTS_PER_PERIOD[tier];
    const since = new Date(Date.now() - QUOTA_PERIOD_MS);

    const counted = await client.query<{ count: string }>(
      'select count(*)::text as count from export_jobs where organization_id = $1 and created_at >= $2',
      [input.organizationId, since],
    );
    const used = Number(counted.rows[0]!.count);

    if (used >= limit) {
      await client.query('rollback');
      throw new QuotaExceeded(quotaMessage(tier, used));
    }

    const inserted = await client.query<JobRow>(
      `insert into export_jobs
         (project_id, organization_id, scene_version, requested_by, correlation_id)
       values ($1, $2, $3, $4, $5)
       returning ${COLUMNS}`,
      [
        input.projectId,
        input.organizationId,
        input.sceneVersion,
        input.userId,
        input.correlationId ?? null,
      ],
    );

    await client.query('commit');
    return toJob(inserted.rows[0]!);
  } catch (error) {
    // Rolled back unless it already was. A second `rollback` on a finished transaction is a
    // warning rather than an error, which is the cheaper thing to tolerate here.
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function loadExportJob(db: Db, jobId: string): Promise<ExportJob> {
  const found = await db.query<JobRow>(`select ${COLUMNS} from export_jobs where id = $1`, [jobId]);
  const row = found.rows[0];
  if (!row) throw new NotFound('no such export job');
  return toJob(row);
}

/** A project's builds, newest first. */
export async function listExportJobs(db: Db, projectId: string, limit = 20): Promise<ExportJob[]> {
  const found = await db.query<JobRow>(
    `select ${COLUMNS} from export_jobs where project_id = $1 order by created_at desc limit $2`,
    [projectId, limit],
  );
  return found.rows.map(toJob);
}

/**
 * Moves a job along.
 *
 * Called by the worker, which is a different process — so every update is a single statement
 * against the row rather than a read, a mutate and a write. Two workers cannot both have picked up
 * the same job (BullMQ guarantees that), but a *retry* and a stale handler can overlap, and the
 * cheapest way to be right is to never hold state between reading and writing.
 */
export async function updateExportJob(
  db: Db,
  jobId: string,
  patch: {
    status?: ExportJobStatus;
    stage?: ExportStage;
    progress?: number;
    attempts?: number;
    error?: string | null;
    artifactPath?: string | null;
    artifactBytes?: number | null;
    expiresAt?: Date | null;
  },
): Promise<ExportJob> {
  const sets: string[] = ['updated_at = now()'];
  const values: unknown[] = [jobId];

  const push = (column: string, value: unknown): void => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };

  if (patch.status !== undefined) push('status', patch.status);
  if (patch.stage !== undefined) push('stage', patch.stage);
  if (patch.progress !== undefined) push('progress', patch.progress);
  if (patch.attempts !== undefined) push('attempts', patch.attempts);
  if (patch.error !== undefined) push('error', patch.error);
  if (patch.artifactPath !== undefined) push('artifact_path', patch.artifactPath);
  if (patch.artifactBytes !== undefined) push('artifact_bytes', patch.artifactBytes);
  if (patch.expiresAt !== undefined) push('expires_at', patch.expiresAt);

  const updated = await db.query<JobRow>(
    `update export_jobs set ${sets.join(', ')} where id = $1 returning ${COLUMNS}`,
    values,
  );

  const row = updated.rows[0];
  if (!row) throw new NotFound('no such export job');
  return toJob(row);
}

/** Marks a job finished and sets when its artifact stops being downloadable. */
export async function completeExportJob(
  db: Db,
  jobId: string,
  artifact: { path: string; bytes: number },
): Promise<ExportJob> {
  return updateExportJob(db, jobId, {
    status: 'done',
    stage: 'done',
    progress: 100,
    error: null,
    artifactPath: artifact.path,
    artifactBytes: artifact.bytes,
    expiresAt: new Date(Date.now() + ARTIFACT_TTL_MS),
  });
}

/**
 * Whether a job's artifact can still be downloaded.
 *
 * Expiry is checked at download time rather than swept on a timer. A sweep that has not run yet
 * would serve a build that is supposed to be gone, and "the row still has a path" is not the same
 * claim as "this is still available".
 */
export function artifactIsDownloadable(job: ExportJob): boolean {
  if (job.status !== 'done' || !job.artifactPath) return false;
  if (!job.expiresAt) return true;
  return Date.parse(job.expiresAt) > Date.now();
}

/** Refuses a download of something that is gone, with the reason. */
export function requireDownloadable(job: ExportJob): void {
  if (job.status === 'failed') throw new NotFound('that export failed and has nothing to download');
  if (job.status !== 'done') throw new NotFound('that export is not finished yet');
  if (!artifactIsDownloadable(job)) {
    throw new Forbidden('that download link has expired — export the project again');
  }
}

/**
 * Artifacts whose time is up.
 *
 * The Sprint 34 expiry audit found that "builds expire after 24 hours" was only true of the *link*:
 * `artifactIsDownloadable` refuses to serve an expired build, and the zip stayed on disk for ever.
 * That is a storage leak and, more importantly, a false retention claim — a customer told their
 * build is gone would be right to expect it gone.
 *
 * Returns the rows to delete rather than deleting anything itself, because the bytes live wherever
 * the *worker* put them and only the worker knows how to remove them. The row is then cleared of
 * its path, so the history entry survives — somebody can still see that they exported on Tuesday,
 * which is the part worth keeping.
 */
export async function expiredArtifacts(
  db: Db,
  limit = 200,
): Promise<Array<{ id: string; artifactPath: string }>> {
  const found = await db.query<{ id: string; artifact_path: string }>(
    `select id, artifact_path
       from export_jobs
      where artifact_path is not null and expires_at is not null and expires_at < now()
      order by expires_at
      limit $1`,
    [limit],
  );
  return found.rows.map((row) => ({ id: row.id, artifactPath: row.artifact_path }));
}

/** Clears the pointer once the bytes are gone. The job's history entry stays. */
export async function forgetArtifact(db: Db, jobId: string): Promise<void> {
  await db.query(
    `update export_jobs set artifact_path = null, artifact_bytes = null, updated_at = now()
      where id = $1`,
    [jobId],
  );
}
