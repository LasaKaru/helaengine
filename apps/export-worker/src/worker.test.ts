import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import type { Worker } from 'bullmq';
import type IORedis from 'ioredis';
import {
  CURRENT_SCENE_VERSION,
  SceneSchema,
  type AssetManifest,
  type Scene,
} from '@helaengine/schema';
import { createPool, migrate, reset, type Db } from '@helaengine/api/db';
import {
  createExportQueue,
  createRedis,
  JOB_OPTIONS,
  type ExportQueue,
} from '@helaengine/api/queue';
import { loadExportJob } from '@helaengine/api/exportJobs';
import {
  createLogger,
  inSpan,
  serviceMetrics,
  startTelemetry,
  traceCarrier,
  withCorrelation,
  type SpanRecord,
} from '@helaengine/telemetry';
import { createExportWorker, recordFailures, type ArtifactStorage } from './worker.js';
import type { AssetSource } from './build.js';
import type { ExportJobPayload } from '@helaengine/api/queue';

/**
 * Sprint 32 — the export pipeline, against a real queue and a real database.
 *
 * BullMQ on Redis, Postgres underneath, and the actual `packages/export` bundler in the middle. A
 * mocked queue would test the mock: the interesting behaviour here *is* the queue's — retry with
 * backoff, an unrecoverable error skipping the remaining attempts, several jobs landing at once and
 * being taken one at a time.
 */

/**
 * Its **own** database, not the API's.
 *
 * Both suites call `reset()` — drop the schema, re-migrate — and turbo runs packages in parallel,
 * so sharing one database means each suite periodically deletes the other's tables mid-test. The
 * failures that produces look like race conditions in the code under test and are nothing of the
 * kind, which is the worst sort of red build.
 */
const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://hela@localhost:5433/helaengine_worker_test';
const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';

let db: Db;
let connection: IORedis;
let queue: ExportQueue;
/**
 * Every worker a test started.
 *
 * Closed between tests rather than at the end: a worker left running stays subscribed to the same
 * queue, so the *next* test's jobs get shared out between it and the new one — and since each test
 * has its own storage, half the artifacts land somewhere nothing is looking. That produced "8 jobs
 * done, 2 artifacts stored", which reads like a worker bug and is entirely a harness one.
 */
const workers: Array<Worker<ExportJobPayload>> = [];
let artifactRoot: string;

/** Bytes that start the way a binary glTF starts, so the bundler has something real to copy. */
function glb(): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set(Buffer.from('glTF', 'ascii'), 0);
  return bytes;
}

const manifest: AssetManifest = {
  version: 1,
  assets: [
    {
      id: 'tree_pine_01',
      name: 'Pine',
      category: 'trees',
      tags: [],
      glbPath: 'models/tree_pine_01.glb',
      defaultScale: [1, 1, 1],
      colliderType: 'box',
      bounds: [1, 1, 1],
      origin: 'first-party' as const,
    placeholderColor: '#2d5a34',
    },
  ],
};

/** An asset library in memory, so these tests are about the pipeline rather than about the disk. */
const source: AssetSource = {
  manifest,
  readAsset: async () => glb(),
  runtimeSource: async () => '/* engine bundle */ export const runtime = 1;',
};

class MemoryStorage implements ArtifactStorage {
  readonly files = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): string {
    this.files.set(key, bytes);
    return key;
  }

  read(key: string): Uint8Array | null {
    return this.files.get(key) ?? null;
  }
}

let storage: MemoryStorage;

/**
 * Real tracing, writing to a real file (Sprint 33).
 *
 * Not a mock tracer: the thing worth checking is that a span made in *this* process joins a trace
 * started in another one, and a fake that records calls would confirm the calls rather than the
 * join. The file is what `tools/trace` reads, so these tests read exactly what an operator does.
 */
let tracePath: string;
let telemetry: ReturnType<typeof startTelemetry>;
const metrics = serviceMetrics();

beforeAll(async () => {
  db = createPool(DATABASE_URL);
  await reset(db);
  await migrate(db);

  connection = createRedis(REDIS_URL);
  queue = createExportQueue(connection);
  artifactRoot = mkdtempSync(join(tmpdir(), 'hela-exports-test-'));
  tracePath = join(artifactRoot, 'spans.ndjson');
  telemetry = startTelemetry({ serviceName: 'helaengine-export-worker', tracePath });
}, 60_000);

