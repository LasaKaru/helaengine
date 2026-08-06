import { describe, expect, it } from 'vitest';
import { judge, percentile, runAtConcurrency, summarise, type Sample } from './measure.js';

/**
 * The statistics, tested.
 *
 * A load tool whose numbers are wrong is worse than no load tool: it produces a figure everybody
 * quotes and nobody re-derives. These are the three things that could be quietly wrong — the
 * percentile, the treatment of failures, and whether the concurrency is real.
 */

function samples(durations: number[], failures = 0): Sample[] {
  return durations.map((duration, index) => ({
    duration,
    ok: index >= failures,
    status: index >= failures ? 200 : 500,
  }));
}

describe('percentiles', () => {
  it('returns a value that was actually observed', () => {
    // Nearest-rank, not interpolation: a p95 of 213ms when nothing took 213ms is a number nobody
    // can go and find in a log.
    const sorted = [10, 20, 30, 40, 50];
    expect(sorted).toContain(percentile(sorted, 0.95));
    expect(percentile(sorted, 0.5)).toBe(30);
    expect(percentile(sorted, 1)).toBe(50);
  });

  it('does not fall over on an empty run', () => {
    expect(percentile([], 0.95)).toBe(0);
  });

  it('takes the top value for p95 of a small sample', () => {
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
  });
});

describe('summarising', () => {
  it('counts failures rather than dropping them', () => {
    // Dropping errors is how a broken system reports a beautiful p95.
    const stats = summarise(samples([100, 200, 300], 1), 1000);
    expect(stats.count).toBe(3);
    expect(stats.failed).toBe(1);
  });

  it('includes failed requests in the timings', () => {
    // A request that failed after 5 seconds took 5 seconds, and hiding that flatters the tail.
    const stats = summarise(samples([50, 50, 5000], 1), 1000);
    expect(stats.max).toBe(5000);
    expect(stats.p99).toBe(5000);
  });

  it('reports throughput against wall-clock time', () => {
    expect(summarise(samples([10, 10, 10, 10]), 2000).throughput).toBe(2);
  });
});

describe('running at a concurrency', () => {
  it('keeps exactly that many in flight, rather than firing everything at once', async () => {
    // The whole validity of the measurement: two thousand requests at once measures how long a
    // queue takes to drain, not how a server behaves under fifty users.
    let inFlight = 0;
    let peak = 0;

    await runAtConcurrency(
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((done) => setTimeout(done, 5));
        inFlight -= 1;
        return { duration: 5, ok: true, status: 200 };
      },
      { total: 40, concurrency: 4 },
    );

    expect(peak).toBeLessThanOrEqual(4);
  });

  it('does exactly the number of requests asked for', async () => {
    let done = 0;
    const { samples: taken } = await runAtConcurrency(
      async () => {
        done += 1;
        return { duration: 1, ok: true, status: 200 };
      },
      { total: 17, concurrency: 5 },
    );
    expect(done).toBe(17);
    expect(taken).toHaveLength(17);
  });
});

describe('judging against a target', () => {
  const target = { name: 'reads', p95Ms: 300 };

  it('passes when the p95 is inside and nothing failed', () => {
    expect(judge(target, summarise(samples([100, 150, 200]), 1000)).passed).toBe(true);
  });

  it('fails on the p95, and says by how much', () => {
    const outcome = judge(target, summarise(samples([100, 100, 900]), 1000));
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons.join(' ')).toContain('900ms is over the 300ms target');
  });

  it('fails on errors even when it is fast', () => {
    // Fast and broken is not a pass.
    const outcome = judge(target, summarise(samples([10, 10], 1), 1000));
    expect(outcome.passed).toBe(false);
    expect(outcome.reasons.join(' ')).toContain('failed');
  });

  it('fails a run that made no requests at all', () => {
    // Otherwise a scenario that crashed before starting reports as a pass, which is the worst
    // possible way for a gate to be wrong.
    expect(judge(target, summarise([], 0)).passed).toBe(false);
  });
});
