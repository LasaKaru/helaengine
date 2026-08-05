import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  acceptCorrelationId,
  createLogger,
  currentCorrelationId,
  inSpan,
  newCorrelationId,
  Registry,
  startTelemetry,
  traceCarrier,
  withCarrier,
  withCorrelation,
  type SpanRecord,
} from './index.js';

describe('correlation ids', () => {
  it('mints ids that survive being pasted into a URL, a log line and a ticket', () => {
    const id = newCorrelationId();
    expect(id).toMatch(/^hela_[0-9a-f]{16}$/);
    expect(encodeURIComponent(id)).toBe(id);
  });

  it('keeps a caller id that fits the shape', () => {
    expect(acceptCorrelationId('hela_0123456789abcdef')).toBe('hela_0123456789abcdef');
  });

  it('replaces anything that could break a log line rather than sanitising it', () => {
    // The failure this prevents: a caller-supplied newline splits one JSON log line into two, the
    // second of which the caller controls entirely.
    for (const hostile of ['a', '', 'x'.repeat(200), 'has space', 'two\nlines', '"quoted"']) {
      expect(acceptCorrelationId(hostile)).toMatch(/^hela_[0-9a-f]{16}$/);
    }
  });

  it('is ambient inside its work and absent outside it', () => {
    expect(currentCorrelationId()).toBeNull();
    withCorrelation('hela_aaaaaaaaaaaaaaaa', () => {
      expect(currentCorrelationId()).toBe('hela_aaaaaaaaaaaaaaaa');
    });
    expect(currentCorrelationId()).toBeNull();
  });

  it('follows an await, which is the only reason it is worth having', async () => {
    await withCorrelation('hela_bbbbbbbbbbbbbbbb', async () => {
      await new Promise((done) => setTimeout(done, 5));
      expect(currentCorrelationId()).toBe('hela_bbbbbbbbbbbbbbbb');
    });
  });
});

describe('the metric registry', () => {
  it('writes counters in the exposition format, with declared label order', () => {
    const registry = new Registry();
    const requests = registry.counter({
      name: 'hela_http_requests_total',
      help: 'Requests.',
      labelNames: ['route', 'method'],
    });

    requests.increment({ method: 'GET', route: '/health' });
    requests.increment({ route: '/health', method: 'GET' });

    // Two increments, one series — the label order the caller used must not matter, or the same
    // route counted twice appears on a dashboard as two half-height lines.
    expect(registry.render()).toContain('hela_http_requests_total{route="/health",method="GET"} 2');
    expect(requests.get({ route: '/health', method: 'GET' })).toBe(2);
  });

  it('escapes what the format cannot carry raw', () => {
    const registry = new Registry();
    const counter = registry.counter({ name: 'x_total', help: 'x', labelNames: ['label'] });
    counter.increment({ label: 'a"b\\c\nd' });
    expect(registry.render()).toContain('x_total{label="a\\"b\\\\c\\nd"} 1');
  });

  it('renders a histogram with cumulative buckets, a sum and a count', () => {
    const registry = new Registry();
    const duration = registry.histogram({
      name: 'hela_job_seconds',
      help: 'Jobs.',
      buckets: [1, 10],
    });

    duration.observe(0.5);
    duration.observe(5);
    duration.observe(50);

    const text = registry.render();
    expect(text).toContain('hela_job_seconds_bucket{le="1"} 1');
    // Cumulative: the 5s observation counts in `le="10"` along with the 0.5s one.
    expect(text).toContain('hela_job_seconds_bucket{le="10"} 2');
    // And the 50s observation is in no bucket but is still an observation.
    expect(text).toContain('hela_job_seconds_bucket{le="+Inf"} 3');
    expect(text).toContain('hela_job_seconds_sum 55.5');
    expect(text).toContain('hela_job_seconds_count 3');
  });

  it('reads a gauge at scrape time rather than on a timer', () => {
    const registry = new Registry();
    let depth = 0;
    const gauge = registry.gauge({
      name: 'hela_queue_depth',
      help: 'Depth.',
      collect: () => gauge.set(depth),
    });

    depth = 7;
    expect(registry.render()).toContain('hela_queue_depth 7');
    depth = 2;
    expect(registry.render()).toContain('hela_queue_depth 2');
  });

  it('says nothing about a metric that has never happened', () => {
    const registry = new Registry();
    registry.counter({ name: 'hela_never_total', help: 'Never.' });
    // Not `hela_never_total 0`: zero and "has not occurred" are different facts, and a panel that
    // shows a flat zero line for a metric nobody has ever emitted is a panel that lies quietly.
    expect(registry.render()).toBe('');
  });
});

