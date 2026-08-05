import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  SimpleSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { currentCorrelationId } from './correlation.js';
import { FileSpanExporter } from './fileExporter.js';

/**
 * Tracing, set up by hand rather than by auto-instrumentation.
 *
 * `@opentelemetry/auto-instrumentations-node` would patch `http`, `pg` and `ioredis` and produce a
 * great deal of it for free, and this deliberately does not use it. Two reasons, and the second is
 * the real one:
 *
 * 1. Auto-instrumentation monkey-patches the module registry at load time, which means the
 *    behaviour of the API under test differs from the API in production by whatever the patches do.
 *    That is a bad property for a service whose tests are the reason anybody trusts it.
 * 2. A trace made of `HTTP POST` and `pg.query` spans tells you what the runtime did. A trace made
 *    of `export.request`, `export.build` and `export.store` tells you what the *product* did, and
 *    the second is the one somebody reads at two in the morning. Naming spans after the domain is
 *    work, and it is the work that makes a trace worth opening.
 *
 * Everything is off unless configured. A developer running `pnpm dev` gets no exporter, no network
 * calls and no file — telemetry that costs something when nobody asked for it is telemetry that
 * gets ripped out.
 */

export interface TelemetryOptions {
  serviceName: string;
  version?: string;
  /** OTLP endpoint. Falls back to `OTEL_EXPORTER_OTLP_ENDPOINT`; absent means no OTLP export. */
  otlpEndpoint?: string;
  /** NDJSON span file. Falls back to `HELA_TRACE_FILE`; see `fileExporter.ts` for why it exists. */
  tracePath?: string;
}

export interface Telemetry {
  tracer: Tracer;
  /** Flushes and stops. Awaited on shutdown, so the last spans of a deploy are not the ones lost. */
  shutdown: () => Promise<void>;
}

export function startTelemetry(options: TelemetryOptions): Telemetry {
  const processors: SpanProcessor[] = [];

  const endpoint = options.otlpEndpoint ?? process.env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (endpoint) {
    // Batched: one HTTP request per span would make the exporter the slowest thing in the service.
    processors.push(
      new BatchSpanProcessor(new OTLPTraceExporter({ url: `${endpoint}/v1/traces` })),
    );
  }

  const tracePath = options.tracePath ?? process.env['HELA_TRACE_FILE'];
  if (tracePath) {
    // Simple rather than batched, so a span is on disk the moment it ends. A test that exports and
    // then immediately reads the file must not race a batch timer.
    processors.push(new SimpleSpanProcessor(new FileSpanExporter(tracePath)));
  }

  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.version ?? '0.1.0',
    }),
    spanProcessors: processors,
  });

  // Registered even with no processors: the instrumented code paths then behave identically in
  // every configuration, spans and all, and simply go nowhere. Code that takes a different path
  // when telemetry is off is code whose telemetry is untested.
  //
  // What registration buys is the *global* context manager and propagator — how `context.with`
  // survives an await and how `traceparent` is written. Both are process-wide and idempotent:
  // OpenTelemetry keeps the first registration and warns about later ones.
  provider.register({ propagator: new W3CTraceContextPropagator() });

  return {
    // From the provider rather than from `trace.getTracer`, and this is not a stylistic
    // preference — the global tracer provider is also first-registration-wins, so a second
    // `startTelemetry` in one process (two services in a test file, an embedded worker) would hand
    // back a tracer still wired to the *first* provider's exporters. Spans would then quietly land
    // in the wrong file, which is the kind of bug that makes people distrust their own traces.
    tracer: provider.getTracer(options.serviceName, options.version ?? '0.1.0'),
    shutdown: () => provider.shutdown(),
  };
}

/**
 * Runs `body` inside a span, ending it whatever happens.
 *
 * The correlation id is attached here rather than at each call site, so every span in a correlated
 * unit of work carries it without anybody remembering to. That is what makes `tools/trace` — and a
 * Grafana query on `hela.correlation_id` — able to find a whole user action from one string.
 */
export async function inSpan<T>(
  tracer: Tracer,
  name: string,
  attributes: Attributes,
  body: (span: Span) => Promise<T>,
): Promise<T> {
  const correlationId = currentCorrelationId();
  return tracer.startActiveSpan(
    name,
    {
      attributes: {
        ...attributes,
        ...(correlationId ? { 'hela.correlation_id': correlationId } : {}),
      },
    },
    async (span) => {
      try {
        const result = await body(span);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (error) {
        // Recorded on the span *and* rethrown. A span that swallows its error is a trace that says
        // everything went fine next to a user who saw a 500.
        span.recordException(error as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** The trace this code is running in, for a log line to name. Empty strings outside any span. */
export function currentTraceIds(): { traceId: string; spanId: string } {
  const active = trace.getSpan(context.active())?.spanContext();
  return { traceId: active?.traceId ?? '', spanId: active?.spanId ?? '' };
}

/**
 * The W3C `traceparent` for the span in hand, so a trace can cross a queue.
 *
 * HTTP has headers and OpenTelemetry knows how to use them. BullMQ has neither, so the carrier is
 * written into the job payload by the API and read back by the worker — the same standard format,
 * moved by hand because there is nowhere automatic to put it.
 */
export function traceCarrier(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** The other half: runs `body` as a child of whatever trace the carrier names. */
export function withCarrier<T>(carrier: Record<string, string> | undefined, body: () => T): T {
  if (!carrier) return body();
  return context.with(propagation.extract(context.active(), carrier), body);
}
