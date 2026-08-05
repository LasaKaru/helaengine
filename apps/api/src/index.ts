import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger, serviceMetrics, startTelemetry } from '@helaengine/telemetry';
import { LocalAssetStorage } from './assets.js';
import { createPool, migrate } from './db.js';
import { createExportQueue, createRedis } from './queue.js';
import { createApiServer } from './server.js';

const port = Number(process.env['API_PORT'] ?? 3000);
const db = createPool();

/**
 * Telemetry first, before anything that might want to be traced.
 *
 * Exports nowhere unless `OTEL_EXPORTER_OTLP_ENDPOINT` or `HELA_TRACE_FILE` says otherwise, so a
 * developer running `pnpm dev` pays nothing and sends nothing.
 */
const telemetry = startTelemetry({ serviceName: 'helaengine-api' });
const log = createLogger({ service: 'api' });

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

const server = createApiServer({
  db,
  storage,
  exportStorage: exports_,
  queue: createExportQueue(redis),
  telemetry: { tracer: telemetry.tracer, metrics: serviceMetrics(), log },
});

server.listen(port, () => {
  log.info('listening', { port, metrics: `http://localhost:${port}/metrics` });
});

/**
 * Flush before going away.
 *
 * Without this the spans describing a shutdown — including whatever request was in flight when the
 * deploy landed — are the ones that never leave the process, which is precisely the window worth
 * having traces for.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      server.close();
      await telemetry.shutdown();
      await db.end();
      process.exit(0);
    })();
  });
}
