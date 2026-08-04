import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExport, DEFAULT_EXPORT_OPTIONS, type ExportMode } from '@helaengine/export';
import { parseAssetManifest, type Scene } from '@helaengine/schema';

/**
 * Builds a real export into a private staging folder.
 *
 * "Real" is the important word: this calls the same `buildExport` the editor's Export button calls,
 * with the same asset library and the same engine bundle. A harness that tested a hand-assembled
 * approximation of an export would be testing the approximation — and the failure modes worth
 * catching (a decoder that did not ship, a path that only works in the editor) live exactly in the
 * gap between the two.
 *
 * It is also why this exists at all rather than the harness taking only folders: the gate has to be
 * able to build what it tests, because the pipeline it belongs to does.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../..');

/** Where `pnpm ingest-assets` puts the library. Generated output, never committed. */
const LIBRARY = join(REPO, 'generated/assets');

const RUNTIME: Record<ExportMode, string> = {
  static: join(REPO, 'packages/engine/dist/runtime.js'),
  game: join(REPO, 'packages/engine/dist/runtime-full.js'),
};

export interface StageOptions {
  mode?: ExportMode;
  /** Deleted and rebuilt if it already exists, so a stale build cannot pass for a fresh one. */
  into: string;
}

export async function stageExport(scene: Scene, options: StageOptions): Promise<string> {
  const mode = options.mode ?? 'game';
  const manifest = parseAssetManifest(
    JSON.parse(await readFile(join(LIBRARY, 'manifest.json'), 'utf8')),
  );
  const runtimeSource = await readFile(RUNTIME[mode], 'utf8');

  const plan = await buildExport({
    scene,
    manifest,
    options: { ...DEFAULT_EXPORT_OPTIONS, mode, projectName: scene.name },
    runtimeSource,
    readAsset: async (path) => new Uint8Array(await readFile(join(LIBRARY, path))),
  });

  const root = resolve(options.into);
  await rm(root, { recursive: true, force: true });

  for (const file of plan.files) {
    const target = join(root, file.path);
    await mkdir(dirname(target), { recursive: true });
    if (file.bytes) await writeFile(target, file.bytes);
    else await writeFile(target, file.text ?? '', 'utf8');
  }

  return root;
}

/** Whether the generated asset library and engine builds this needs are actually present. */
export async function stagingIsReady(): Promise<string | null> {
  for (const path of [join(LIBRARY, 'manifest.json'), RUNTIME.static, RUNTIME.game]) {
    try {
      await readFile(path);
    } catch {
      return path;
    }
  }
  return null;
}
