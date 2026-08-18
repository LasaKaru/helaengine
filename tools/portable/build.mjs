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
import { cpSync, existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
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
// `files/package.json` pins `type: commonjs`, and it is not decoration. `serve.js` uses `require`,
// and Node decides a bare `.js` file's module system from the nearest package.json *up the
// directory tree* — so unzipping this inside any folder that happens to sit under an ESM project
// made it crash with "require is not defined in ES module scope". Found by running the bundle from
// inside this repository, which is exactly such a folder.
cpSync(join(HERE, 'files'), OUT, { recursive: true });

// Vite's build manifest maps every source module to its hashed output. It is for tooling that
// consumes the build, and nothing here consumes it — so it is a description of the source tree
// shipped to strangers for no benefit.
rmSync(join(OUT, '.vite'), { recursive: true, force: true });

/**
 * The step-by-step guide, beside the thing it describes.
 *
 * Somebody who unzips this has an editor and no idea what to do with it, and the answer being "read
 * it on GitHub" is the answer that loses them — the whole point of a portable build is that it
 * works on a machine with nothing set up, which sometimes means a machine with no network either.
 * The guide is one HTML file, a stylesheet, a script and its screenshots, and it opens by
 * double-clicking.
 */
const GUIDE = join(ROOT, 'docs', 'guide');
if (existsSync(GUIDE)) {
  cpSync(GUIDE, join(OUT, 'guide'), { recursive: true });
  console.log('  guide included — open guide/index.html');
} else {
  console.warn('Warning: docs/guide is missing, so the bundle ships without the walkthrough.');
}

/**
 * A Windows Node runtime, when one has been fetched.
 *
 * With it, the bundle has **no prerequisites at all** — unzip, double-click, use it. Without it the
 * recipient needs Node installed, which is one more step and the step most likely to stop somebody
 * who just wanted to look at the thing.
 *
 * Not committed to the repository and not downloaded by this script: an 80 MB binary in git is a
 * repository nobody wants to clone, and a build step that reaches out to the network is a build
 * step that fails on a train. Fetch it once, point `PORTABLE_NODE_EXE` at it, and it gets bundled.
 *
 *   curl -o node.exe https://nodejs.org/dist/v22.11.0/win-x64/node.exe
 *   PORTABLE_NODE_EXE=./node.exe pnpm portable
 */
const runtimeSource = process.env.PORTABLE_NODE_EXE;
let bundledRuntime = false;

if (runtimeSource) {
  if (!existsSync(runtimeSource)) {
    console.error(`PORTABLE_NODE_EXE points at ${runtimeSource}, which does not exist.`);
    process.exit(1);
  }
  mkdirSync(join(OUT, 'runtime'), { recursive: true });
  cpSync(runtimeSource, join(OUT, 'runtime', 'node.exe'));
  bundledRuntime = true;
}

// The read-me must describe *this* bundle. A copy that ships a runtime and still opens with "you
// need Node.js" sends people to an installer they do not need, and the one that ships without a
// runtime and claims otherwise fails at the double-click with no explanation. So the paragraph is
// written at packaging time from what was actually packaged, not maintained by hand.
const readMePath = join(OUT, 'READ-ME-FIRST.txt');
writeFileSync(
  readMePath,
  readFileSync(readMePath, 'utf8').replace(
    '{{PREREQUISITES}}',
    bundledRuntime
      ? [
          'WHAT YOU NEED',
          '  On Windows: nothing. A Node.js runtime is inside this folder, in',
          '  runtime\\node.exe, and START.bat uses it. No installer, no git, no',
          '  pnpm, no npm install, no internet connection.',
          '',
          '  On Mac or Linux: the bundled runtime is a Windows binary, so',
          '  start.sh needs Node.js installed - https://nodejs.org, LTS.',
        ].join('\n')
      : [
          'WHAT YOU NEED',
          '  Node.js, and nothing else. No git, no pnpm, no npm install.',
          '  https://nodejs.org -> the LTS installer -> run it -> accept the',
          '  defaults -> done.',
          '',
          '  IF YOU WOULD RATHER NOT INSTALL ANYTHING',
          '  Download this one file:',
          '    https://nodejs.org/dist/v22.11.0/win-x64/node.exe',
          '  and put it in a folder called  runtime  next to START.bat, so the',
          '  path is  runtime\\node.exe  - START.bat finds it and uses it in',
          '  preference to anything installed. Nothing is installed, nothing is',
          '  changed outside this folder, and deleting the folder removes it all.',
        ].join('\n'),
  ),
);

console.log(`Portable build written to ${OUT}`);
console.log(`  ${manifest.assets.length} assets, ${withThumbnails} with thumbnails`);
console.log(
  bundledRuntime
    ? '  runtime/node.exe bundled — the recipient needs nothing installed'
    : '  no runtime bundled — the recipient needs Node.js (set PORTABLE_NODE_EXE to change that)',
);
