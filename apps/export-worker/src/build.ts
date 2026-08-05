import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import JSZip from 'jszip';
import { buildExport, DEFAULT_EXPORT_OPTIONS, slugify, type ExportPlan } from '@helaengine/export';
import { parseAssetManifest, type AssetManifest, type Scene } from '@helaengine/schema';

/**
 * Building an export, server-side.
 *
 * The interesting thing here is how little of it there is. `packages/export` was written in Sprint
 * 21 with no DOM, no `fetch` it did not ask for and no JSZip — it takes a `readAsset` callback and
 * returns a list of files — so moving the work off the browser needed no second implementation.
 * That was not luck; it is what the "plan rather than a zip" split in `bundle.ts` was for, and this
 * is the sprint that collects on it.
 *
 * So the editor and the worker run **the same bundler**. A server export and a browser export of
 * the same project produce the same files, which is the only way a user could ever trust the two
 * to be interchangeable.
 */

export interface AssetSource {
  /** The curated manifest, as the ingest pipeline wrote it. */
  manifest: AssetManifest;
  /** Reads a manifest-relative path — `models/tree_pine_01.glb`, `draco/draco_decoder.wasm`. */
  readAsset(path: string): Promise<Uint8Array>;
  /** The built engine bundle, as text. */
  runtimeSource(): Promise<string>;
}

/**
 * The generated asset library and the engine build, from disk.
 *
 * Both are *generated* output that this repository deliberately does not commit, so a worker that
 * cannot find them is a worker that was deployed without its build step. Saying that plainly beats
 * producing exports full of placeholder boxes.
 */
export class LocalAssetSource implements AssetSource {
  readonly manifest: AssetManifest;
  readonly #assetRoot: string;
  readonly #runtimePath: string;

  private constructor(manifest: AssetManifest, assetRoot: string, runtimePath: string) {
    this.manifest = manifest;
    this.#assetRoot = assetRoot;
    this.#runtimePath = runtimePath;
  }

  static async load(options: {
    assetRoot: string;
    runtimePath: string;
  }): Promise<LocalAssetSource> {
    const assetRoot = resolve(options.assetRoot);
    const manifestPath = join(assetRoot, 'manifest.json');

    if (!existsSync(manifestPath)) {
      throw new Error(
        `No asset manifest at ${manifestPath}. Run \`pnpm ingest-assets\` before starting the worker.`,
      );
    }
    if (!existsSync(options.runtimePath)) {
      throw new Error(
        `No engine bundle at ${options.runtimePath}. Run \`pnpm --filter @helaengine/engine build\`.`,
      );
    }

    const manifest = parseAssetManifest(JSON.parse(await readFile(manifestPath, 'utf8')));
    return new LocalAssetSource(manifest, assetRoot, resolve(options.runtimePath));
  }

  async readAsset(path: string): Promise<Uint8Array> {
    const target = join(this.#assetRoot, path);
    // A manifest is generated output rather than user input, but it is still a path from a file
    // being turned into a filesystem read, and the check costs nothing.
    if (!target.startsWith(this.#assetRoot)) {
      throw new Error(`asset path "${path}" escapes the asset root`);
    }
    return new Uint8Array(await readFile(target));
  }

  async runtimeSource(): Promise<string> {
    return readFile(this.#runtimePath, 'utf8');
  }
}

export interface BuiltExport {
  zip: Uint8Array;
  plan: ExportPlan;
  folder: string;
}

/**
 * Builds and zips a project.
 *
 * `onStage` exists because this takes long enough that a user is watching a bar. The stages are the
 * real phases rather than a timer pretending to be one — see `ExportStage` in the schema for why a
 * fabricated percentage is worse than a coarse honest one.
 */
export async function buildAndZip(
  input: {
    scene: Scene;
    projectName: string;
    source: AssetSource;
  },
  onStage?: (stage: 'loading' | 'building' | 'compressing') => Promise<void> | void,
): Promise<BuiltExport> {
  await onStage?.('loading');
  const runtimeSource = await input.source.runtimeSource();

  await onStage?.('building');
  const plan = await buildExport({
    scene: input.scene,
    manifest: input.source.manifest,
    options: { ...DEFAULT_EXPORT_OPTIONS, projectName: input.projectName },
    runtimeSource,
    readAsset: (path) => input.source.readAsset(path),
  });

  await onStage?.('compressing');
  const folder = slugify(input.projectName);
  const zip = new JSZip();
  // Everything inside one folder, so unzipping into a downloads directory produces one tidy thing
  // rather than scattering `index.html` and an `assets/` across whatever was already there.
  const root = zip.folder(folder)!;

  for (const file of plan.files) {
    if (file.bytes) root.file(file.path, file.bytes, { binary: true });
    else root.file(file.path, file.text ?? '');
  }

  const bytes = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    // A middling level on purpose. This is a *download*, not something stored forever, and the
    // difference between 6 and 9 is single-digit percentages of size for a large multiple of the
    // CPU — which on a shared worker is time somebody else's job spends waiting.
    compressionOptions: { level: 6 },
  });

  return { zip: bytes, plan, folder };
}
