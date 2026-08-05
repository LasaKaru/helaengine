import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SpanRecord } from '@helaengine/telemetry';
import { readSpans, render, select, summarise, timeline } from './timeline.js';

/**
 * The shape of a real export trace: a request in the API, then work in the worker that continues
 * it — the exact thing the sprint's definition of done asks somebody to be able to follow.
 */
function span(overrides: Partial<SpanRecord> & Pick<SpanRecord, 'name' | 'spanId'>): SpanRecord {
  return {
    traceId: 'trace1',
    parentSpanId: null,
    service: 'helaengine-api',
    startedAt: 1_000,
    durationMs: 10,
    status: 'ok',
    attributes: {},
    ...overrides,
  };
}

const request = span({
  name: 'POST /projects/:project/exports',
  spanId: 'a1',
  durationMs: 25,
  attributes: { 'hela.correlation_id': 'hela_1234567890abcdef' },
});
const job = span({
  name: 'export.job',
  spanId: 'b1',
  parentSpanId: 'a1',
  service: 'helaengine-export-worker',
  startedAt: 1_400,
  durationMs: 8_000,
  attributes: { 'hela.correlation_id': 'hela_1234567890abcdef', 'hela.job_id': 'job-1' },
});
const build = span({
  name: 'export.build',
  spanId: 'b2',
  parentSpanId: 'b1',
  service: 'helaengine-export-worker',
  startedAt: 1_500,
  durationMs: 7_000,
});
const other = span({ name: 'GET /me', spanId: 'z1', traceId: 'trace2', startedAt: 5_000 });

const all = [request, job, build, other];

describe('selecting', () => {
  it('finds a whole trace from a correlation id', () => {
    const found = select(all, 'hela_1234567890abcdef');
    expect(found.map((each) => each.spanId)).toEqual(['a1', 'b1', 'b2']);
  });

  it('finds it from a trace id too, since that is what a Grafana link gives you', () => {
    expect(select(all, 'trace1').map((each) => each.spanId)).toEqual(['a1', 'b1', 'b2']);
  });

  it('includes spans in the trace that carry no correlation id of their own', () => {
    // `export.build` has no correlation attribute. Filtering on the attribute alone would drop the
    // span where the time actually went, which is the one somebody opened this tool to see.
    expect(select(all, 'hela_1234567890abcdef').map((each) => each.name)).toContain('export.build');
  });

  it('returns nothing for an id nobody has seen', () => {
    expect(select(all, 'hela_0000000000000000')).toEqual([]);
  });
});

describe('the timeline', () => {
  it('nests children under parents and offsets them from the start', () => {
    const rows = timeline(select(all, 'trace1'));
    expect(rows.map((row) => [row.depth, row.span.name, row.offsetMs])).toEqual([
      [0, 'POST /projects/:project/exports', 0],
      [1, 'export.job', 400],
      [2, 'export.build', 500],
    ]);
  });

  it('orders by structure rather than by clock, so a skewed worker still reads correctly', () => {
    // Two hosts, two clocks. A child that appears to start 40 ms *before* its parent is a clock
    // difference, not time travel — and a timeline sorted purely by timestamp would print the
    // worker's work above the request that caused it.
    const skewed = timeline([{ ...job, startedAt: 960 }, request]);
    expect(skewed.map((row) => row.span.name)).toEqual([
      'POST /projects/:project/exports',
      'export.job',
    ]);
  });

  it('treats a span whose parent is not in the file as a root', () => {
    // What you get reading a trace while the first service is still writing it.
    const rows = timeline([job, build]);
    expect(rows.map((row) => [row.depth, row.span.name])).toEqual([
      [0, 'export.job'],
      [1, 'export.build'],
    ]);
  });
});

describe('rendering', () => {
  it('prints every service, the correlation id and where the time went', () => {
    const text = render(timeline(select(all, 'hela_1234567890abcdef')));

    expect(text).toContain('correlation hela_1234567890abcdef');
    expect(text).toContain('api, export-worker');
    expect(text).toContain('POST /projects/:project/exports');
    expect(text).toContain('export.build');
    // 8 seconds of the 8.4 second trace is the build. That is the answer to "why was it slow".
    expect(text).toContain('8.00s');
  });

  it('marks a failure and says what it was', () => {
    const failed = [
      request,
      { ...job, status: 'error' as const, message: 'that scene could not be read' },
    ];
    const text = render(timeline(failed));
    expect(text).toContain('✗');
    expect(text).toContain('that scene could not be read');
    expect(text).toContain('1 span(s) failed');
  });

  it('says so plainly when nothing matched', () => {
    expect(render(timeline([]))).toBe('Nothing matched that id.\n');
  });
});

describe('the listing', () => {
  it('shows recent traces newest first, for somebody with a time rather than an id', () => {
    const text = summarise(all);
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('GET /me');
    expect(lines[1]).toContain('hela_1234567890abcdef');
  });
});

describe('reading the file', () => {
  it('parses NDJSON and ignores the blank last line every appender leaves', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hela-trace-')), 'spans.ndjson');
    writeFileSync(path, `${JSON.stringify(request)}\n${JSON.stringify(job)}\n`);
    expect(readSpans(path).map((each) => each.spanId)).toEqual(['a1', 'b1']);
  });
});
