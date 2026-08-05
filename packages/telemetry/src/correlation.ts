import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

/**
 * The correlation id: one string that follows a single user action everywhere it goes.
 *
 * A trace id would nearly do this job, and the tracing in `tracing.ts` carries one. The reason
 * there is a second identifier is that a trace id is only useful to somebody holding a tracing
 * backend, while a correlation id is useful to somebody holding a log file, a support email, or a
 * screenshot of an error dialog. It is deliberately short, readable and safe to paste into a
 * ticket — "the export that failed was `hela_9f3c…`" is a sentence a user can say.
 *
 * It rides through the system on three different vehicles, because each hop has its own rules:
 *
 *   browser → API      an `x-correlation-id` request header
 *   API → worker       a field on the BullMQ job payload, because a queue has no headers
 *   anywhere → logs    an `AsyncLocalStorage` store, so a log line deep in a call stack does not
 *                      need the id threaded through six function signatures to say who it is about
 */

export const CORRELATION_HEADER = 'x-correlation-id';

/** What a correlation id is allowed to look like. Everything else is replaced, not sanitised. */
const SHAPE = /^[A-Za-z0-9_-]{8,64}$/;

export function newCorrelationId(): string {
  return `hela_${randomBytes(8).toString('hex')}`;
}

/**
 * Takes the caller's id, or mints one.
 *
 * The strictness is the point. This value ends up in log lines, span attributes and metric
 * exemplars, all of which are read by machines and pasted into queries by people — so an id
 * carrying a newline, a quote or four kilobytes of anything is a log-injection vector and a broken
 * dashboard. A caller who sends something outside the shape is not refused (their request is fine,
 * this is diagnostics) — they simply get a fresh id and their own is dropped.
 */
export function acceptCorrelationId(incoming: string | string[] | undefined): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming;
  return typeof value === 'string' && SHAPE.test(value) ? value : newCorrelationId();
}

interface Store {
  correlationId: string;
}

const storage = new AsyncLocalStorage<Store>();

/** Runs `body` with a correlation id that every log line and span inside it will pick up. */
export function withCorrelation<T>(correlationId: string, body: () => T): T {
  return storage.run({ correlationId }, body);
}

/** The id of the work in hand, or `null` outside any correlated work (startup, shutdown, a cron). */
export function currentCorrelationId(): string | null {
  return storage.getStore()?.correlationId ?? null;
}
