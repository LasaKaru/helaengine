import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  describeRepairs,
  isReleasable,
  parseScene,
  type SmokeCheckResult,
  type SmokeReport,
} from '@helaengine/schema';
import { runSmokeTest } from './harness.js';
import { repairLoop } from './loop.js';

/**
 * `pnpm smoke <folder>` — plays a build and says whether it may be handed to anybody.
 *
 * Exit code is the verdict: 0 releasable, 1 not. That is what makes this usable as a gate in a
 * pipeline rather than a report somebody has to read and interpret.
 */

const MARK: Record<SmokeCheckResult['status'], string> = {
  passed: '  ok  ',
  failed: ' FAIL ',
  skipped: ' skip ',
  'not-applicable': '  n/a ',
};

function report(smoke: SmokeReport): void {
  console.log(`\n${smoke.sceneName} — ${(smoke.durationMs / 1000).toFixed(1)}s\n`);
  for (const check of smoke.checks) {
    console.log(`[${MARK[check.status]}] ${check.id.padEnd(22)} ${check.detail}`);
  }

  if (smoke.errors.length > 0) {
    console.log(`\n${smoke.errors.length} error(s) captured from the page:`);
    for (const error of smoke.errors.slice(0, 10)) {
      console.log(`  ${error.source}: ${error.message}${error.url ? ` (${error.url})` : ''}`);
    }
  }

  console.log(
    `\n${isReleasable(smoke) ? 'PASS — this build may be released.' : 'BLOCKED — this build must not be released.'}\n`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const folder = args.find((arg) => !arg.startsWith('--'));
  const jsonAt = args.find((arg) => arg.startsWith('--json='))?.slice('--json='.length);
  const repair = args.includes('--repair');

  if (!folder) {
    console.error('usage: smoke <export-folder> [--repair] [--json=report.json]');
    process.exit(2);
  }

  const smoke = repair
    ? await repairAndReport(resolve(folder))
    : await runSmokeTest(resolve(folder), { buildId: folder });
  if (jsonAt) writeFileSync(jsonAt, `${JSON.stringify(smoke, null, 2)}\n`);
  report(smoke);

  process.exit(isReleasable(smoke) ? 0 : 1);
}

/**
 * Runs the bounded repair loop over the scene inside an export, and says what it changed.
 *
 * Rebuilt into a sibling folder rather than over the top of the original: a repair is a proposal
 * about somebody's work, and overwriting the thing they gave you while deciding whether the change
 * was any good is not a proposal.
 */
async function repairAndReport(root: string): Promise<SmokeReport> {
  const scene = parseScene(JSON.parse(readFileSync(join(root, 'scene.json'), 'utf8')));
  const result = await repairLoop({ scene, buildId: root, into: `${root}-repaired` });

  const changes = describeRepairs(result.log);
  if (changes.length > 0) {
    // Said before the verdict, and in the user's own terms. Rewriting somebody's level and then
    // congratulating them on a passing build is how a tool spends trust it cannot earn back.
    console.log('\nWe changed your scene automatically:');
    for (const change of changes) console.log(`  • ${change}`);
    console.log(`\nThe repaired build is in ${root}-repaired.`);
  }

  for (const attempt of result.log.attempts) {
    if (attempt.outcome === 'rejected' || attempt.outcome === 'invalid-result') {
      console.log(
        `\nA proposed fix from "${attempt.proposedBy}" was refused: ${attempt.rejection ?? ''}`,
      );
    }
  }

  return result.report;
}

await main();