afterAll(async () => {
  await closeWorkers();
  await queue.close();
  await connection.quit();
  await db.end();
  rmSync(artifactRoot, { recursive: true, force: true });
});

async function closeWorkers(): Promise<void> {
  await Promise.all(workers.splice(0).map((each) => each.close()));
}

beforeEach(async () => {
  await closeWorkers();
  await db.query(
    'truncate sessions, invites, export_jobs, scene_versions, projects, memberships, organizations, users cascade',
  );
  // Obliterated rather than drained: a job left over from a previous test would be picked up by
  // this one's worker and fail against a database row that no longer exists.
  await queue.obliterate({ force: true });
  storage = new MemoryStorage();
});

function scene(name = 'Exportable Level'): Scene {
  return SceneSchema.parse({
    sceneId: 'scene_export',
    version: CURRENT_SCENE_VERSION,
    name,
    objects: [{ id: 'obj_0001', assetId: 'tree_pine_01', transform: { position: [1, 0, 2] } }],
  });
}

/** A user, an organisation, a project and a saved version — the minimum an export needs. */
async function project(options: { tier?: string; scene?: Scene } = {}): Promise<{
  projectId: string;
  organizationId: string;
  userId: string;
}> {
  const user = await db.query<{ id: string }>(
    `insert into users (email, display_name, password_hash) values ($1, 'Tester', 'x') returning id`,
    [`export-${Math.random().toString(36).slice(2)}@example.com`],
  );
  const userId = user.rows[0]!.id;

  const org = await db.query<{ id: string }>(
    `insert into organizations (name, plan_tier) values ('Test Org', $1) returning id`,
    [options.tier ?? 'pro'],
  );
  const organizationId = org.rows[0]!.id;

  await db.query(
    `insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')`,
    [organizationId, userId],
  );

  const created = await db.query<{ id: string }>(
    `insert into projects (organization_id, name, created_by) values ($1, 'Exportable', $2) returning id`,
    [organizationId, userId],
  );
  const projectId = created.rows[0]!.id;

  await db.query(
    `insert into scene_versions (project_id, version, document, created_by) values ($1, 1, $2::jsonb, $3)`,
    [projectId, JSON.stringify(options.scene ?? scene()), userId],
  );

  return { projectId, organizationId, userId };
}

async function enqueue(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  sceneVersion?: number;
  correlationId?: string;
  carrier?: Record<string, string>;
}): Promise<string> {
  const row = await db.query<{ id: string }>(
    `insert into export_jobs (project_id, organization_id, scene_version, requested_by, correlation_id)
     values ($1, $2, $3, $4, $5) returning id`,
    [
      input.projectId,
      input.organizationId,
      input.sceneVersion ?? 1,
      input.userId,
      input.correlationId ?? null,
    ],
  );
  const jobId = row.rows[0]!.id;

  await queue.add(
    'export',
    {
      jobId,
      projectId: input.projectId,
      organizationId: input.organizationId,
      sceneVersion: input.sceneVersion ?? 1,
      ...(input.correlationId ? { correlationId: input.correlationId } : {}),
      ...(input.carrier ? { carrier: input.carrier } : {}),
    },
    JOB_OPTIONS,
  );

  return jobId;
}

/** The spans this worker has written so far, as `tools/trace` would read them. */
function spans(): SpanRecord[] {
  if (!existsSync(tracePath)) return [];
  return readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as SpanRecord);
}

/**
 * A logger that keeps its lines.
 *
 * Silent on the console because several of these tests fail jobs on purpose, and a stack trace per
 * deliberate failure buries the one that is not deliberate. Kept rather than discarded so the tests
 * below can assert on what the worker said — a log line nobody ever checks is a log line that
 * quietly stops being written.
 */
const logged: string[] = [];
const quiet = createLogger({
  service: 'export-worker',
  level: 'debug',
  write: (line) => logged.push(line),
});

function start(
  overrides: Partial<Parameters<typeof createExportWorker>[0]> = {},
): Worker<ExportJobPayload> {
  const started = createExportWorker({
    db,
    connection: createRedis(REDIS_URL),
    storage,
    source,
    concurrency: 1,
    telemetry: { tracer: telemetry.tracer, metrics, log: quiet },
    ...overrides,
  });
  recordFailures(started, db, quiet);
  workers.push(started);
  return started;
}

