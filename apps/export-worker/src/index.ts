import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@helaengine/api/db';
import { within } from '@helaengine/api/paths';
import { createExportQueue, createRedis } from '@helaengine/api/queue';
import { expiredArtifacts, forgetArtifact } from '@helaengine/api/exportJobs';
import {
  createLogger,
  PROMETHEUS_CONTENT_TYPE,
  serviceMetrics,
  startTelemetry,
} from '@helaengine/telemetry';
import { LocalAssetSource } from './build.js';
import { createExportWorker, recordFailures, type ArtifactStorage } from './worker.js';

/**
 * The export worker.
 *
 *   pnpm --filter @helaengine/export-worker start
 *
 * Needs the same database as the API, the same Redis, and the generated asset library — the
 * artefacts it builds are made of all three.
 */

/**
 * Finished builds on a local disk.
 *
 * The same shape and the same honesty as Sprint 30's asset storage: object storage would replace
 * these two methods and nothing else. Worth noting what is different, though — an export is
 * *temporary*, so this one never needs a CDN, and the expiry that governs it lives in the database
 * rather than in a bucket lifecycle rule.
 */
class LocalArtifactStorage implements ArtifactStorage {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
    mkdirSync(this.#root, { recursive: true });
  }

  /** Removes a build whose time is up. Missing is success: the point is that it is not there. */
  remove(key: string): void {
    const target = join(this.#root, key);
    if (!within(this.#root, target)) throw new Error('that key would escape the artifact store');
    rmSync(target, { force: true });
  }

  put(key: string, bytes: Uint8Array): string {
    const target = join(this.#root, key);
    if (!within(this.#root, target)) throw new Error('that key would escape the artifact store');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return key;
  }

  read(key: string): Uint8Array | null {
    const target = join(this.#root, key);
    if (!within(this.#root, target) || !existsSync(target)) return null;
    return readFileSync(target);
  }
}

const db = createPool();
const connection = createRedis();

/**
 * The repository root, from this file rather than from the working directory.
 *
 * The asset library and the engine bundle live at the top of the monorepo, and this process is
 * started by whatever is supervising it — `pnpm --filter`, a container entrypoint, a test harness —
 * each with a different idea of the current directory. Defaults relative to `cwd` work from the
 * root and fail everywhere else, which is a confusing way to fail.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const source = await LocalAssetSource.load({
  assetRoot: resolve(REPO_ROOT, process.env['ASSET_ROOT'] ?? 'generated/assets'),
  runtimePath: resolve(
    REPO_ROOT,
    process.env['ENGINE_RUNTIME'] ?? 'packages/engine/dist/runtime-full.js',
  ),
});

const storage = new LocalArtifactStorage(
  resolve(REPO_ROOT, process.env['EXPORT_ROOT'] ?? '.hela-exports'),
);
const telemetry = startTelemetry({ serviceName: 'helaengine-export-worker' });
const log = createLogger({ service: 'export-worker' });
const metrics = serviceMetrics();

const worker = createExportWorker({
  db,
  connection,
  storage,
  source,
  concurrency: Number(process.env['EXPORT_CONCURRENCY'] ?? 1),
  telemetry: { tracer: telemetry.tracer, metrics, log },
});
recordFailures(worker, db, log);

/**
 * Queue depth, asked of Redis at scrape time.
 *
 * The one number that says whether this worker is keeping up. Job duration cannot: a queue with a
 * thousand jobs waiting and a worker cheerfully building each one in twenty seconds looks perfectly
 * healthy from the inside. `waiting` climbing is what a user experiences as "my export never
 * starts", and it is what the runbook's backlog alert fires on.
 */
const queue = createExportQueue(connection);
async function readQueueDepth(): Promise<void> {
  try {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    for (const [state, count] of Object.entries(counts)) metrics.queueDepth.set(count, { state });
  } catch (error) {
    // A Redis blip should not fail a scrape: the rest of the metrics are still true, and a scrape
    // that 500s makes the monitoring look like the outage.
    log.warn('could not read queue depth', { error });
  }
}

/**
 * Expired builds are deleted, not merely refused.
 *
 * The worker owns the artifact store, so it is the process that can remove bytes from it — the API
 * only reads. Hourly and bounded: a batch of two hundred keeps a long-neglected deployment from
 * spending its first hour deleting rather than building.
 */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;
async function sweepExpiredArtifacts(): Promise<void> {
  const expired = await expiredArtifacts(db);
  for (const artifact of expired) {
    storage.remove(artifact.artifactPath);
    // The row keeps its history entry and loses its pointer, so "you exported this on Tuesday"
    // survives while "and here it is" does not.
    await forgetArtifact(db, artifact.id);
  }
  if (expired.length > 0) log.info('swept expired builds', { count: expired.length });
}

const sweeping = setInterval(() => {
  void sweepExpiredArtifacts().catch((error: unknown) => {
    log.warn('could not sweep expired builds', { error });
  });
}, SWEEP_INTERVAL_MS);
sweeping.unref();
// Once at startup as well: a worker that has been down for a day should not wait another hour.
void sweepExpiredArtifacts().catch(() => {});

/**
 * A health endpoint, on a worker with no HTTP surface of its own.
 *
 * It exists so that anything supervising this process — a container orchestrator, or Playwright
 * waiting for the service to come up before a test — has something to ask. Without it the only
 * signal a worker is ready is a log line, and waiting on a log line is how a test suite ends up
 * racing its own fixtures.
 */
const healthPort = Number(process.env['EXPORT_WORKER_PORT'] ?? 3300);
const health = createServer((request, response) => {
  // The same scrape endpoint the API exposes, on the port that already exists. A worker with no
  // HTTP surface is a worker whose queue depth nobody can see.
  if (request.url === '/metrics') {
    void readQueueDepth().then(() => {
      response.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE });
      response.end(metrics.registry.render());
    });
    return;
  }
  if (request.url !== '/health') return void response.writeHead(404).end();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      ok: true,
      service: 'helaengine-export-worker',
      assets: source.manifest.assets.length,
    }),
  );
});
health.listen(healthPort);

log.info('waiting for jobs', {
  assets: source.manifest.assets.length,
  concurrency: Number(process.env['EXPORT_CONCURRENCY'] ?? 1),
  health: `http://localhost:${healthPort}/health`,
});

/**
 * Finish the job in hand before going away.
 *
 * `worker.close()` waits for the active job rather than abandoning it, which is the difference
 * between a deploy that costs a user nothing and one that costs them a two-minute build. A second
 * signal is ignored — the first close is already the graceful one.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      log.info('finishing the current job before stopping');
      await worker.close();
      health.close();
      // Flushed before the connection goes: the spans describing the last job of a deploy are
      // exactly the ones worth keeping.
      await telemetry.shutdown();
      await queue.close();
      await connection.quit();
      await db.end();
      process.exit(0);
    })();
  });
}
