import type { AssetManifest, AssetManifestEntry, Scene } from '@helaengine/schema';
import { mainJs, type CodeStyle, type ExportMode } from './mainJs.js';

export interface ExportOptions {
  /** Used for the folder name inside the zip and the zip filename. */
  projectName: string;
  /** `static` draws the world; `game` starts physics, behaviours, menus and sound. */
  mode: ExportMode;
  /** Whether `main.js` also writes the level out as literal calls. Cosmetic; see `mainJs.ts`. */
  codeStyle: CodeStyle;
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
  /** Total uncompressed size. The zip will be smaller; this is what the browser has to hold. */
  totalBytes: number;
  /** Assets referenced by the scene and therefore shipped. */
  usedAssetIds: string[];
  /** Assets in the library the scene never mentions, and which are therefore left out. */
  skippedAssetIds: string[];
  /** Anything the author should know: a missing asset, an unsupported feature. */
  warnings: string[];
}

/**
 * Sizes worth saying something about, uncompressed.
 *
 * The soft warning is where a build stops being pleasant to host — most static hosts and most
 * people's patience run out somewhere around here. The hard one is where the *export itself* is
 * at risk: everything is assembled in browser memory before the zip is written, and a tab that
 * runs out of memory mid-export gives no useful error at all.
 */
export const SIZE_WARN_BYTES = 150 * 1024 * 1024;
export const SIZE_DANGER_BYTES = 400 * 1024 * 1024;

/** The Draco decoder, copied beside the models it decodes. */
const DRACO_FILES = ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js'];

export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  projectName: 'my-game',
  mode: 'game',
  codeStyle: 'document',
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
export function collectUsedAssets(
  scene: Scene,
  manifest: AssetManifest,
): {
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
  for (const track of [
    music.menuTrackAssetId,
    music.exploreTrackAssetId,
    music.combatTrackAssetId,
  ]) {
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
main.js             ${options.mode === 'game' ? 'The game loop' : 'Thirty lines that load the scene and start rendering'}. Yours to change.
scene.json          The world: terrain, objects, environment, game settings.
engine/runtime.js   The HelaEngine runtime, with Three.js bundled in. One file, no dependencies.
assets/             ${plan.assetCount} model${plan.assetCount === 1 ? '' : 's'} and a manifest — only what this scene uses.
${options.includeSource ? 'scene.source.json    The same scene, indented for reading and diffing.\n' : ''}\`\`\`

The scene places ${plan.objectCount} object${plan.objectCount === 1 ? '' : 's'}.

${
  options.mode === 'game'
    ? 'Press Play on the home screen. WASD moves, Shift sprints, C crouches, Space jumps, click\nfires, R reloads, Q swaps weapon, V changes camera, Escape pauses.'
    : ''
}

${
  options.mode === 'game'
    ? `## Serving it correctly

Two notes about WebAssembly, because getting either wrong fails quietly.

The physics engine is **inside** \`engine/runtime.js\` — the \`rapier3d-compat\` build encodes its
WebAssembly as base64 in the JavaScript, which is most of why that file is three megabytes. There
is no separate \`.wasm\` file for physics and nothing to configure for it.

The model decoder is a different story: \`assets/draco/draco_decoder.wasm\` is a real file, and
browsers refuse to compile one served with the wrong content type. \`npx serve\` and
\`python3 -m http.server\` both get this right. If you deploy somewhere that does not, make sure
\`.wasm\` is served as \`application/wasm\` — the symptom is a world where every model is a plain
grey box.
`
    : `## What this export does not include

This is a **static export**: it renders the world. Behaviours, physics, menus, the HUD and sound
are not started here — that is the other export mode, not a limitation of the runtime, and the same
\`engine/runtime.js\` contains all of it.
`
}
## Troubleshooting

**A blank page, and a CORS error in the console.** You opened \`index.html\` from disk. Browsers
refuse to load ES modules over \`file://\`. Serve the folder — see above.

**Every model is a plain grey box.** The Draco decoder failed to load. It is
\`assets/draco/draco_decoder.wasm\`, and browsers refuse to compile a WebAssembly module served
with the wrong content type. Configure your host to send \`.wasm\` as \`application/wasm\`.

**404s for everything under \`assets/\`.** The folder was served from the wrong root. Every path in
this export is relative to \`index.html\`, so serve the folder that contains it, not its parent.

**Nothing loads and the console mentions CORS on your own files.** Some hosts serve a bare
directory without the right headers. Any ordinary static host works; \`npx serve\` and
\`python3 -m http.server\` both do.

**The game shows its menu and then does nothing.** Only applies to a game export: the physics
engine failed to start. It is bundled inside \`engine/runtime.js\` rather than fetched separately,
so this is almost always a browser without WebAssembly enabled.

## Assets

Everything under \`assets/\` is compressed output. \`manifest.json\` maps every \`assetId\` in
\`scene.json\` to a file, which is why the scene never contains a path: move or rename the files and
fix the manifest, and the scene keeps working.
`;
}

