import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { behaviorRegistry, registerBuiltinBehaviors } from '@helaengine/engine';
import { documentBehaviours, renderMarkdown, type BehaviourSource } from './behaviours.js';

/**
 * `pnpm gen-docs` — regenerate the behaviour reference from the engine's schemas.
 *
 *   pnpm gen-docs       # write docs/BEHAVIOURS.md
 *   pnpm gen-docs -- --check  # fail if it is out of date, for CI
 *
 * `--check` is the part that makes this worth building. A generator nobody runs produces a stale
 * page with a "generated" header on it, which is a hand-written page wearing a disguise — and
 * strictly worse, because the header invites trust the content has not earned.
 */

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..');
const OUTPUT = resolve(REPO_ROOT, 'docs/BEHAVIOURS.md');

registerBuiltinBehaviors();

const sources: BehaviourSource[] = behaviorRegistry.list().map((definition) => ({
  type: definition.type,
  label: definition.label,
  description: definition.description,
  params: definition.params,
}));

if (sources.length === 0) {
  console.error('No behaviours registered — the reference would be empty. Refusing to write it.');
  process.exit(1);
}

const markdown = renderMarkdown(documentBehaviours(sources));

if (process.argv.includes('--check')) {
  const current = (() => {
    try {
      return readFileSync(OUTPUT, 'utf8');
    } catch {
      return '';
    }
  })();

  if (current !== markdown) {
    console.error(
      'docs/BEHAVIOURS.md is out of date with the engine schemas. Run `pnpm gen-docs` and commit the result.',
    );
    process.exit(1);
  }

  console.log(`docs/BEHAVIOURS.md is up to date (${sources.length} behaviours).`);
  process.exit(0);
}

writeFileSync(OUTPUT, markdown);
console.log(`Wrote docs/BEHAVIOURS.md — ${sources.length} behaviours.`);
