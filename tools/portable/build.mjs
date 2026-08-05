/**
 * Packages the editor as a folder somebody can unzip and run.
 *
 * The point is the *absence* of steps. No clone, no pnpm, no install, no build — unzip, double
 * click, use it. The only prerequisite is Node, which `serve.js` needs and which most people
 * building games already have.
 *
 * This exists as a script rather than as something assembled by hand because a bundle that is put
 * together manually is a bundle that is subtly different every time, and the interesting failures
 * (a missing manifest, thumbnails that were skipped) are exactly the ones nobody notices until
 * somebody else opens it.
 *
 *   pnpm portable
 */
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const DIST = join(ROOT, 'apps', 'editor', 'dist');
const OUT = join(ROOT, 'portable', 'hela-portable');

if (!existsSync(DIST)) {
  console.error('No editor build found. Run `pnpm --filter @helaengine/editor build` first.');
  process.exit(1);
}

const manifestPath = join(DIST, 'assets', 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('The build has no asset manifest. Run `pnpm ingest-assets`, then build again.');
  process.exit(1);
}

// Checked rather than assumed: `SKIP_THUMBNAILS=1` produces a perfectly valid build whose asset
// cards are all flat colour swatches. It looks broken to somebody seeing the editor for the first
// time, and it is silent — so the packaging step is where it gets caught.
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const withThumbnails = manifest.assets.filter((asset) => asset.thumbnailPath).length;
if (withThumbnails === 0) {
  console.warn(
    'Warning: no asset has a thumbnail. The library will show colour swatches.\n' +
      'Re-run `pnpm ingest-assets` without SKIP_THUMBNAILS, then build again.',
  );
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(DIST, OUT, { recursive: true });
cpSync(join(HERE, 'files'), OUT, { recursive: true });

console.log(`Portable build written to ${OUT}`);
console.log(`  ${manifest.assets.length} assets, ${withThumbnails} with thumbnails`);
console.log('');
console.log('Zip the folder and hand it to anybody with Node installed.');