/**
 * Attribution for every asset that shipped.
 *
 * Generated from the manifest rather than written by hand, because the one thing an attribution
 * file must never be is out of date with what is actually in the folder. Assets with no recorded
 * licence are listed as such rather than omitted — a gap somebody can see is worth more than a
 * tidy file that quietly leaves things out.
 */
function credits(options: ExportOptions, used: AssetManifestEntry[]): string {
  const rows = used.map((asset) => {
    const parts = [`- **${asset.name}** (\`${asset.id}\`)`];
    if (asset.author) parts.push(`by ${asset.author}`);
    parts.push(asset.license ? `— ${asset.license}` : '— licence not recorded');
    if (asset.sourceUrl) parts.push(`<${asset.sourceUrl}>`);
    return parts.join(' ');
  });

  return `# Credits

## ${options.projectName}

Made with [HelaEngine](https://github.com/LasaKaru/helaengine).

## Engine

The runtime in \`engine/\` is HelaEngine, MIT licensed, and bundles:

- [Three.js](https://threejs.org) — MIT
- [Zod](https://zod.dev) — MIT
${options.mode === 'game' ? '- [Rapier](https://rapier.rs) — Apache-2.0\n- [Yuka](https://mugen87.github.io/yuka/) — MIT\n- [Howler.js](https://howlerjs.com) — MIT\n' : ''}
## Assets

${rows.length > 0 ? rows.join('\n') : '_No assets shipped with this export._'}
`;
}

/** A licence file for the author's own work, with the parts only they can fill in left blank. */
function licence(options: ExportOptions): string {
  return `# License

## Your project

${options.projectName} — © ${new Date().getFullYear()} <your name here>.

Choose a licence for your own work and replace this section. Nothing in HelaEngine requires you to
pick one, and nothing here restricts what you pick.

## The engine

The HelaEngine runtime bundled in \`engine/\` is MIT licensed:

\`\`\`
Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
\`\`\`

Third-party licences for what the runtime bundles are listed in CREDITS.md.
`;
}

/** Bytes in the units a person reads. Shared by the export plan and the wizard. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
    warnings.push(
      `asset "${id}" is referenced by the scene but not in the manifest — it will be a placeholder`,
    );
  }

  const files: ExportFile[] = [
    { path: 'index.html', text: indexHtml(scene, options) },
    {
      path: 'main.js',
      text: mainJs({
        scene,
        mode: options.mode,
        style: options.codeStyle,
        minify: options.minify,
      }),
    },
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
  files.push({ path: 'CREDITS.md', text: credits(options, used) });
  files.push({ path: 'LICENSE.md', text: licence(options) });

  const skippedAssetIds = manifest.assets
    .map((asset) => asset.id)
    .filter((id) => !usedIds.includes(id));

  const totalBytes = files.reduce(
    (sum, file) => sum + (file.bytes ? file.bytes.byteLength : new Blob([file.text ?? '']).size),
    0,
  );

  if (totalBytes >= SIZE_DANGER_BYTES) {
    warnings.push(
      `this export is ${formatBytes(totalBytes)} before compression, which may exhaust the ` +
        `browser's memory while the archive is written. Consider splitting the scene.`,
    );
  } else if (totalBytes >= SIZE_WARN_BYTES) {
    warnings.push(
      `this export is ${formatBytes(totalBytes)} before compression. Most static hosts and most ` +
        `players' patience run out well before that.`,
    );
  }

  return { files, totalBytes, usedAssetIds: usedIds, skippedAssetIds, warnings };
}
