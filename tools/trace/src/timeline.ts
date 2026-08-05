import { readFileSync } from 'node:fs';
import type { SpanRecord } from '@helaengine/telemetry';

/**
 * Turning a pile of spans into the one view the sprint is judged on.
 *
 * The definition of done for Sprint 33 says: pick any export from the last hour and follow its
 * whole path — HTTP call, queue entry, worker processing, storage write — in one view, with timing
 * at each stage. In production that view is Grafana Tempo. This is the same view, built from the
 * NDJSON file the services write when `HELA_TRACE_FILE` is set, so the claim can be *checked* by a
 * test on a laptop instead of asserted in a document that nobody can run.
 *
 * Deliberately not a tracing backend: no sampling, no retention, no service graph, and it reads the
 * whole file into memory. It is a debugging tool sized for one developer and one request.
 */

export function readSpans(path: string): SpanRecord[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SpanRecord);
}

/** Spans belonging to one correlation id or one trace id, whichever the caller has. */
export function select(spans: SpanRecord[], id: string): SpanRecord[] {
  const direct = spans.filter(
    (span) => span.traceId === id || span.attributes['hela.correlation_id'] === id,
  );
  if (direct.length === 0) return [];

  /**
   * Widened to whole traces, on purpose.
   *
   * A correlation id is set on the spans this codebase creates, and a span made by something else
   * inside the same trace — a library, a future auto-instrumentation, an inner span somebody forgot
   * to annotate — would be missing from the answer. Since the whole point is "everything that
   * happened", the id is used to *find* the traces and the traces decide the membership.
   */
  const traces = new Set(direct.map((span) => span.traceId));
  return spans.filter((span) => traces.has(span.traceId)).sort((a, b) => a.startedAt - b.startedAt);
}

export interface TimelineRow {
  depth: number;
  span: SpanRecord;
  /** Milliseconds after the first span in the trace. What makes the ordering legible. */
  offsetMs: number;
}

/**
 * Parent-first order with a depth for each row.
 *
 * Built from `parentSpanId` rather than from start times, because two processes' clocks are not the
 * same clock: a worker whose host is 40 ms behind can produce a child span that *starts before* its
 * parent, and a timeline sorted purely by time then shows the effect above the cause. Ordering by
 * structure and displaying the time is honest about both.
 */
export function timeline(spans: SpanRecord[]): TimelineRow[] {
  if (spans.length === 0) return [];

  const byParent = new Map<string, SpanRecord[]>();
  const ids = new Set(spans.map((span) => span.spanId));
  for (const span of spans) {
    // A span whose parent is not in the file is a root *for this view* — which happens whenever a
    // trace is read while its first process is still writing.
    const key = span.parentSpanId && ids.has(span.parentSpanId) ? span.parentSpanId : '';
    byParent.set(key, [...(byParent.get(key) ?? []), span]);
  }

  const start = Math.min(...spans.map((span) => span.startedAt));
  const rows: TimelineRow[] = [];

  const walk = (parentId: string, depth: number): void => {
    const children = [...(byParent.get(parentId) ?? [])].sort((a, b) => a.startedAt - b.startedAt);
    for (const span of children) {
      rows.push({ depth, span, offsetMs: span.startedAt - start });
      walk(span.spanId, depth + 1);
    }
  };
  walk('', 0);

  return rows;
}

/** The printable view. Kept separate from the printing so the tests assert on text, not on stdout. */
export function render(rows: TimelineRow[]): string {
  if (rows.length === 0) return 'Nothing matched that id.\n';

  const lines = rows.map(({ depth, span, offsetMs }) => {
    const marker = span.status === 'error' ? '✗' : ' ';
    const indent = '  '.repeat(depth);
    return (
      `${marker} ${pad(`+${Math.round(offsetMs)}ms`, 9)} ` +
      `${pad(duration(span.durationMs), 9)} ` +
      `${pad(short(span.service), 24)} ${indent}${span.name}` +
      (span.message === undefined ? '' : `\n      ${indent}↳ ${span.message}`)
    );
  });

  const spans = rows.map((row) => row.span);
  const total = Math.max(...rows.map((row) => row.offsetMs + row.span.durationMs));
  const correlationId = spans.find((span) => span.attributes['hela.correlation_id'])?.attributes[
    'hela.correlation_id'
  ];

  const header = [
    `trace       ${spans[0]!.traceId}`,
    ...(correlationId === undefined ? [] : [`correlation ${String(correlationId)}`]),
    `services    ${[...new Set(spans.map((span) => short(span.service)))].join(', ')}`,
    `spans       ${spans.length}, ${duration(total)} end to end`,
    '',
  ];

  const failures = spans.filter((span) => span.status === 'error');
  const footer =
    failures.length === 0 ? [] : ['', `${failures.length} span(s) failed — marked ✗ above.`];

  return [...header, ...lines, ...footer, ''].join('\n');
}

/** Every trace in the file, newest first — for when somebody has no id to start from. */
export function summarise(spans: SpanRecord[], limit = 20): string {
  const roots = spans
    .filter((span) => span.parentSpanId === null)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);

  if (roots.length === 0) return 'No traces in that file.\n';

  return `${roots
    .map((span) => {
      const correlationId = span.attributes['hela.correlation_id'];
      return (
        `${new Date(span.startedAt).toISOString()}  ${pad(duration(span.durationMs), 9)} ` +
        `${pad(String(correlationId ?? span.traceId), 22)} ${span.name}` +
        (span.status === 'error' ? '  ✗' : '')
      );
    })
    .join('\n')}\n`;
}

function duration(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function short(service: string): string {
  return service.replace(/^helaengine-/, '');
}

function pad(value: string, width: number): string {
  return value.padEnd(width, ' ');
}
