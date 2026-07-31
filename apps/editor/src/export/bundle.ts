import type { AssetManifest, AssetManifestEntry, Scene } from '@helaengine/schema';

export interface ExportOptions {
  /** Used for the folder name inside the zip and the zip filename. */
  projectName: string;
  /** Ship the scene document as a readable, indented file as well as the one the runtime loads. */
  includeSource: boolean;
  /** Minify the generated `main.js`. The engine bundle is already minified either way. */
  minify: boolean;
}

/** One file in the export. `text` and `bytes` are exclusive — a file is one or the other. */
export interface ExportFile {
  path: string;
  text?: string;
  bytes?: Uint8Array;
}

export interface ExportPlan {
  files: ExportFile[];
  /** Assets referenced by the scene and therefore shipped. */
  usedAssetIds: string[];
  /** Assets in the library the scene never mentions, and which are therefore left out. */
  skippedAssetIds: string[];
  /** Anything the author should know: a missing asset, an unsupported feature. */
  warnings: string[];
}

/** The Draco decoder, copied beside the models it decodes. */
const DRACO_FILES = ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'];

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  projectName: 'my-game',
  includeSource: true,
  minify: true,
};

/**
 * Turns a project name into something safe to use as a folder and a filename.
 *
 * Not cosmetic: a project called `../../etc` would otherwise write outside the folder somebody
 * extracted the zip into, and a name with a slash in it produces an archive that different unzip
 * tools disagree about.
 */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'my-game';
}

/**
 * Every asset the scene actually places.
 *
 * The whole point of tree-shaking here is that the library is shared and a project is not: shipping
 * the entire manifest would mean a scene with one hut carrying every tree, rock and goblin the
 * editor has ever known about.
 */
export function collectUsedAssets(scene: Scene, manifest: AssetManifest): {
  used: AssetManifestEntry[];
  usedIds: string[];
  missing: string[];
} {
  const byId = new Map(manifest.assets.map((asset) => [asset.id, asset]));
  const wanted = new Set<string>();

  for (const object of scene.objects) wanted.add(object.assetId);

  // Audio is referenced from `audioConfig` rather than placed, so walking `objects` would miss
  // every sound the game makes.
  const { music, sfx } = scene.audioConfig;
  for (const track of [music.menuTrackAssetId, music.exploreTrackAssetId, music.combatTrackAssetId]) {
    if (track) wanted.add(track);
  }
  for (const binding of sfx) wanted.add(binding.assetId);

  const used: AssetManifestEntry[] = [];
  const missing: string[] = [];
  for (const id of [...wanted].sort()) {
    const entry = byId.get(id);
    if (entry) used.push(entry);
    // Built-in ids (trigger volumes) have no files and are not in a shipped manifest; anything
    // else missing is a real problem the author needs told about.
    else if (!id.startsWith('logic_')) missing.push(id);
  }

  return { used, usedIds: used.map((asset) => asset.id), missing };
}

/** The entry point an exported project runs. Written out rather than bundled, so it stays readable. */
function mainJs(options: ExportOptions): string {
  const source = `import {
  GltfModelSource,
  ManifestAssetResolver,
  SceneLoader,
  Viewport,
} from './engine/runtime.js';

/**
 * A HelaEngine export.
 *
 * This file is yours: it is deliberately short and unminified so you can read it, change it, or
 * throw it away and drive the engine yourself. Everything it uses is exported from
 * ./engine/runtime.js.
 */
const [scene, manifest] = await Promise.all([
  fetch('./scene.json').then((response) => response.json()),
  fetch('./assets/manifest.json').then((response) => response.json()),
]);

const loader = new SceneLoader({
  resolver: new ManifestAssetResolver(manifest),
  modelSource: new GltfModelSource({ baseUrl: './assets/' }),
});

const viewport = new Viewport({ container: document.getElementById('viewport'), loader });

// Built twice, on purpose. The first pass draws immediately from the manifest's bounds, so the
// world is there while the models are still downloading; the second rebuilds it once they have
// arrived. \`load()\` is synchronous and takes whatever is in the model cache at the time, so
// preloading after the only build would fill a cache nothing ever reads — and every object would
// stay a placeholder box.
viewport.setScene(scene);
viewport.frameScene();
viewport.start();

const report = await loader.preload(scene);
if (report.failed.length > 0) console.warn('[helaengine] some assets failed', report.failed);
viewport.setScene(scene);
viewport.frameScene();
`;

  if (!options.minify) return source;

  // A deliberately gentle "minify": comments and blank runs out, structure untouched. Running a
  // real minifier over the one file the user is invited to read would work against the point.
  //
  // Block comments go first, and that ordering is the whole correctness of this function. Removing
  // `*`-prefixed lines beforehand strips the `*/` terminators, which leaves an unclosed `/**` that
  // then swallows everything up to the next one — the export still looked plausible and shipped a
  // `main.js` with its import list deleted.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .concat('\n');
}

