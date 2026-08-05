import { createServer } from 'node:http';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '@helaengine/api/db';
import { createRedis } from '@helaengine/api/queue';
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

  put(key: string, bytes: Uint8Array): string {
    const target = join(this.#root, key);
    if (!target.startsWith(this.#root)) throw new Error('that key would escape the artifact store');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return key;
  }

  read(key: string): Uint8Array | null {
    const target = join(this.#root, key);
    if (!target.startsWith(this.#root) || !existsSync(target)) return null;
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
const worker = createExportWorker({
  db,
  connection,
  storage,
  source,
  concurrency: Number(process.env['EXPORT_CONCURRENCY'] ?? 1),
});
recordFailures(worker, db);

/**
 * A health endpoint, on a worker with no HTTP surface of its own.
 *
 * It exists so that anything supervising this process — a container orchestrator, or Playwright
 * waiting for the service to come up before a test — has something to ask. Without it the only
 * signal a worker is ready is a log line, and waiting on a log line is how a test suite ends up
 * racing its own fixtures.
 */
const healthPort = Number(process.env['EXPORT_WORKER_PORT'] ?? 3300);
createServer((request, response) => {
  if (request.url !== '/health') return void response.writeHead(404).end();
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(
    JSON.stringify({
      ok: true,
      service: 'helaengine-export-worker',
      assets: source.manifest.assets.length,
    }),
  );
}).listen(healthPort);

console.log(
  `[export-worker] waiting for jobs (${source.manifest.assets.length} assets, ` +
    `concurrency ${process.env['EXPORT_CONCURRENCY'] ?? 1}, health on :${healthPort})`,
);

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
      console.log('[export-worker] finishing the current job before stopping…');
      await worker.close();
      await connection.quit();
      await db.end();
      process.exit(0);
    })();
  });
}
