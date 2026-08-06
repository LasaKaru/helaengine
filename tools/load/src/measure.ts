/**
 * Timing a lot of requests, and saying something true about them.
 *
 * The measurement half is separate from the scenarios so it can be unit-tested, because a load tool
 * whose statistics are wrong is worse than no load tool: it produces a number everybody quotes.
 *
 * **k6 was the plan's suggestion and this is not k6.** k6 is a Go binary distributed outside npm,
 * and this environment installs from npm — so the choice was a tool that cannot run here, or a
 * hundred lines that can. What is lost is real: k6's VU model, its thresholds language, its
 * ecosystem of output plugins. What is kept is the part that matters for a pass mark — a fixed
 * concurrency, a percentile, and a documented target to compare against.
 */

export interface Sample {
  /** Milliseconds. */
  duration: number;
  ok: boolean;
  status: number;
}

export interface Stats {
  count: number;
  failed: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  mean: number;
  /** Requests per second across the wall-clock span of the run. */
  throughput: number;
}

/**
 * Percentiles by nearest-rank, on a sorted copy.
 *
 * Nearest-rank rather than interpolation because it always returns a value that was actually
 * observed. An interpolated p95 of 213 ms when no request took 213 ms is a number nobody can go and
 * find in a log, which matters when somebody is trying to reproduce it.
 */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]!;
}

export function summarise(samples: readonly Sample[], wallClockMs: number): Stats {
  const durations = samples.map((sample) => sample.duration).sort((a, b) => a - b);
  const failed = samples.filter((sample) => !sample.ok).length;

  return {
    count: samples.length,
    failed,
    p50: percentile(durations, 0.5),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
    min: durations[0] ?? 0,
    max: durations[durations.length - 1] ?? 0,
    mean:
      durations.length === 0
        ? 0
        : durations.reduce((sum, value) => sum + value, 0) / durations.length,
    throughput: wallClockMs === 0 ? 0 : (samples.length / wallClockMs) * 1000,
  };
}

/**
 * Runs `work` at a fixed concurrency until `total` have been done.
 *
 * A worker pool rather than `Promise.all` over the whole batch, and the difference is the entire
 * validity of the measurement: firing two thousand requests at once measures how long a queue takes
 * to drain, not how the server behaves at a concurrency anybody would actually see. Fifty in flight,
 * continuously, is what fifty users look like.
 */
export async function runAtConcurrency(
  work: (index: number) => Promise<Sample>,
  options: { total: number; concurrency: number },
): Promise<{ samples: Sample[]; wallClockMs: number }> {
  const samples: Sample[] = [];
  let next = 0;
  const started = performance.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= options.total) return;
      samples.push(await work(index));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(options.concurrency, options.total) }, () => worker()),
  );

  return { samples, wallClockMs: performance.now() - started };
}

/** One timed request. Errors are samples too — a run that drops failures reports a flattering p95. */
export async function timed(request: () => Promise<Response>): Promise<Sample> {
  const started = performance.now();
  try {
    const response = await request();
    // The body is drained even when it is not read: leaving it unconsumed keeps the socket busy and
    // the next request in the pool waits on it, which shows up as latency the server never caused.
    await response.arrayBuffer();
    return { duration: performance.now() - started, ok: response.ok, status: response.status };
  } catch {
    return { duration: performance.now() - started, ok: false, status: 0 };
  }
}

export interface Target {
  /** What this scenario is called in the report. */
  name: string;
  /** The p95 it must come in under, in milliseconds. */
  p95Ms: number;
  /** How many failures are tolerated, as a fraction. Usually zero. */
  errorRate?: number;
}

export interface Outcome {
  target: Target;
  stats: Stats;
  passed: boolean;
  reasons: string[];
}

export function judge(target: Target, stats: Stats): Outcome {
  const reasons: string[] = [];
  const allowedErrors = target.errorRate ?? 0;
  const errorRate = stats.count === 0 ? 1 : stats.failed / stats.count;

  if (stats.count === 0) reasons.push('no requests were made');
  if (stats.p95 > target.p95Ms) {
    reasons.push(`p95 ${stats.p95.toFixed(0)}ms is over the ${target.p95Ms}ms target`);
  }
  if (errorRate > allowedErrors) {
    reasons.push(
      `${(errorRate * 100).toFixed(1)}% failed, over the ${(allowedErrors * 100).toFixed(1)}% allowed`,
    );
  }

  return { target, stats, passed: reasons.length === 0, reasons };
}

export function formatOutcome(outcome: Outcome): string {
  const { stats, target } = outcome;
  const mark = outcome.passed ? 'PASS' : 'FAIL';
  const line =
    `${mark}  ${target.name.padEnd(28)} ` +
    `n=${String(stats.count).padStart(5)}  ` +
    `p50=${stats.p50.toFixed(0).padStart(5)}ms  ` +
    `p95=${stats.p95.toFixed(0).padStart(5)}ms  ` +
    `p99=${stats.p99.toFixed(0).padStart(5)}ms  ` +
    `${stats.throughput.toFixed(0).padStart(4)}/s  ` +
    `${stats.failed} failed`;

  return outcome.passed ? line : `${line}\n      ${outcome.reasons.join('; ')}`;
}
