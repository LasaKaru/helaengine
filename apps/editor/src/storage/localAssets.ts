import {
  AssetCategorySchema,
  type AssetCategory,
  type AssetManifestEntry,
} from '@helaengine/schema';
import { db, type StoredLocalAsset } from './db';
import { inspectModel, ModelInspectionError } from './inspectModel';

/**
 * Models the author imported from their own disk.
 *
 * The gap this closes: until now a custom model could arrive two ways, and neither served somebody
 * building a game on their own machine. Uploading to **My Assets** needs an account and a running
 * API. Models inside a `.hela` file live as blob URLs that die with the tab, so reopening the
 * project showed placeholders. Both are documented limitations rather than oversights — but
 * "install a database before you can use your own tree" is the wrong answer for a local editor.
 *
 * So these live in IndexedDB beside the projects, are measured once at import, and are handed to
 * the resolver as ordinary manifest entries. Everything downstream — placement, physics, the
 * animation panel, the export — treats them exactly like a shipped asset, because by the time they
 * reach it they are one.
 */

/**
 * Ceiling on one imported model.
 *
 * IndexedDB will hold much more. The limit is about what the *export* can survive: everything is
 * assembled in browser memory before the zip is written, and a tab that runs out of memory
 * mid-export gives no useful error at all. Refusing a 200 MB model at import is kinder than
 * discovering it when somebody tries to ship.
 */
export const MAX_LOCAL_ASSET_BYTES = 64 * 1024 * 1024;

/**
 * Triangle count above which the import warns.
 *
 * Not a refusal: somebody importing a hero character legitimately wants more geometry than a rock,
 * and a hard limit here would be this tool deciding what game they are making. The number is where
 * a low-poly scene stops being low-poly, so the warning is information rather than an obstacle.
 */
export const POLY_WARN = 20_000;

export class LocalAssetError extends Error {}

export interface ImportOptions {
  category?: AssetCategory;
  license?: string;
  author?: string;
  sourceUrl?: string;
}

export interface ImportResult {
  asset: StoredLocalAsset;
  /** Things worth saying that did not stop the import. */
  warnings: string[];
  /** `0.01` when the model looks like it was authored in centimetres. */
  suggestedScale: number | null;
}

/** Object URLs, cached so a model is not re-materialised on every render. */
const urls = new Map<string, string>();
const listeners = new Set<() => void>();
let entries: AssetManifestEntry[] = [];

function announce(): void {
  for (const listener of listeners) listener();
}

export function subscribeToLocalAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function localAssetEntries(): AssetManifestEntry[] {
  return entries;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/\.[^.]+$/, '')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 48) || 'model'
  );
}

/** A stable object URL for a stored model, created on first use. */
function urlFor(asset: StoredLocalAsset): string {
  const existing = urls.get(asset.id);
  if (existing) return existing;
  const url = URL.createObjectURL(asset.data);
  urls.set(asset.id, url);
  return url;
}

/**
 * A stored model as a manifest entry.
 *
 * `glbPath` is an absolute `blob:` URL, which the engine's `joinUrl` passes through untouched and
 * which the exporter now rewrites to a real path inside the zip. Both of those were needed before
 * this could work at all.
 */
export function toManifestEntry(asset: StoredLocalAsset): AssetManifestEntry {
  const category = AssetCategorySchema.safeParse(asset.category);
  return {
    id: asset.id,
    name: asset.name,
    category: category.success ? category.data : 'props',
    // Tagged so the library panel can group them and a test can find them.
    tags: ['imported'],
    glbPath: urlFor(asset),
    defaultScale: [1, 1, 1],
    colliderType: 'box',
    polyCount: asset.polyCount,
    bounds: asset.bounds,
    animations: asset.animations,
    skinned: asset.skinned,
    // Empty for a row imported before the measurement existed, which reads as "unmeasured" — the
    // same thing it means everywhere else it defaults.
    materialMaps: (asset.materialMaps ?? []) as AssetManifestEntry['materialMaps'],
    placeholderColor: '#8a7ca8',
    ...(asset.license ? { license: asset.license } : {}),
    ...(asset.author ? { author: asset.author } : {}),
    ...(asset.sourceUrl ? { sourceUrl: asset.sourceUrl } : {}),
    // The author warrants they have the rights; this records what it was told, which is the same
    // thing the cloud upload path does.
    origin: 'customer',
  };
}

