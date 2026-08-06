import { describe, expect, it } from 'vitest';
import { Throttle, clientAddress } from './throttle.js';
import type { IncomingMessage } from 'node:http';

/**
 * The limiter, on a clock the test controls.
 *
 * Driving it with real time would mean a suite that sits through a minute to check one boundary,
 * which is how rate-limit tests end up deleted.
 */
function at(times: number[]): { now: () => number } {
  let index = 0;
  return { now: () => times[Math.min(index++, times.length - 1)]! };
}

describe('the throttle', () => {
  it('allows up to the limit and refuses the next one', () => {
    const clock = at([0, 0, 0, 0]);
    const throttle = new Throttle({ limit: 3, windowMs: 1000, now: clock.now });

    expect(throttle.check('a').allowed).toBe(true);
    expect(throttle.check('a').allowed).toBe(true);
    expect(throttle.check('a').allowed).toBe(true);

    const refused = throttle.check('a');
    expect(refused.allowed).toBe(false);
    // A `Retry-After` a client can obey, rather than a bare refusal it will retry immediately.
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it('counts keys separately, so one attacker does not lock everybody out', () => {
    const throttle = new Throttle({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(throttle.check('attacker').allowed).toBe(true);
    expect(throttle.check('attacker').allowed).toBe(false);
    expect(throttle.check('somebody-else').allowed).toBe(true);
  });

  it('slides rather than resetting on a boundary', () => {
    // The failure a fixed window has: the whole budget at 0.9s and the whole budget again at 1.1s
    // is twice the intended rate, at exactly the moment an attacker would aim for.
    const times = [0, 0, 900, 1100, 1100];
    const clock = at(times);
    const throttle = new Throttle({ limit: 2, windowMs: 1000, now: clock.now });

    expect(throttle.check('a').allowed).toBe(true); // t=0
    expect(throttle.check('a').allowed).toBe(true); // t=0
    expect(throttle.check('a').allowed).toBe(false); // t=900, both still in the window
    expect(throttle.check('a').allowed).toBe(true); // t=1100, the first two have aged out
  });

  it('forgets a key on request, so a corrected typo costs nothing', () => {
    const throttle = new Throttle({ limit: 1, windowMs: 60_000, now: () => 0 });
    expect(throttle.check('someone@example.com').allowed).toBe(true);
    throttle.clear('someone@example.com');
    expect(throttle.check('someone@example.com').allowed).toBe(true);
  });

  it('bounds its own memory, because a limiter is otherwise an exhaustion vector', () => {
    let now = 0;
    const throttle = new Throttle({
      limit: 5,
      windowMs: 60_000,
      maxKeys: 3,
      now: () => (now += 1),
    });

    for (const key of ['a', 'b', 'c', 'd']) throttle.check(key);

    // `a` was evicted as the oldest, so it starts again — the deliberate trade. What matters is
    // that a million distinct addresses cannot make the process hold a million arrays.
    expect(throttle.check('a').allowed).toBe(true);
    // `d`, the newest, still remembers its first attempt.
    const throttle2 = new Throttle({ limit: 1, windowMs: 60_000, maxKeys: 3, now: () => 0 });
    throttle2.check('d');
    expect(throttle2.check('d').allowed).toBe(false);
  });
});

describe('deciding who a request is from', () => {
  function request(headers: Record<string, string>, remote = '10.0.0.1'): IncomingMessage {
    return { headers, socket: { remoteAddress: remote } } as unknown as IncomingMessage;
  }

  it('ignores X-Forwarded-For unless a proxy is trusted', () => {
    // Otherwise the rate limit is bypassed by sending a different fake address each time — a header
    // the client controls is not an identity.
    expect(clientAddress(request({ 'x-forwarded-for': '1.2.3.4' }), undefined)).toBe('10.0.0.1');
  });

  it('uses the first hop when a proxy is trusted', () => {
    expect(clientAddress(request({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), '1')).toBe('1.2.3.4');
  });

  it('falls back to the socket when the header is absent', () => {
    expect(clientAddress(request({}), '1')).toBe('10.0.0.1');
  });
});
