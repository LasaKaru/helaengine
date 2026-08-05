/**
 * Metrics, in Prometheus' exposition format, written by hand.
 *
 * `prom-client` would have done this, and skipping it is a choice worth defending: what a scrape
 * endpoint has to produce is a few hundred lines of text in a format that has not changed in a
 * decade, and the entire surface this product needs is three instrument types. Against that, a
 * dependency in every service's dependency tree, with its own opinions about default metrics and
 * global registries. The same argument the rest of this repo makes about frameworks.
 *
 * What it costs, honestly: no exemplars, no native histograms, no `process_*` collectors for free.
 * If any of those become load-bearing, take the dependency — this file is ninety lines and deleting
 * it will not hurt.
 */

export type Labels = Record<string, string>;

interface Spec {
  name: string;
  help: string;
  /** Declared up front so every sample of a metric has the same label names, as the format requires. */
  labelNames?: readonly string[];
}

/**
 * Buckets in **seconds**, which is Prometheus' convention and not merely a preference: dashboards,
 * alert expressions and every example in the documentation assume base units, and a histogram in
 * milliseconds silently makes `histogram_quantile` results wrong by a factor of a thousand.
 *
 * The spread is wide on purpose. An API request that answers in 5 ms and an export that takes four
 * minutes are both measured here, and a bucket set tuned to one of them is blind to the other.
 */
export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;
export const JOB_BUCKETS = [0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600] as const;

abstract class Metric {
  readonly name: string;
  readonly help: string;
  readonly labelNames: readonly string[];

  constructor(spec: Spec) {
    this.name = spec.name;
    this.help = spec.help;
    this.labelNames = spec.labelNames ?? [];
  }

  abstract type(): string;
  abstract samples(): string[];

  /**
   * One metric's block, or nothing.
   *
   * A metric nobody has touched yet emits no lines at all rather than a bare `HELP`/`TYPE` pair.
   * Both are legal, but a header with no samples reads on a dashboard as "this is zero" when what
   * it means is "this has never happened", and those are different facts.
   */
  render(): string {
    const samples = this.samples();
    if (samples.length === 0) return '';
    return [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} ${this.type()}`,
      ...samples,
    ].join('\n');
  }

  /**
   * The key a label set is stored under, and the text written beside the sample.
   *
   * Labels are emitted in the order they were *declared*, not the order they were passed, so the
   * same label set always produces the same series key. Left to insertion order, `{method,route}`
   * and `{route,method}` would be two time series describing one thing.
   */
  protected key(labels: Labels): string {
    const pairs = this.labelNames
      .map((name) => `${name}="${escapeLabel(labels[name] ?? '')}"`)
      .join(',');
    return pairs === '' ? '' : `{${pairs}}`;
  }
}

export class Counter extends Metric {
  readonly #values = new Map<string, number>();

  type(): string {
    return 'counter';
  }

  increment(labels: Labels = {}, by = 1): void {
    const key = this.key(labels);
    this.#values.set(key, (this.#values.get(key) ?? 0) + by);
  }

  /** The current total for one label set. For tests and for the odd internal check; scrapes use `render`. */
  get(labels: Labels = {}): number {
    return this.#values.get(this.key(labels)) ?? 0;
  }

  samples(): string[] {
    return [...this.#values].map(([key, value]) => `${this.name}${key} ${value}`);
  }
}

export class Gauge extends Metric {
  readonly #values = new Map<string, number>();
  readonly #collect?: () => void;

  constructor(spec: Spec & { collect?: () => void }) {
    super(spec);
    // Called at scrape time rather than on a timer. A gauge of something already known — pool
    // size, queue depth — should be read when somebody asks, not sampled into a variable that is
    // then stale by however long the timer's period is.
    if (spec.collect) this.#collect = spec.collect;
  }

  set(value: number, labels: Labels = {}): void {
    this.#values.set(this.key(labels), value);
  }

  samples(): string[] {
    this.#collect?.();
    return [...this.#values].map(([key, value]) => `${this.name}${key} ${value}`);
  }

  type(): string {
    return 'gauge';
  }
}

export class Histogram extends Metric {
  readonly #buckets: readonly number[];
  readonly #counts = new Map<string, number[]>();
  readonly #sums = new Map<string, number>();
  readonly #totals = new Map<string, number>();

  constructor(spec: Spec & { buckets?: readonly number[] }) {
    super(spec);
    this.#buckets = [...(spec.buckets ?? HTTP_BUCKETS)].sort((a, b) => a - b);
  }

  observe(value: number, labels: Labels = {}): void {
    const key = this.key(labels);
    const counts = this.#counts.get(key) ?? new Array<number>(this.#buckets.length).fill(0);
    for (let index = 0; index < this.#buckets.length; index += 1) {
      if (value <= this.#buckets[index]!) counts[index] = counts[index]! + 1;
    }
    this.#counts.set(key, counts);
    this.#sums.set(key, (this.#sums.get(key) ?? 0) + value);
    this.#totals.set(key, (this.#totals.get(key) ?? 0) + 1);
  }

  type(): string {
    return 'histogram';
  }

  samples(): string[] {
    const lines: string[] = [];
    for (const [key, counts] of this.#counts) {
      const inner = key.slice(1, -1);
      const withLe = (le: string): string => `{${inner === '' ? '' : `${inner},`}le="${le}"}`;
      for (let index = 0; index < this.#buckets.length; index += 1) {
        lines.push(`${this.name}_bucket${withLe(String(this.#buckets[index]))} ${counts[index]}`);
      }
      // `+Inf` is mandatory, and it is the observation count rather than the last bucket: a value
      // above every boundary belongs to no bucket but is still an observation.
      lines.push(`${this.name}_bucket${withLe('+Inf')} ${this.#totals.get(key) ?? 0}`);
      lines.push(`${this.name}_sum${key} ${this.#sums.get(key) ?? 0}`);
      lines.push(`${this.name}_count${key} ${this.#totals.get(key) ?? 0}`);
    }
    return lines;
  }
}

/**
 * Everything one process exposes.
 *
 * An instance rather than a module-level singleton, because tests need a registry each and two
 * suites sharing counters is a test that passes alone and fails in a run. Each service builds its
 * own in `serviceMetrics()`.
 */
export class Registry {
  readonly #metrics: Metric[] = [];

  counter(spec: Spec): Counter {
    return this.#add(new Counter(spec));
  }

  gauge(spec: Spec & { collect?: () => void }): Gauge {
    return this.#add(new Gauge(spec));
  }

  histogram(spec: Spec & { buckets?: readonly number[] }): Histogram {
    return this.#add(new Histogram(spec));
  }

  /** The scrape body. Blank when nothing has been observed yet, which is a valid scrape. */
  render(): string {
    const blocks = this.#metrics.map((metric) => metric.render()).filter((block) => block !== '');
    return blocks.length === 0 ? '' : `${blocks.join('\n\n')}\n`;
  }

  #add<T extends Metric>(metric: T): T {
    this.#metrics.push(metric);
    return metric;
  }
}

export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8';

/** Backslash, quote and newline are the three characters the format cannot carry raw. */
function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
