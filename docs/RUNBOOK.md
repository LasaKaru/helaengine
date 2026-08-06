# Runbook

What to do when something is wrong, and how to find out what it is.

Written while there is exactly one person on call, which is the argument for writing it rather than
against: the value of a runbook is mostly in what it forces you to notice while writing it — that
an alert has no action, that a metric nobody exports would have answered the question, that two
services disagree about a name. Those were all found writing this one.

## The first thing to do, every time

**Get a correlation id.** Everything below is faster with one, and there are four ways to get one:

| You have                       | Where the id is                                                          |
| ------------------------------ | ------------------------------------------------------------------------ |
| A user's screenshot of a crash | On the crash screen, under "Reference"                                   |
| A failed export                | Under the error in the export panel, and in `export_jobs.correlation_id` |
| An HTTP response               | The `x-correlation-id` response header — on every response               |
| A log line                     | The `correlationId` field — on every request line                        |

Then, in Grafana, `{service=~"helaengine.*"} | json | correlationId="hela_…"` gives every log line
from every service for that one user action, and the trace with the same id gives the timings.

Locally, the same view without any of that infrastructure:

```bash
HELA_TRACE_FILE=.hela-traces/spans.ndjson pnpm api          # and the worker, same variable
pnpm trace hela_9f3c1a2b4d5e6f70
```

```
trace       5487617f734794ef0ced565617fbbad0
correlation hela_65653ad44b8da5a9
services    api, export-worker
spans       7, 430.9ms end to end

  +0ms      13.1ms    api                      POST /projects/:project/exports
  +5ms      3.5ms     api                        export.record
  +8ms      3.9ms     api                        export.enqueue
  +16ms     414.9ms   export-worker                export.job
  +27ms     3.0ms     export-worker                  export.load_scene
  +31ms     395.1ms   export-worker                  export.build
  +428ms    2.6ms     export-worker                  export.store
```

## Alerts

Each of these exists in `ops/prometheus/alerts.yml`, and each one is here because there is
something to do about it. An alert with no entry in this section should be deleted, not documented.

### API error rate

**Fires when** more than 5% of API requests return a 5xx for five minutes.

1. `sum by (route) (rate(hela_http_requests_total{status="5xx"}[5m]))` — one route or all of them?
   One route is a bug in that handler. All of them is usually the database.
2. If it is all of them, check `hela_pg_pool_connections{state="waiting"}` and go to
   [pool exhaustion](#pool-exhaustion).
3. Take a correlation id from any recent `level=error` log line and open its trace. A 5xx that is
   really a database timeout looks completely different from one that is a bug, and the trace says
   which within seconds.
4. If a deploy went out in the last hour, roll it back before diagnosing further. Diagnosis is
   cheaper on a system that is not currently failing.

### API latency

**Fires when** p95 for a route is over a second for ten minutes.

1. Which route — the panel is by route for this reason. `/projects/:project/versions` (a save) and
   `/orgs/:org/assets` (a listing) have completely different causes.
2. Check the pool first. Latency with `waiting > 0` is queueing, not slow work.
3. Take a slow request's correlation id and read the trace. The span breakdown says whether the
   time is in the database, in the queue, or in the handler itself.
4. Sustained latency with a healthy pool and no slow span usually means the host is CPU-starved —
   check whether an export worker is sharing it, which it should not be.

### Export backlog

**Fires when** more than 50 jobs have been waiting for fifteen minutes.

1. Is a worker alive? `curl http://export-worker:3300/health`. No answer is the whole problem.
2. Is it working? `hela_export_jobs_total` should be climbing. A live worker with a flat counter is
   stuck on a job — read its logs for the `jobId` it last picked up, and trace it.
3. Is it failing over and over? A high `outcome="failed"` rate with a growing queue is a poison job
   being retried. Its three attempts will end on their own; if the same _project_ keeps failing,
   that project's scene is the problem, and the error is on the job row.
4. Genuine load, everything healthy: **run another worker.** Concurrency is deliberately 1 per
   process — an export holds a whole build in memory, so raising concurrency is how a worker gets
   OOM-killed, which costs every job it was holding. Scale out, not up.

### Pool exhaustion

**Fires when** any request has waited for a database connection for five minutes.

1. `hela_pg_pool_connections` — `total` at the maximum (10 per process) with `idle` at zero means
   every connection is checked out.
2. In Postgres: `select state, query, now() - query_start as age from pg_stat_activity order by age
desc limit 10;`. A long-running query at the top is the cause.
3. A leak looks different from load: leaked connections show as `idle in transaction` and never
   come back. That is a missing `client.release()` — the only place this codebase checks a client
   out by hand is `createExportJob`, which releases in a `finally`.
4. Short term, restarting the API returns the connections. Do that only after capturing
   `pg_stat_activity`, or the evidence goes with it.

## Things that are not alerts

Worth knowing, deliberately not paged on:

- **A single failed export.** Retried three times, then reported to the user with the reason. One
  failure is not an incident; the `outcome="failed"` rate on the dashboard is where a pattern shows.
- **4xx rates.** Somebody's session expiring is the system working. Watch it for a spike after a
  release — a new 400 on a route that never had one is a client/server disagreement.
- **A crash reported from a browser.** Goes to Sentry when a DSN is configured (`VITE_SENTRY_DSN`).
  It is not a page: the editor keeps every other panel alive and the user's work is in the store.

## Turning telemetry on

Everything is off by default, in every service, and each variable turns on exactly one thing:

| Variable                          | Effect                                                             |
| --------------------------------- | ------------------------------------------------------------------ |
| `OTEL_EXPORTER_OTLP_ENDPOINT`     | Traces go to a collector (Grafana Tempo, Jaeger, anything OTLP)    |
| `HELA_TRACE_FILE`                 | Traces are also written as NDJSON, for `pnpm trace`                |
| `LOG_LEVEL`                       | `debug`, `info` (default), `warn`, `error`                         |
| `METRICS_TOKEN`                   | `/metrics` requires `Authorization: Bearer …`                      |
| `VITE_SENTRY_DSN`                 | The editor reports crashes; without it, nothing leaves the browser |
| `ALLOWED_ORIGINS`                 | Comma-separated CORS allowlist; unset means a wildcard             |
| `TRUST_PROXY`                     | Take the client address from `X-Forwarded-For`                     |
| `AUTH_*` (see `docs/SECURITY.md`) | Rate limits, when the defaults do not suit the deployment          |

`/metrics` is served by the API on its own port and by the worker on its health port (3300).

## What is not here yet

Being explicit, because a runbook that overstates its coverage is worse than a short one:

- **No live Grafana.** `ops/grafana/helaengine-overview.json` and the alert rules are written and
  reviewed, and they have never been loaded into a running Grafana or Prometheus — no container
  runtime was available where this was built. The metrics they read are asserted by tests to exist
  with those names and labels, so the queries have the right inputs; the panels themselves are
  unverified.
- **No alert delivery.** The rules carry severities (`page`, `ticket`); nothing is wired to
  PagerDuty or Slack. That is a receiver block in an Alertmanager configuration and an account.
- **No log aggregation.** Logs are structured JSON on stdout, which is what Loki, CloudWatch and
  every platform's log shipper expect. Nothing ships them yet.
- **No incident history.** When there has been one, this file gains a "past incidents" section.
