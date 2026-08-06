import { importPack } from './import-pack.js';

/**
 * `pnpm import-pack` — bring a third-party asset pack into `raw-assets`.
 *
 *   pnpm import-pack -- --from /tmp/nature --pack nature-kit \
 *     --author Kenney --license CC0-1.0 --url https://kenney.nl/assets/nature-kit
 *
 * Run `pnpm ingest-assets` afterwards to compress, measure and rebuild the manifest.
 */

const args = process.argv.slice(2);
function flag(name: string, fallback = ''): string {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const options = {
  from: flag('from'),
  pack: flag('pack'),
  author: flag('author'),
  license: flag('license'),
  url: flag('url'),
  dryRun: args.includes('--dry-run'),
};

if (!options.from || !options.pack) {
  console.error(
    'Usage: pnpm import-pack -- --from <dir> --pack <name> --author <who> --license <spdx> --url <where>',
  );
  process.exit(1);
}

try {
  const result = await importPack(options);
  console.log(
    `${options.pack}: imported ${result.imported.length}, skipped ${result.skipped.length} already present.`,
  );
  if (result.skipped.length > 0) {
    console.log(`  kept as they were: ${result.skipped.slice(0, 8).join(', ')}`);
  }
  if (options.dryRun) console.log('  (dry run — nothing written)');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
