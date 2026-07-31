import type { AssetManifest, Scene } from '@helaengine/schema';
import { ASSET_BASE_URL } from '../engine/assetLibrary';
import { buildExport, slugify, type ExportOptions, type ExportPlan } from './bundle';
import { downloadZip, zipExport } from './zip';

/**
 * Where the exported engine comes from.
 *
 * The editor cannot build the engine — it is a browser tab. So the *editor's* build produces a
 * self-contained runtime bundle as a static asset, and an export copies it. That is the same file
 * for every export, which is what makes an export reproducible: two people exporting the same scene
 * from the same editor build get byte-identical output.
 */
export const RUNTIME_URL = './engine-runtime.js';

export interface RunExportResult {
  plan: ExportPlan;
  filename: string;
  bytes: number;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return response.text();
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Builds and downloads an export.
 *
 * Thin on purpose: everything that decides *what goes in* lives in `buildExport`, which is a pure
 * function over a scene and a manifest and is therefore testable without a browser. This is the
 * part that can only run in one.
 */
export async function runExport(
  scene: Scene,
  manifest: AssetManifest,
  options: ExportOptions,
): Promise<RunExportResult> {
  const runtimeSource = await fetchText(RUNTIME_URL);
  const plan = await buildExport({
    scene,
    manifest,
    options,
    runtimeSource,
    readAsset: (path) => fetchBytes(`${ASSET_BASE_URL}${path}`),
  });

  const folder = slugify(options.projectName);
  const blob = await zipExport(plan, folder);
  const filename = `${folder}.zip`;
  downloadZip(blob, filename);

  return { plan, filename, bytes: blob.size };
}