/** Polls the row until it reaches a terminal state, so a test waits on the outcome not a sleep. */
async function settle(
  jobId: string,
  timeoutMs = 30_000,
): Promise<Awaited<ReturnType<typeof loadExportJob>>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await loadExportJob(db, jobId);
    if (job.status === 'done' || job.status === 'failed') return job;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`job ${jobId} never finished`);
}

describe('building an export', () => {
  it('produces a zip somebody could unzip and serve', async () => {
    const { projectId, organizationId, userId } = await project();
    const jobId = await enqueue({ projectId, organizationId, userId });

    start();
    const job = await settle(jobId);

    expect(job.status).toBe('done');
    expect(job.stage).toBe('done');
    expect(job.progress).toBe(100);
    expect(job.artifactBytes).toBeGreaterThan(0);
    expect(job.expiresAt).not.toBeNull();

    const bytes = storage.read(job.artifactPath!);
    expect(bytes).not.toBeNull();

    // Unzipped and inspected, because "it produced a file" is not the claim — the claim is that the
    // file is a playable build.
    const zip = await JSZip.loadAsync(bytes!);
    const names = Object.keys(zip.files);
    expect(names.some((name) => name.endsWith('/index.html'))).toBe(true);
    expect(names.some((name) => name.endsWith('/main.js'))).toBe(true);
    expect(names.some((name) => name.endsWith('/scene.json'))).toBe(true);
    expect(names.some((name) => name.endsWith('/engine/runtime.js'))).toBe(true);
    // The asset the scene actually places, carried in.
    expect(names.some((name) => name.includes('assets/models/tree_pine_01.glb'))).toBe(true);

    // Everything under one folder, so unzipping does not scatter files across a downloads directory.
    const roots = new Set(names.map((name) => name.split('/')[0]));
    expect(roots.size).toBe(1);

    const sceneJson = await zip
      .file(names.find((n) => n.endsWith('/scene.json'))!)!
      .async('string');
    expect(JSON.parse(sceneJson).name).toBe('Exportable Level');
  }, 60_000);

  it('reports the stages it goes through, rather than jumping to done', async () => {
    const { projectId, organizationId, userId } = await project();
    const jobId = await enqueue({ projectId, organizationId, userId });

    const seen = new Set<string>();
    // Polled tightly while it runs: the progress bar is the whole reason a job exists rather than a
    // synchronous request, so "it moved through stages" is a claim worth checking.
    const watching = (async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const job = await loadExportJob(db, jobId);
        seen.add(job.stage);
        if (job.status === 'done' || job.status === 'failed') return;
        await new Promise((done) => setTimeout(done, 15));
      }
    })();

    start();
    await settle(jobId);
    await watching;

    expect(seen.has('done')).toBe(true);
    // At least one intermediate stage was observed. Which one is a race — the point is that the row
    // is written as the work proceeds rather than only at the end.
    expect([...seen].some((stage) => stage !== 'queued' && stage !== 'done')).toBe(true);
  }, 60_000);
});

describe('failing', () => {
  it('gives up immediately on a scene that will never build', async () => {
    const { projectId, organizationId, userId } = await project();
    // A version that does not exist. Retrying cannot help, and BullMQ is told so.
    const jobId = await enqueue({ projectId, organizationId, userId, sceneVersion: 99 });

    start();
    const job = await settle(jobId);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/no longer exists/);
    // One attempt, not three: an unrecoverable failure that burned two backoff delays would make
    // the user wait seconds to hear something they could have been told at once.
    expect(job.attempts).toBe(1);
  }, 60_000);

  it('retries a transient failure and succeeds', async () => {
    const { projectId, organizationId, userId } = await project();
    const jobId = await enqueue({ projectId, organizationId, userId });

    let attempts = 0;
    // Fails once with an ordinary error — the kind a storage blip produces — then works.
    const flaky: AssetSource = {
      ...source,
      runtimeSource: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('storage timed out');
        return '/* engine bundle */';
      },
    };

    start({ source: flaky });
    const job = await settle(jobId, 45_000);

    expect(attempts).toBeGreaterThan(1);
    expect(job.status).toBe('done');
    // The user was never shown an error: a job with retries left is still `processing` from
    // outside, because it may still succeed.
    expect(job.error).toBeNull();
  }, 90_000);

  it('records a permanent failure after its attempts run out', async () => {
    const { projectId, organizationId, userId } = await project();
    const jobId = await enqueue({ projectId, organizationId, userId });

    const broken: AssetSource = {
      ...source,
      runtimeSource: async () => {
        throw new Error('the engine bundle is missing');
      },
    };

    start({ source: broken });
    const job = await settle(jobId, 60_000);

    expect(job.status).toBe('failed');
    expect(job.error).toMatch(/engine bundle is missing/);
    expect(job.attempts).toBe(JOB_OPTIONS.attempts);
  }, 90_000);
});

