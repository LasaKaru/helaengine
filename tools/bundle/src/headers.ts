/**
 * Cache headers, checked against a running server rather than read off the source.
 *
 * The sprint plan asks to "verify the cache headers from Sprint 30 are actually effective" and to
 * read a CDN's hit ratio. There is no CDN here to read, and that limit is recorded rather than
 * papered over — but the half that *is* checkable is the half that decides the hit ratio in the
 * first place: an origin that answers `no-store` will have a zero percent hit rate no matter how
 * good the CDN is, and no dashboard will tell you why.
 *
 * Reading the header off the source would prove nothing. Headers are set on a code path, and the
 * question is what a real response carries after every middleware, proxy and error branch has had
 * its turn. So these run against a live origin.
 */

export type Caching =
  /** Content-addressed. Cache forever, everywhere. */
  | 'immutable'
  /** Cacheable for a while by anyone. */
  | 'shared-short'
  /** Never stored — the URL outlives what it serves, or the body is private. */
  | 'no-store';

export interface HeaderCheck {
  name: string;
  /** Path relative to the origin. */
  path: string;
  expect: Caching;
  /** Defaults to GET. HEAD takes a different branch through most routers, so it is worth asking. */
  method?: 'GET' | 'HEAD';
  /** Status codes that still count as a meaningful answer. Defaults to 200 alone. */
  acceptStatuses?: number[];
}

export interface HeaderOutcome {
  check: HeaderCheck;
  status: number;
  cacheControl: string | null;
  passed: boolean;
  reason: string | null;
}

/**
 * What each policy has to say, as a predicate rather than an exact string.
 *
 * Exact-match would fail the day somebody adds `stale-while-revalidate`, which is an improvement,
 * and that is the sort of false alarm that gets a check deleted. What is asserted is the part that
 * carries the meaning: `immutable` must be public, long and immutable; `no-store` must actually
 * forbid storing rather than merely ask for revalidation, because `no-cache` still writes the body
 * to disk and this is the header standing between an expired export and a copy of it in a proxy.
 */
export function judgeCaching(policy: Caching, header: string | null): string | null {
  const value = (header ?? '').toLowerCase();
  if (value === '') return 'no cache-control header at all';

  switch (policy) {
    case 'immutable': {
      const maxAge = /max-age=(\d+)/.exec(value);
      if (!value.includes('public')) return `expected public, got "${header}"`;
      if (!value.includes('immutable')) return `expected immutable, got "${header}"`;
      // A year is the longest any cache is meant to honour, and content-addressed bytes have no
      // reason to ask for less.
      if (!maxAge || Number(maxAge[1]) < 31_536_000) {
        return `expected max-age of a year, got "${header}"`;
      }
      return null;
    }
    case 'shared-short': {
      const maxAge = /max-age=(\d+)/.exec(value);
      if (!value.includes('public')) return `expected public, got "${header}"`;
      if (!maxAge || Number(maxAge[1]) <= 0) return `expected a positive max-age, got "${header}"`;
      return null;
    }
    case 'no-store': {
      if (!value.includes('no-store')) return `expected no-store, got "${header}"`;
      return null;
    }
  }
}

export async function runCheck(origin: string, check: HeaderCheck): Promise<HeaderOutcome> {
  const accept = check.acceptStatuses ?? [200];
  let response: Response;
  try {
    response = await fetch(`${origin}${check.path}`, {
      method: check.method ?? 'GET',
      redirect: 'manual',
    });
  } catch (error) {
    return {
      check,
      status: 0,
      cacheControl: null,
      passed: false,
      reason: `could not reach ${origin}${check.path}: ${String(error)}`,
    };
  }

  const cacheControl = response.headers.get('cache-control');
  // The body is drained so the socket is reusable; a check that leaks connections becomes flaky
  // once there are enough checks to exhaust the pool.
  await response.arrayBuffer();

  if (!accept.includes(response.status)) {
    return {
      check,
      status: response.status,
      cacheControl,
      passed: false,
      reason: `answered ${response.status}, expected one of ${accept.join(', ')}`,
    };
  }

  const reason = judgeCaching(check.expect, cacheControl);
  return { check, status: response.status, cacheControl, passed: reason === null, reason };
}

export function formatOutcome(outcome: HeaderOutcome): string {
  const mark = outcome.passed ? 'PASS' : 'FAIL';
  const line =
    `${mark}  ${outcome.check.name.padEnd(34)} ` +
    `${String(outcome.status).padStart(3)}  ${outcome.cacheControl ?? '(none)'}`;
  return outcome.passed ? line : `${line}\n      ${outcome.reason}`;
}
