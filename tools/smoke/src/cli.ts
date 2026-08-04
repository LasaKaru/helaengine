import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isReleasable, type SmokeCheckResult, type SmokeReport } from '@helaengine/schema';
import { runSmokeTest } from './harness.js';

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

  if (!folder) {
    console.error('usage: smoke <export-folder> [--json=report.json]');
    process.exit(2);
  }

  const smoke = await runSmokeTest(resolve(folder), { buildId: folder });
  if (jsonAt) writeFileSync(jsonAt, `${JSON.stringify(smoke, null, 2)}\n`);
  report(smoke);

  process.exit(isReleasable(smoke) ? 0 : 1);
}

await main();