/** Loads what is stored and publishes it. Call once at startup. */
export async function refreshLocalAssets(): Promise<AssetManifestEntry[]> {
  const stored = await db.localAssets.orderBy('createdAt').reverse().toArray();
  entries = stored.map(toManifestEntry);
  announce();
  return entries;
}

/**
 * Imports one file.
 *
 * Measured before it is stored, so a file that cannot be parsed is refused with its own name in
 * the message rather than accepted and discovered later as a grey box in somebody's level.
 */
export async function importLocalAsset(
  file: File,
  options: ImportOptions = {},
): Promise<ImportResult> {
  if (!/\.(glb|gltf)$/i.test(file.name)) {
    throw new LocalAssetError(
      `${file.name} is not a glTF model. Import a .glb or .gltf file — Blender exports one with ` +
        'File → Export → glTF 2.0. FBX and OBJ have to be converted first.',
    );
  }
  if (file.size > MAX_LOCAL_ASSET_BYTES) {
    throw new LocalAssetError(
      `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ` +
        `${MAX_LOCAL_ASSET_BYTES / 1024 / 1024} MB, because an export is assembled in the ` +
        "browser's memory and a much larger one fails with no useful error.",
    );
  }

  const buffer = await file.arrayBuffer();
  let report;
  try {
    report = await inspectModel(buffer, file.name);
  } catch (error) {
    if (error instanceof ModelInspectionError) throw new LocalAssetError(error.message);
    throw error;
  }

  const warnings: string[] = [];
  if (report.polyCount > POLY_WARN) {
    warnings.push(
      `${report.polyCount.toLocaleString()} triangles is a lot for a low-poly scene. It will work; ` +
        'a few of these in one level will not.',
    );
  }
  if (report.baseOffset < -0.05) {
    warnings.push(
      `The model's origin is ${Math.abs(report.baseOffset).toFixed(2)} above its lowest point, so ` +
        'it will float when placed on the ground. Set the origin at the base before exporting.',
    );
  }
  if (report.suggestedScale) {
    warnings.push(
      `This model is ${Math.max(...report.bounds).toFixed(0)} units across, so it was probably ` +
        'authored in centimetres. Scale it to 0.01 after placing, or re-export it in metres.',
    );
  }

  const asset: StoredLocalAsset = {
    id: `local_${slug(file.name)}`,
    name: file.name.replace(/\.[^.]+$/, ''),
    category: options.category ?? 'props',
    mimeType: file.type || 'model/gltf-binary',
    bytes: file.size,
    data: file,
    polyCount: report.polyCount,
    bounds: report.bounds,
    animations: report.animations,
    skinned: report.skinned,
    materialMaps: report.materialMaps,
    ...(options.license ? { license: options.license } : {}),
    ...(options.author ? { author: options.author } : {}),
    ...(options.sourceUrl ? { sourceUrl: options.sourceUrl } : {}),
    createdAt: Date.now(),
  };

  await db.localAssets.put(asset);
  // Re-importing the same filename replaces it. The old bytes must stop being served, or the
  // library shows the new name against the old model.
  releaseUrl(asset.id);
  await refreshLocalAssets();

  return { asset, warnings, suggestedScale: report.suggestedScale };
}

export async function listLocalAssets(): Promise<StoredLocalAsset[]> {
  return db.localAssets.orderBy('createdAt').reverse().toArray();
}

export async function deleteLocalAsset(id: string): Promise<void> {
  await db.localAssets.delete(id);
  releaseUrl(id);
  await refreshLocalAssets();
}

/** The bytes of one stored model, for writing into a `.hela` file. */
export async function localAssetBytes(id: string): Promise<Uint8Array | null> {
  const asset = await db.localAssets.get(id);
  if (!asset) return null;
  return new Uint8Array(await asset.data.arrayBuffer());
}

function releaseUrl(id: string): void {
  const url = urls.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  urls.delete(id);
}

/** Frees every object URL. For tests and teardown. */
export function releaseLocalAssetUrls(): void {
  for (const id of [...urls.keys()]) releaseUrl(id);
}
