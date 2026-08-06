import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBudget, formatResult, measure, type Budget } from './budget.js';

/**
 * The repo root, from this file rather than from `process.cwd()`.
 *
 * `pnpm budget` runs the script with the *package* as its working directory, so a default resolved
 * against cwd would look for `tools/bundle/apps/editor/dist` and report a missing build. An
 * explicit `--dist` is still resolved against cwd, because that is what somebody typing a relative
 * path in a shell means by it.
 */
const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');

/**
 * `pnpm budget` — the editor's critical path, against numbers somebody committed to.
 *
 *   pnpm --filter @helaengine/editor build && pnpm budget
 *   pnpm budget -- --dist apps/editor/dist
 *
 * Exits non-zero when a budget is exceeded, so this belongs in CI. A budget that only prints is a
 * budget that gets exceeded on a Tuesday and noticed the following quarter.
 */

/**
 * The budgets, and why these numbers.
 *
 * **400 KiB of initial JavaScript.** Not an industry figure — the honest justification is that it
 * is roughly where this app is *after* the splitting done in this sprint, plus a little headroom.
 * A budget set to a number the project cannot currently meet is a red build everybody learns to
 * ignore; a budget set at today's number with room to breathe is a ratchet, which is the only thing
 * that reliably keeps bundles from growing. It should come down over time, deliberately.
 *
 * For scale: on a 4G connection at ~1.5 MB/s that is under half a second of transfer, and parse
 * time on a mid-range phone is the larger cost anyway.
 *
 * **30 KiB of CSS**, which is generous for one hand-written stylesheet and will catch the day
 * somebody adds a component library.
 *
 * **900 KiB for the largest lazy chunk**, sized around the physics engine. Lazy does not mean free:
 * this one is downloaded the first time a user presses Play, and there is a point past which that
 * becomes a wait rather than a pause.
 */
export const BUDGET: Budget = {
  initialJs: 400 * 1024,
  initialCss: 30 * 1024,
  largestLazyChunk: 900 * 1024,
};

const args = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const given = flag('dist', '');
const dist = given === '' ? resolve(REPO_ROOT, 'apps/editor/dist') : resolve(process.cwd(), given);

let result;
try {
  result = checkBudget(measure(dist), BUDGET);
} catch (error) {
  console.error(
    `Could not read a build at ${dist}. Run the editor build first.\n  ${String(error)}`,
  );
  process.exit(1);
}

console.log(`Bundle budget for ${dist}\n`);
console.log(formatResult(result));

if (result.over.length === 0) {
  console.log('\nWithin budget.');
  process.exit(0);
}

console.log(`\nOver budget:\n  ${result.over.join('\n  ')}`);
process.exit(1);
