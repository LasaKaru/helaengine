import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalAssetStorage } from './assets.js';
import { createPool, migrate } from './db.js';
import { createExportQueue, createRedis } from './queue.js';
import { createApiServer } from './server.js';

const port = Number(process.env['API_PORT'] ?? 3000);
const db = createPool();

const applied = await migrate(db);
if (applied.length > 0) console.log(`[api] applied ${applied.join(', ')}`);

/**
 * The export queue, if Redis is reachable.
 *
 * Optional rather than required, because the API is useful without it: jobs are still recorded and
 * quota is still enforced, they simply wait for a queue to exist. A hard dependency here would mean
 * accounts and cloud save stop working because a build server is down, which is the wrong coupling.
 */
const redis = createRedis();
redis.on('error', (error: Error) => {
  console.warn(`[api] export queue unavailable: ${error.message}`);
});

/**
 * Where finished exports are read from.
 *
 * The *same directory the worker writes to*, resolved from the repository root so both processes
 * agree however they were started. Two services with different ideas of where an artifact lives is
 * a download that 404s for reasons nobody can see from either side.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const storage = new LocalAssetStorage(
  resolve(REPO_ROOT, process.env['ASSET_ROOT'] ?? '.hela-assets'),
);
const exports_ = new LocalAssetStorage(
  resolve(REPO_ROOT, process.env['EXPORT_ROOT'] ?? '.hela-exports'),
);

createApiServer({ db, storage, exportStorage: exports_, queue: createExportQueue(redis) }).listen(
  port,
  () => {
    console.log(`[api] listening on http://localhost:${port}`);
  },
);
