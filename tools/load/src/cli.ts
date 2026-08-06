import { writeFileSync } from 'node:fs';
import { formatOutcome, judge, summarise, type Outcome } from './measure.js';
import {
  autosave,
  CONCURRENCY,
  listProjects,
  openProject,
  prepare,
  submitExport,
  TARGETS,
  type LoadOptions,
} from './scenarios.js';

/**
 * `pnpm load` — the API under a realistic number of people.
 *
 *   API_ORIGIN=http://127.0.0.1:3000 pnpm load
 *   pnpm load -- --requests 2000 --concurrency 100
 *   pnpm load -- --json report.json
 *
 * Exits non-zero when a target is missed, so this can gate a release rather than only inform one.
 * The API must be started with generous auth rate limits, or the run's own sign-ups are refused —
 * which is the rate limiter working, and is why the failure says so in as many words.
 */

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const options: LoadOptions = {
  origin: process.env['API_ORIGIN'] ?? 'http://127.0.0.1:3000',
  requests: Number(flag('requests', '600')),
  concurrency: Number(flag('concurrency', String(CONCURRENCY))),
};

const health = await fetch(`${options.origin}/health`).catch(() => null);
if (!health?.ok) {
  console.error(`No API at ${options.origin}. Start it, then run this again.`);
  process.exit(1);
}

console.log(
  `Loading ${options.origin} — ${options.requests} requests per scenario, ` +
    `${options.concurrency} in flight.\n`,
);

// One account per concurrent session, so the run looks like that many people rather than one person
// with a very fast mouse — and so the per-organisation locks are contended the way they really are.
const accounts = await prepare({ ...options, accounts: options.concurrency });

const outcomes: Outcome[] = [];

for (const [key, run] of [
  ['projectList', listProjects],
  ['projectRead', openProject],
  ['autosave', autosave],
  ['exportSubmit', submitExport],
] as const) {
  const { samples, wallClockMs } = await run(options, accounts);
  const outcome = judge(TARGETS[key]!, summarise(samples, wallClockMs));
  outcomes.push(outcome);
  console.log(formatOutcome(outcome));
}

const jsonPath = flag('json', '');
if (jsonPath !== '') {
  writeFileSync(
    jsonPath,
    `${JSON.stringify(
      {
        at: new Date().toISOString(),
        origin: options.origin,
        requests: options.requests,
        concurrency: options.concurrency,
        outcomes,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nWritten to ${jsonPath}`);
}

const failed = outcomes.filter((outcome) => !outcome.passed);
console.log(
  failed.length === 0
    ? `\nAll ${outcomes.length} targets met.`
    : `\n${failed.length} of ${outcomes.length} targets missed.`,
);
process.exit(failed.length === 0 ? 0 : 1);
