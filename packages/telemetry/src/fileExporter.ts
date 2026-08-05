import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-node';

/**
 * Spans as one JSON object per line, in a file.
 *
 * Not a production exporter, and not pretending to be — production sends OTLP to a collector, which
 * is what `tracing.ts` does when an endpoint is configured. This exists because of a gap that
 * otherwise makes this sprint unverifiable: the definition of done is "pick any export from the
 * last hour and follow its whole path in one view", and demonstrating that normally requires a
 * Grafana Cloud account, a collector, and a network. None of those can be part of a test.
 *
 * A file can. `tools/trace` reads it and prints exactly the view the definition of done describes,
 * so the claim is checked by a test rather than asserted in a document. It is also genuinely
 * useful on a laptop, where running a collector to debug one request is more setup than the bug is
 * worth.
 *
 * Synchronous appends, deliberately: this runs inside a `SimpleSpanProcessor` at span end, the
 * writes are a few hundred bytes, and an async write that loses the race with `process.exit` gives
 * you a trace file missing exactly the span that explains the crash.
 */
export class FileSpanExporter implements SpanExporter {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
    mkdirSync(dirname(path), { recursive: true });
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    try {
      const lines = spans.map((span) => `${JSON.stringify(toRecord(span))}\n`).join('');
      appendFileSync(this.#path, lines);
      done({ code: ExportResultCode.SUCCESS });
    } catch (error) {
      done({ code: ExportResultCode.FAILED, error: error as Error });
    }
  }

  async shutdown(): Promise<void> {
    // Nothing buffered — every span is already on disk by the time `export` returns.
  }
}

/** The stable on-disk shape. `tools/trace` and the tests both read this and nothing else. */
export interface SpanRecord {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  service: string;
  startedAt: number;
  durationMs: number;
  status: 'unset' | 'ok' | 'error';
  message?: string;
  attributes: Record<string, string | number | boolean>;
}

function toRecord(span: ReadableSpan): SpanRecord {
  const context = span.spanContext();
  const attributes: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(span.attributes)) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      attributes[key] = value;
    }
  }

  const service = span.resource.attributes['service.name'];
  return {
    name: span.name,
    traceId: context.traceId,
    spanId: context.spanId,
    parentSpanId: span.parentSpanContext?.spanId ?? null,
    service: typeof service === 'string' ? service : 'unknown',
    // Milliseconds since the epoch, from OpenTelemetry's `[seconds, nanoseconds]` pair. A trace
    // that spans two processes is only readable if both ends agree on a scale, and JSON has no
    // 64-bit integer to carry nanoseconds in anyway.
    startedAt: span.startTime[0] * 1_000 + span.startTime[1] / 1e6,
    durationMs: span.duration[0] * 1_000 + span.duration[1] / 1e6,
    status: span.status.code === 2 ? 'error' : span.status.code === 1 ? 'ok' : 'unset',
    ...(span.status.message === undefined ? {} : { message: span.status.message }),
    attributes,
  };
}