describe('the logger', () => {
  it('writes one JSON object per line, carrying the ambient correlation id', () => {
    const lines: string[] = [];
    const log = createLogger({ service: 'api', level: 'info', write: (line) => lines.push(line) });

    withCorrelation('hela_cccccccccccccccc', () =>
      log.info('saved a project', { projectId: 'p1' }),
    );

    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({
      level: 'info',
      service: 'api',
      message: 'saved a project',
      correlationId: 'hela_cccccccccccccccc',
      projectId: 'p1',
    });
  });

  it('records an error instead of the empty object JSON.stringify makes of one', () => {
    const lines: string[] = [];
    const log = createLogger({ service: 'api', write: (line) => lines.push(line) });

    log.error('that failed', { error: new Error('disk on fire') });

    const record = JSON.parse(lines[0]!) as { error: { message: string; stack: string } };
    expect(record.error.message).toBe('disk on fire');
    expect(record.error.stack).toContain('disk on fire');
  });

  it('drops what is below the level', () => {
    const lines: string[] = [];
    const log = createLogger({ service: 'api', level: 'warn', write: (line) => lines.push(line) });
    log.info('quiet');
    log.error('loud');
    expect(lines).toHaveLength(1);
  });
});

describe('tracing', () => {
  it('writes spans to a file, carrying the correlation id and joining across a carrier', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hela-trace-')), 'spans.ndjson');
    const telemetry = startTelemetry({ serviceName: 'api', tracePath: path });

    // The shape of the real thing: an API request starts a trace, hands a carrier to a queue, and
    // a second process picks the carrier up and continues *the same trace*.
    let carrier: Record<string, string> = {};
    await withCorrelation('hela_dddddddddddddddd', async () => {
      await inSpan(telemetry.tracer, 'export.request', { 'hela.project_id': 'p1' }, async () => {
        carrier = traceCarrier();
      });
    });

    await withCarrier(carrier, async () => {
      await inSpan(telemetry.tracer, 'export.build', {}, async () => {});
    });

    await telemetry.shutdown();

    const spans = readFileSync(path, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as SpanRecord);

    const request = spans.find((span) => span.name === 'export.request')!;
    const build = spans.find((span) => span.name === 'export.build')!;

    expect(request.attributes['hela.correlation_id']).toBe('hela_dddddddddddddddd');
    expect(request.attributes['hela.project_id']).toBe('p1');
    expect(request.status).toBe('ok');
    // The point of the whole exercise: one trace id spanning two processes.
    expect(build.traceId).toBe(request.traceId);
    expect(build.parentSpanId).toBe(request.spanId);
  });

  it('marks a span that threw, and lets the error through', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hela-trace-')), 'spans.ndjson');
    const telemetry = startTelemetry({ serviceName: 'worker', tracePath: path });

    await expect(
      inSpan(telemetry.tracer, 'export.build', {}, async () => {
        throw new Error('that scene could not be read');
      }),
    ).rejects.toThrow('that scene could not be read');

    await telemetry.shutdown();

    const span = JSON.parse(readFileSync(path, 'utf8').trim()) as SpanRecord;
    expect(span.status).toBe('error');
    expect(span.message).toBe('that scene could not be read');
  });
});
