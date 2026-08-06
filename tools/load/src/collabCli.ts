import { writeFileSync } from 'node:fs';
import {
  formatCollabReport,
  generatorBound,
  judgeCollab,
  prepareRoom,
  runCollabLoad,
  type CollabReport,
} from './collab.js';

/**
 * `pnpm load:collab` — the collaboration server at a given number of editors in one room.
 *
 *   pnpm load:collab -- --connections 50
 *   pnpm load:collab -- --steps 10,25,50,100 --json collab.json
 *
 * `--steps` is the interesting mode and the reason this is a separate CLI from `pnpm load`: the
 * question for a long-lived-connection service is not "does it pass at N" but *where it stops
 * passing*, which needs a ladder rather than a single run. The API tool answers a throughput
 * question; this one answers a ceiling question.
 *
 * Needs both servers: the API to make an account and a project, and the collab server to join.
 */

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const origin = process.env['API_ORIGIN'] ?? 'http://127.0.0.1:3000';
const collabOrigin = process.env['COLLAB_ORIGIN'] ?? 'ws://127.0.0.1:3200';
const edits = Number(flag('edits', '30'));
const steps = flag('steps', flag('connections', '25'))
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

for (const [label, url] of [
  ['API', `${origin}/health`],
  ['collab server', `${collabOrigin.replace(/^ws/, 'http')}/health`],
] as const) {
  const health = await fetch(url).catch(() => null);
  if (!health?.ok) {
    console.error(`No ${label} at ${url}. Start it, then run this again.`);
    process.exit(1);
  }
}

console.log(`Collab load against ${collabOrigin} — steps: ${steps.join(', ')}\n`);

const account = await prepareRoom({ origin, requests: 0, concurrency: 1 });

const reports: CollabReport[] = [];
const failures: string[] = [];

for (const connections of steps) {
  console.log(`${connections} editors in one room:`);
  const report = await runCollabLoad(
    { origin, collabOrigin, requests: 0, concurrency: connections, connections, edits },
    account,
  );
  reports.push(report);
  console.log(formatCollabReport(report));

  const bound = generatorBound(report);
  if (bound !== null) console.log(`  NOTE — ${bound}`);

  const reasons = judgeCollab(report);
  if (reasons.length === 0) {
    console.log('  PASS\n');
  } else {
    failures.push(`${connections} editors: ${reasons.join('; ')}`);
    console.log(`  FAIL — ${reasons.join('; ')}\n`);
  }

  // Sockets are closed by `runCollabLoad`, but the server tears rooms down on its own schedule and
  // a step that starts while the previous one is still unwinding measures the unwinding.
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

const jsonPath = flag('json', '');
if (jsonPath !== '') {
  writeFileSync(
    jsonPath,
    `${JSON.stringify({ at: new Date().toISOString(), collabOrigin, reports }, null, 2)}\n`,
  );
  console.log(`Written to ${jsonPath}`);
}

console.log(
  failures.length === 0
    ? `All ${reports.length} steps met their targets.`
    : `${failures.length} of ${reports.length} steps missed:\n  ${failures.join('\n  ')}`,
);
process.exit(failures.length === 0 ? 0 : 1);
