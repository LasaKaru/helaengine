import type { IncomingMessage } from 'node:http';

/**
 * Rate limiting for the endpoints where guessing is the attack (Sprint 34).
 *
 * `SignupRequestSchema` says, in a comment, that the real defence against weak passwords is "the
 * hash and the rate limit". The hash was there; the rate limit was not — so a login endpoint backed
 * by scrypt would happily answer as fast as scrypt could run, forever. That is OWASP A07, and it is
 * the one finding from this sprint's review that needed code rather than a test.
 *
 * **This is per process, in memory.** Two API instances behind a load balancer give an attacker
 * twice the budget, and a restart clears it. A distributed limiter belongs in Redis — which this
 * product already runs — and that is the honest upgrade path. It is not done here because a
 * half-shared limiter (some counters in Redis, some in memory) is harder to reason about than
 * either, and the single-instance case is the one that exists today. Recorded in `docs/SECURITY.md`
 * rather than left for somebody to discover.
 */

export interface ThrottleOptions {
  /** How many attempts are allowed in the window. */
  limit: number;
  windowMs: number;
  /** Beyond this many distinct keys, the oldest are dropped — see the note in `check`. */
  maxKeys?: number;
  now?: () => number;
}

export interface ThrottleResult {
  allowed: boolean;
  /** What to put in `Retry-After`, in seconds. Zero when allowed. */
  retryAfterSeconds: number;
}

export class Throttle {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #maxKeys: number;
  readonly #now: () => number;
  /** Insertion-ordered, which is what makes the eviction below "oldest first" for free. */
  readonly #hits = new Map<string, number[]>();

  constructor(options: ThrottleOptions) {
    this.#limit = options.limit;
    this.#windowMs = options.windowMs;
    this.#maxKeys = options.maxKeys ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Records an attempt and says whether it is allowed.
   *
   * A sliding window rather than a fixed one: a fixed window lets an attacker fire the whole budget
   * at 59.9s and the whole budget again at 60.1s, which is twice the intended rate at exactly the
   * moment it matters.
   */
  check(key: string): ThrottleResult {
    const now = this.#now();
    const cutoff = now - this.#windowMs;

    const recent = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= this.#limit) {
      this.#hits.set(key, recent);
      const oldest = recent[0]!;
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.#windowMs - now) / 1000)),
      };
    }

    recent.push(now);
    // Re-inserted rather than mutated in place, so this key becomes the newest in iteration order
    // and the eviction below removes genuinely idle keys rather than active ones.
    this.#hits.delete(key);
    this.#hits.set(key, recent);

    /**
     * A bound on the map itself.
     *
     * Without one, the rate limiter is a memory exhaustion vector: an attacker sends one request
     * each from a million addresses and the process holds a million arrays forever. Dropping the
     * oldest entries loses some history under that exact attack, which is the right trade — the
     * alternative is falling over.
     */
    while (this.#hits.size > this.#maxKeys) {
      const oldest = this.#hits.keys().next().value;
      if (oldest === undefined) break;
      this.#hits.delete(oldest);
    }

    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Forgets a key. Called after a *successful* login, so a legitimate typo costs nothing later. */
  clear(key: string): void {
    this.#hits.delete(key);
  }
}

/**
 * Who to count against.
 *
 * `X-Forwarded-For` is trusted **only** when `TRUST_PROXY` is set, and that default is the whole
 * point: a header the client controls is a rate-limit bypass with a bogus value in it, and it is a
 * log-poisoning vector besides. A deployment behind a load balancer opts in; a deployment reachable
 * directly must not.
 */
export function clientAddress(
  request: IncomingMessage,
  trustProxy = process.env['TRUST_PROXY'],
): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? 'unknown';
}
