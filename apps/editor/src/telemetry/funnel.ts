import {
  FunnelEventSchema,
  parseFunnelRecord,
  type FunnelEvent,
  type FunnelProperties,
  type FunnelRecord,
} from '@helaengine/schema';

/**
 * The funnel, recorded behind a port.
 *
 * Same shape as the billing provider from Sprint 35, for the same reason: **there is no analytics
 * account here.** PostHog is the plan's suggestion and this repository cannot sign up for it, so
 * the choice was a hard dependency on a service nobody can exercise, or a port with a local adapter
 * that runs and is tested. `PostHogSink` exists, has never sent a request, and says so.
 *
 * The interesting property is that the *call sites* — place an object, save, export — do not know
 * which sink they are talking to and never will. Swapping in a real vendor is one line in
 * `configureFunnel`, and nothing in the editor changes.
 */

export interface FunnelSink {
  /** Never throws and never blocks the caller. Analytics must not be able to break the editor. */
  record(record: FunnelRecord): void;
}

/** Discards everything. The default, and what runs in tests and in the e2e suite. */
export class NoAnalytics implements FunnelSink {
  record(): void {
    /* deliberately nothing */
  }
}

/**
 * Keeps events in memory and, optionally, in `localStorage`.
 *
 * What actually runs in development. It exists so the funnel can be *seen* without a vendor — the
 * dev API exposes `funnel()` and the drop-off table can be computed from real usage in this browser.
 * That turns "we integrated analytics" from a claim into something anyone can check in a minute.
 */
export class LocalAnalytics implements FunnelSink {
  readonly #key = 'helaengine.funnel';
  readonly #max: number;
  #records: FunnelRecord[] = [];

  constructor(max = 500) {
    this.#max = max;
    try {
      const stored = localStorage.getItem(this.#key);
      // Parsed rather than cast: this is data from a previous version of the app, which is exactly
      // as untrusted as data from a file. One bad row must not poison the whole history.
      if (stored) {
        this.#records = (JSON.parse(stored) as unknown[])
          .map((row) => {
            try {
              return parseFunnelRecord(row);
            } catch {
              return null;
            }
          })
          .filter((row): row is FunnelRecord => row !== null);
      }
    } catch {
      this.#records = [];
    }
  }

  record(record: FunnelRecord): void {
    this.#records.push(record);
    // Bounded, because this is a debugging aid living in a storage quota shared with the projects
    // somebody actually cares about.
    if (this.#records.length > this.#max) this.#records.splice(0, this.#records.length - this.#max);
    try {
      localStorage.setItem(this.#key, JSON.stringify(this.#records));
    } catch {
      /* over quota, or private browsing. The in-memory copy still works for this session. */
    }
  }

  all(): FunnelRecord[] {
    return [...this.#records];
  }

  clear(): void {
    this.#records = [];
    try {
      localStorage.removeItem(this.#key);
    } catch {
      /* nothing to clear */
    }
  }
}

/**
 * The PostHog adapter.
 *
 * **This has never sent a request.** There is no PostHog project here, so it is written to the
 * documented capture endpoint and left unexercised, exactly like `StripeBilling`. Recording that
 * plainly is worth more than a passing test built on a mock of somebody else's API, which would
 * prove only that the mock matches the code that was written against it.
 *
 * `keepalive` is the one detail worth arguing for: the most interesting event in a funnel is often
 * the last one before somebody closes the tab, and a normal fetch is cancelled at unload.
 */
export class PostHogSink implements FunnelSink {
  readonly #host: string;
  readonly #key: string;

  constructor(options: { host: string; projectKey: string }) {
    this.#host = options.host.replace(/\/$/, '');
    this.#key = options.projectKey;
  }

  record(record: FunnelRecord): void {
    void fetch(`${this.#host}/capture/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        api_key: this.#key,
        event: record.event,
        distinct_id: record.anonymousId,
        timestamp: record.at,
        properties: record.properties,
      }),
      // A funnel is not worth an error in somebody's console, let alone a broken save.
    }).catch(() => undefined);
  }
}

/**
 * A per-browser id, minted once.
 *
 * Not the user id and not derived from one. A funnel needs to know whether these five events came
 * from the same person; it does not need to know who that person is, and an id that can be joined
 * back to an account is one subpoena away from being an id that identifies somebody.
 */
const ANONYMOUS_KEY = 'helaengine.anonymous_id';

export function anonymousId(): string {
  try {
    const existing = localStorage.getItem(ANONYMOUS_KEY);
    if (existing && existing.length >= 8) return existing;
    const minted = `anon_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
    localStorage.setItem(ANONYMOUS_KEY, minted);
    return minted;
  } catch {
    // Storage refused. A per-session id still links the steps of *this* visit, which is most of
    // the value, and it disappears when the tab does.
    return `anon_${Math.random().toString(36).slice(2).padEnd(16, '0').slice(0, 16)}`;
  }
}

let sink: FunnelSink = new NoAnalytics();
const sessionStarted = Date.now();

/** Swaps the sink. The one line that changes when a real vendor arrives. */
export function configureFunnel(next: FunnelSink): void {
  sink = next;
}

/** For the dev API and for tests. */
export function currentSink(): FunnelSink {
  return sink;
}

/**
 * Records a funnel milestone.
 *
 * Validated on the way out, so a typo is a caught error in development rather than a hole in a
 * chart six months later. Everything is wrapped: **analytics must never be able to break the
 * editor**, so a bad event is dropped and the caller carries on.
 */
export function track(event: FunnelEvent, properties: FunnelProperties = {}): void {
  try {
    const record = parseFunnelRecord({
      event: FunnelEventSchema.parse(event),
      anonymousId: anonymousId(),
      at: new Date().toISOString(),
      properties: { sinceSessionStartMs: Date.now() - sessionStarted, ...properties },
    });
    sink.record(record);
  } catch (error) {
    console.warn('[helaengine] dropped a funnel event', error);
  }
}

/**
 * Records a milestone at most once per browser.
 *
 * Every step in this funnel is a *first* — first project, first object placed, first save. Sending
 * `object_placed` on every drop would make the placement step wider than the create step above it,
 * and a funnel that widens is a funnel nobody believes.
 */
const FIRST_KEY = 'helaengine.funnel.first';

export function trackFirst(event: FunnelEvent, properties: FunnelProperties = {}): void {
  try {
    const seen = new Set<string>(JSON.parse(localStorage.getItem(FIRST_KEY) ?? '[]') as string[]);
    if (seen.has(event)) return;
    seen.add(event);
    localStorage.setItem(FIRST_KEY, JSON.stringify([...seen]));
  } catch {
    // Without storage there is no way to know whether this is the first. Recording it is the
    // better failure: a slightly wide step beats a missing one.
  }
  track(event, properties);
}
