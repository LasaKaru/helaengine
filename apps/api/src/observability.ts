import type { IncomingMessage, ServerResponse } from 'node:http';
import { SpanKind, SpanStatusCode, type Tracer } from '@opentelemetry/api';
import {
  acceptCorrelationId,
  CORRELATION_HEADER,
  withCorrelation,
  type Logger,
  type ServiceMetrics,
} from '@helaengine/telemetry';
import type { Db } from './db.js';

/**
 * What the API says about itself while it works.
 *
 * Kept out of `server.ts` because the router is already long, and because the interesting decision
 * here — how a URL becomes a metric label — has nothing to do with routing and everything to do
 * with not taking the metrics store down. See `routePattern`.
 */

export interface ApiTelemetry {
  tracer: Tracer;
  metrics: ServiceMetrics;
  log: Logger;
  /**
   * Required on `/metrics` when set.
   *
   * Off by default because the usual deployment keeps the scrape endpoint on a private network, and
   * a token that everybody sets to `changeme` is worse than an honest "this port is internal". Set
   * `METRICS_TOKEN` when the endpoint is reachable from anywhere it should not be.
   */
  metricsToken?: string;
}

/**
 * The routes this API has, as *patterns*.
 *
 * Every metric label comes from this list and nowhere else, which is the entire point. A label
 * taken from the raw path means one time series per project id — a million projects is a million
 * series, and the cardinality explosion takes Prometheus down long before anybody notices the
 * dashboard has stopped being readable. Anything unrecognised collapses to `unmatched`, so even a
 * scanner spraying random URLs adds one series rather than thousands.
 */
