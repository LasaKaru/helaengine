import { formatOutcome, runCheck, type HeaderCheck, type HeaderOutcome } from './headers.js';

/**
 * `pnpm headers` — what the running services actually say about caching.
 *
 *   API_ORIGIN=http://127.0.0.1:3000 ASSET_CHECK_PATH=/assets/<hash>.glb pnpm headers
 *
 * Exits non-zero on a wrong header, so a change that quietly turns a year-long cache into
 * `no-store` — costing every user every asset on every load, and showing up as nothing worse than
 * "the editor feels slow lately" — fails a build instead.
 *
 * `ASSET_CHECK_PATH` has to name an asset that really exists, and the tool refuses to run without
 * one rather than falling back to a path it knows will 404. The first version of this did exactly
 * that, reasoning that the header is set before the body is looked up — it is not, the route
 * answers 404 first — and the check failed for a reason that had nothing to do with caching. A
 * check that can pass or fail for reasons other than the thing it names is worse than no check.
 */

const origin = process.env['API_ORIGIN'] ?? 'http://127.0.0.1:3000';
const assetPath = process.env['ASSET_CHECK_PATH'] ?? '';

if (assetPath === '') {
  console.error(
    'Set ASSET_CHECK_PATH to a real asset URL path on this origin, e.g.\n' +
      '  ASSET_CHECK_PATH=/assets/ab12cd34.glb pnpm headers\n' +
      'Upload one through the editor, or copy a path out of the asset manifest.',
  );
  process.exit(1);
}

/**
 * The routes that serve bytes, and what each one owes a cache.
 *
 * The HEAD check is not a duplicate of the GET one. HEAD is how a cache revalidates and how most
 * monitoring probes ask whether a URL is alive, and it takes a different branch through the router
 * — which is precisely how it came to answer 401 on a deliberately public path while GET was fine.
 */
const CHECKS: HeaderCheck[] = [
  { name: 'content-addressed asset (GET)', path: assetPath, expect: 'immutable' },
  {
    name: 'content-addressed asset (HEAD)',
    path: assetPath,
    expect: 'immutable',
    method: 'HEAD',
  },
];

const outcomes: HeaderOutcome[] = [];

const health = await fetch(`${origin}/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No API at ${origin}. Start it, then run this again.`);
  process.exit(1);
}

console.log(`Cache headers on ${origin}\n`);

for (const check of CHECKS) {
  const outcome = await runCheck(origin, check);
  outcomes.push(outcome);
  console.log(formatOutcome(outcome));
}

const failed = outcomes.filter((outcome) => !outcome.passed);
console.log(
  failed.length === 0
    ? `\nAll ${outcomes.length} checks passed.`
    : `\n${failed.length} of ${outcomes.length} checks failed.`,
);
process.exit(failed.length === 0 ? 0 : 1);
