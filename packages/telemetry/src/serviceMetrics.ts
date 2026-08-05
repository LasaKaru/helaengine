import {
  Registry,
  HTTP_BUCKETS,
  JOB_BUCKETS,
  type Counter,
  type Gauge,
  type Histogram,
} from './metrics.js';

/**
 * The metrics this product actually alerts on, defined once.
 *
 * Every one of these exists because a dashboard panel or an alert rule in `ops/` needs it — see
 * `docs/RUNBOOK.md`, where each alert names the metric it fires on. Metrics with no reader are how
 * a `/metrics` endpoint grows to four thousand series that nobody can navigate, so the rule here is
 * that a metric arrives with the thing that reads it.
 *
 * Both services build one of these; the worker simply never touches the HTTP instruments and the
 * API never touches the job ones. Unused instruments emit nothing at all (see `Metric.render`), so
 * sharing the definitions costs a scrape nothing.
 */
export interface ServiceMetrics {
  registry: Registry;
  httpRequests: Counter;
  httpDuration: Histogram;
  httpInFlight: Gauge;
  jobsProcessed: Counter;
  jobDuration: Histogram;
  queueDepth: Gauge;
  poolConnections: Gauge;
}

export function serviceMetrics(): ServiceMetrics {
  const registry = new Registry();

  return {
    registry,
    httpRequests: registry.counter({
      name: 'hela_http_requests_total',
      help: 'HTTP requests by route, method and status class.',
      // `route` is the *pattern*, never the path: one series per project id is a cardinality
      // explosion that takes the whole metrics store down with it.
      labelNames: ['route', 'method', 'status'],
    }),
    httpDuration: registry.histogram({
      name: 'hela_http_request_duration_seconds',
      help: 'How long the API took to answer, by route.',
      labelNames: ['route', 'method'],
      buckets: HTTP_BUCKETS,
    }),
    httpInFlight: registry.gauge({
      name: 'hela_http_in_flight_requests',
      help: 'Requests being handled right now.',
    }),
    jobsProcessed: registry.counter({
      name: 'hela_export_jobs_total',
      help: 'Export jobs that reached a terminal state, by outcome.',
      labelNames: ['outcome'],
    }),
    jobDuration: registry.histogram({
      name: 'hela_export_job_duration_seconds',
      help: 'How long a whole export took, from picked up to stored.',
      labelNames: ['outcome'],
      buckets: JOB_BUCKETS,
    }),
    queueDepth: registry.gauge({
      name: 'hela_export_queue_depth',
      help: 'Jobs waiting, active or delayed on the export queue.',
      labelNames: ['state'],
    }),
    poolConnections: registry.gauge({
      name: 'hela_pg_pool_connections',
      help: 'Postgres pool: total, idle and waiting.',
      labelNames: ['state'],
    }),
  };
}