describe('under load', () => {
  it('queues a burst of exports rather than falling over', async () => {
    const owner = await project();

    // Eight at once, from one organisation, the way a script or an impatient click would.
    const jobIds = await Promise.all(
      Array.from({ length: 8 }, () =>
        enqueue({
          projectId: owner.projectId,
          organizationId: owner.organizationId,
          userId: owner.userId,
        }),
      ),
    );

    start({ concurrency: 1 });
    const finished = await Promise.all(jobIds.map((id) => settle(id, 120_000)));

    // Every one built. The queue is what turns "eight simultaneous requests" into "eight jobs, one
    // at a time" — without it, eight concurrent builds is eight copies of a whole project in memory.
    expect(finished.every((job) => job.status === 'done')).toBe(true);
    expect(new Set(finished.map((job) => job.artifactPath)).size).toBe(8);
    expect(storage.files.size).toBe(8);
  }, 180_000);
});

describe('what the worker says about itself', () => {
  it('continues the API request’s trace rather than starting one of its own', async () => {
    const owner = await project();

    // Exactly what the API does at enqueue time: start a span, inject a carrier into the payload.
    // Faked here only in that no HTTP is involved — the carrier is produced by the same code.
    const api = startTelemetry({ serviceName: 'helaengine-api', tracePath });
    let carrier: Record<string, string> = {};
    let requestTraceId = '';
    await withCorrelation('hela_1111111111111111', () =>
      inSpan(api.tracer, 'POST /projects/:project/exports', {}, async (span) => {
        requestTraceId = span.spanContext().traceId;
        carrier = traceCarrier();
      }),
    );

    const jobId = await enqueue({ ...owner, correlationId: 'hela_1111111111111111', carrier });
    start();
    const job = await settle(jobId, 60_000);
    expect(job.status).toBe('done');

    const written = spans();
    const build = written.find(
      (span) => span.name === 'export.job' && span.attributes['hela.job_id'] === jobId,
    )!;

    // The whole sprint in one assertion: the work a queue did belongs to the request that asked
    // for it, so one trace id covers browser to artifact.
    expect(build.traceId).toBe(requestTraceId);
    expect(build.attributes['hela.correlation_id']).toBe('hela_1111111111111111');
    expect(build.service).toBe('helaengine-export-worker');

    // And the stages are on the timeline, in order, as child spans of that job.
    const children = written.filter((span) => span.traceId === requestTraceId);
    expect(children.map((span) => span.name)).toEqual(
      expect.arrayContaining(['export.load_scene', 'export.build', 'export.store']),
    );

    await api.shutdown();
  }, 90_000);

  it('counts a build and how long it took', async () => {
    const owner = await project();
    const before = metrics.jobsProcessed.get({ outcome: 'done' });

    const jobId = await enqueue(owner);
    start();
    expect((await settle(jobId, 60_000)).status).toBe('done');

    expect(metrics.jobsProcessed.get({ outcome: 'done' })).toBe(before + 1);
    const text = metrics.registry.render();
    expect(text).toContain('hela_export_job_duration_seconds_count{outcome="done"}');
  }, 90_000);

  it('marks the span of a build that failed, with the reason on it', async () => {
    const owner = await project();
    const jobId = await enqueue({ ...owner, sceneVersion: 99 });

    start();
    expect((await settle(jobId, 60_000)).status).toBe('failed');

    const failed = spans().find(
      (span) => span.name === 'export.job' && span.attributes['hela.job_id'] === jobId,
    )!;
    // A span that swallowed its error would be a trace saying everything was fine next to a user
    // looking at a failed export.
    expect(failed.status).toBe('error');
    expect(failed.message).toMatch(/no longer exists/);
    expect(metrics.jobsProcessed.get({ outcome: 'failed' })).toBeGreaterThan(0);
  }, 90_000);
});