function indexHtml(scene: Scene, options: ExportOptions): string {
  const title = escapeHtml(scene.name || options.projectName);
  const background = scene.environment.background;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      html, body { margin: 0; height: 100%; overflow: hidden; background: ${background}; }
      #viewport { width: 100vw; height: 100vh; }
    </style>
  </head>
  <body>
    <div id="viewport"></div>
    <script type="module" src="./main.js"></script>
  </body>
</html>
`;
}

function readme(options: ExportOptions, plan: { assetCount: number; objectCount: number }): string {
  return `# ${options.projectName}

Exported from HelaEngine.

## Running it

This is a static site, but it uses ES modules — which browsers refuse to load over \`file://\`.
Opening \`index.html\` by double-clicking it will show a blank page and a CORS error in the console.
Serve the folder over HTTP instead:

\`\`\`bash
npx serve .
# or
python3 -m http.server 8000
\`\`\`

Then open the address it prints.

## What is in here

\`\`\`
index.html          The page. Edit the title and styling freely.
main.js             Thirty lines that load the scene and start rendering. Yours to change.
scene.json          The world: terrain, objects, environment, game settings.
engine/runtime.js   The HelaEngine runtime, with Three.js bundled in. One file, no dependencies.
assets/             ${plan.assetCount} model${plan.assetCount === 1 ? '' : 's'} and a manifest — only what this scene uses.
${options.includeSource ? 'scene.source.json    The same scene, indented for reading and diffing.\n' : ''}\`\`\`

The scene places ${plan.objectCount} object${plan.objectCount === 1 ? '' : 's'}.

## What this export does not include

This is a **static export**: it renders the world. Behaviours, physics, menus, the HUD and sound
are not started here — that is a later export mode, not a limitation of the runtime, and the same
\`engine/runtime.js\` contains all of it.

## Assets

Everything under \`assets/\` is compressed output. \`manifest.json\` maps every \`assetId\` in
\`scene.json\` to a file, which is why the scene never contains a path: move or rename the files and
fix the manifest, and the scene keeps working.
`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface BuildExportInput {
  scene: Scene;
  manifest: AssetManifest;
  options: ExportOptions;
  /** The built engine bundle, as text. The editor reads it from its own build output. */
  runtimeSource: string;
  /** Fetches an asset file by its manifest-relative path. */
  readAsset(path: string): Promise<Uint8Array>;
}

/**
 * Everything an exported project needs, as a list of files.
 *
 * A plan rather than a zip, and that separation is what makes the whole thing testable: this
 * function has no JSZip, no `fetch` it did not ask for and no DOM, so what it produces can be
 * asserted on directly rather than by unzipping something.
 *
 * Paths are relative throughout — `./scene.json`, `./assets/…`. An export is a folder somebody
 * extracts wherever they like and serves from whatever root they like, so an absolute path is
 * always wrong, and it is wrong in the way that only shows up on somebody else's machine.
 */
export async function buildExport(input: BuildExportInput): Promise<ExportPlan> {
  const { scene, manifest, options, runtimeSource, readAsset } = input;
  const warnings: string[] = [];
  const { used, usedIds, missing } = collectUsedAssets(scene, manifest);

  for (const id of missing) {
    warnings.push(`asset "${id}" is referenced by the scene but not in the manifest — it will be a placeholder`);
  }

  const files: ExportFile[] = [
    { path: 'index.html', text: indexHtml(scene, options) },
    { path: 'main.js', text: mainJs(options) },
    { path: 'engine/runtime.js', text: runtimeSource },
    // The runtime parses this, so it goes out compact. The readable copy is a separate file.
    { path: 'scene.json', text: JSON.stringify(scene) },
    {
      path: 'assets/manifest.json',
      // A manifest listing only what shipped. One that still advertised the whole library would
      // send the loader looking for files that are not there.
      text: JSON.stringify({ version: 1, assets: used }, null, 2),
    },
  ];

  if (options.includeSource) {
    files.push({ path: 'scene.source.json', text: JSON.stringify(scene, null, 2) });
  }

  for (const asset of used) {
    for (const path of [asset.glbPath, asset.audioPath, asset.thumbnailPath]) {
      if (!path) continue;
      try {
        files.push({ path: `assets/${path}`, bytes: await readAsset(path) });
      } catch {
        // One unreadable file should not cost somebody their whole export; the manifest still
        // names it and the loader falls back to a placeholder.
        warnings.push(`could not read "${path}" for asset "${asset.id}"`);
      }
    }
  }

  // Every ingested GLB is Draco-compressed, and the decoder is a separate pair of files the
  // loader fetches at runtime. Leaving them out produces an export whose models silently never
  // appear — the single most confusing possible failure.
  if (used.some((asset) => asset.glbPath)) {
    for (const file of DRACO_FILES) {
      try {
        files.push({ path: `assets/draco/${file}`, bytes: await readAsset(`draco/${file}`) });
      } catch {
        warnings.push(`could not read the Draco decoder file "${file}" — models may not load`);
      }
    }
  }

  files.push({
    path: 'README.md',
    text: readme(options, { assetCount: used.length, objectCount: scene.objects.length }),
  });

  const skippedAssetIds = manifest.assets
    .map((asset) => asset.id)
    .filter((id) => !usedIds.includes(id));

  return { files, usedAssetIds: usedIds, skippedAssetIds, warnings };
}