const ROUTES = new Set([
  '/health',
  '/metrics',
  '/auth/signup',
  '/auth/login',
  '/me',
  '/orgs',
  '/orgs/:org/invites',
  '/orgs/:org/members',
  '/orgs/:org/projects',
  '/orgs/:org/export-quota',
  '/orgs/:org/assets',
  '/orgs/:org/assets/:asset',
  '/invites/accept',
  '/projects/:project',
  '/projects/:project/versions',
  '/projects/:project/versions/:version/restore',
  '/projects/:project/exports',
  '/export-jobs/:job',
  '/export-jobs/:job/download',
  '/uploads/:org/:asset',
  '/assets/:key',
]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

export function routePattern(path: string): string {
  // The served-file route first: its tail is a storage key, which can contain anything including
  // slashes, so it would not survive the segment-wise rules below.
  if (/^\/assets\/.+$/.test(path)) return '/assets/:key';

  const pattern = path
    .replace(UUID, ':id')
    .replace(/\/versions\/[0-9]+\/restore$/, '/versions/:version/restore')
    // Asset ids are short slugs rather than UUIDs, and only ever appear in these two shapes.
    .replace(/^\/uploads\/:id\/[a-z0-9_]+$/, '/uploads/:id/:asset')
    .replace(/^\/orgs\/:id\/assets\/[a-z0-9_]+$/, '/orgs/:id/assets/:asset')
    // Named after what the id *is*, which is what makes a dashboard legend readable.
    .replace(/^\/orgs\/:id/, '/orgs/:org')
    .replace(/^\/projects\/:id/, '/projects/:project')
    .replace(/^\/export-jobs\/:id/, '/export-jobs/:job')
    .replace(/^\/uploads\/:id/, '/uploads/:org');

  return ROUTES.has(pattern) ? pattern : 'unmatched';
}

export interface Observer {
  /** Wraps one request: a correlation id, a span, a log line and three metrics. */
  observe: (
    request: IncomingMessage,
    response: ServerResponse,
    handle: () => Promise<void>,
  ) => Promise<void>;
  /** The scrape body, with the pool read fresh. */
  scrape: () => string;
}

/**
 * One observer per server.
 *
 * A closure rather than module-level counters, and the tests are the reason: the API suite starts
 * several servers in one process, and a shared in-flight counter would have each of them decrement
 * the others' requests — a gauge that drifts negative and a bug that only ever appears in the
 * suite that is supposed to be checking for bugs.
 */
export function createObserver(telemetry: ApiTelemetry, db: Db): Observer {
  const { metrics, log, tracer } = telemetry;
  const pool = db as unknown as { totalCount: number; idleCount: number; waitingCount: number };
  let inFlight = 0;

  return {
    observe(request, response, handle) {
      const method = request.method ?? 'GET';
      const path = (request.url ?? '/').split('?')[0] ?? '/';
      const route = routePattern(path);

      const correlationId = acceptCorrelationId(request.headers[CORRELATION_HEADER]);
      // Echoed back on every response, including failures. A user who hits an error can then read
      // the id out of the network tab — or out of a support form that copies it — and it names
      // their exact request rather than the general area of it.
      response.setHeader(CORRELATION_HEADER, correlationId);

      const started = process.hrtime.bigint();
      inFlight += 1;
      metrics.httpInFlight.set(inFlight);

      return withCorrelation(correlationId, () =>
        tracer.startActiveSpan(
          `${method} ${route}`,
          {
            kind: SpanKind.SERVER,
            attributes: {
              'http.request.method': method,
              'http.route': route,
              'url.path': path,
              'hela.correlation_id': correlationId,
            },
          },
          async (span) => {
            /**
             * Everything is recorded from the response's own lifecycle, not from the handler's
             * return value.
             *
             * The handler has several ways to end a response — `send`, a bare `writeHead(204)`, a
             * streamed download — and one way to end it *somewhere else*: throwing, after which the
             * error handler wrapped around this writes the 4xx or 5xx. That last case is why the
             * span cannot be closed where the handler returns. It was, at first, and every failed
             * request got a span with no status code on it: the exact spans somebody would go
             * looking for.
             *
             * `close` rather than `finish`, and the two are not interchangeable: `finish` fires
             * only for a response that was completely written, so a client hanging up mid-download
             * would leave the in-flight gauge permanently one higher. `close` always fires.
             */
            const finished = new Promise<void>((resolve) => {
              // Re-entered rather than inherited, and this cost a debugging session: an
              // `AsyncLocalStorage` store does **not** follow an event listener. Node runs an
              // emitter's callbacks in the async context the *emitter* was created in — the
              // connection's — not the one `.once()` was called from. So the request line, the one
              // line that exists to be searched by correlation id, was written without one.
              response.once('close', () =>
                withCorrelation(correlationId, () => {
                  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
                  inFlight -= 1;
                  metrics.httpInFlight.set(inFlight);
                  metrics.httpDuration.observe(seconds, { route, method });
                  // The status *class*, not the status: 200 and 201 answer the same question on a
                  // dashboard, and five series per route is all an alert rule needs.
                  metrics.httpRequests.increment({
                    route,
                    method,
                    status: `${Math.floor(response.statusCode / 100)}xx`,
                  });

                  const fields = {
                    route,
                    method,
                    status: response.statusCode,
                    durationMs: Math.round(seconds * 1000),
                  };
                  // A 4xx is the caller's problem and a 5xx is ours. Logging both at the same
                  // level is how a dashboard of "errors" becomes a wall of expired sessions.
                  if (response.statusCode >= 500) log.error('request failed', fields);
                  else log.info('request', fields);

                  span.setAttribute('http.response.status_code', response.statusCode);
                  // Only a 5xx is an error on the span. A 401 is the system working.
                  span.setStatus({
                    code: response.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.OK,
                  });
                  span.end();
                  resolve();
                }),
              );
            });

            try {
              await handle();
            } catch (error) {
              // Recorded and rethrown, without waiting: the response has not been written yet —
              // the error handler above does that — so awaiting `finished` here would deadlock.
              // The span still ends when the response closes.
              span.recordException(error as Error);
              throw error;
            }

            await finished;
          },
        ),
      );
    },

    scrape() {
      /**
       * Pool saturation, read when somebody asks.
       *
       * `waiting` is the number that matters and the one nobody thinks to export: total and idle
       * look healthy right up until every connection is checked out, at which point requests queue
       * *inside the pool* and the API goes slow with no slow query to blame. See the runbook.
       */
      metrics.poolConnections.set(pool.totalCount, { state: 'total' });
      metrics.poolConnections.set(pool.idleCount, { state: 'idle' });
      metrics.poolConnections.set(pool.waitingCount, { state: 'waiting' });
      return metrics.registry.render();
    },
  };
}
