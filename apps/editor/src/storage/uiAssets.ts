import { db, type StoredUiAsset } from './db';

/**
 * Ceiling on an uploaded UI asset.
 *
 * IndexedDB will hold far more than this, but a home screen background that takes ten seconds to
 * decode is not a feature, and an intro video measured in hundreds of megabytes would make the
 * eventual export unshippable. Refusing at upload time is kinder than discovering it at export.
 */
export const MAX_UI_ASSET_BYTES = 24 * 1024 * 1024;

const ACCEPTED: Record<string, 'image' | 'video'> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/avif': 'image',
  'video/mp4': 'video',
  'video/webm': 'video',
};

export class UiAssetError extends Error {}

/** Object URLs, cached so the same asset is not re-materialised on every render. */
const urls = new Map<string, string>();

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Stores an uploaded file and returns the id a document should reference.
 *
 * The id is derived from the filename rather than random, so a document that references
 * `ui_title_screen` still reads as something rather than as a UUID — and re-uploading the same
 * file replaces it instead of quietly accumulating copies.
 */
export async function saveUiAsset(file: File): Promise<StoredUiAsset> {
  const kind = ACCEPTED[file.type];
  if (!kind) {
    throw new UiAssetError(
      `${file.type || 'that file type'} is not supported. Use PNG, JPEG, WebP, AVIF, MP4 or WebM.`,
    );
  }
  if (file.size > MAX_UI_ASSET_BYTES) {
    throw new UiAssetError(
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_UI_ASSET_BYTES / 1024 / 1024} MB.`,
    );
  }

  const base = slug(file.name) || kind;
  const record: StoredUiAsset = {
    id: `ui_${base}`,
    name: file.name,
    kind,
    mimeType: file.type,
    bytes: file.size,
    data: file,
    createdAt: Date.now(),
  };

  await db.uiAssets.put(record);
  // A replaced asset must not keep serving the old bytes from a stale object URL.
  releaseUiAssetUrl(record.id);
  return record;
}

export async function listUiAssets(): Promise<StoredUiAsset[]> {
  return db.uiAssets.orderBy('createdAt').reverse().toArray();
}

export async function deleteUiAsset(id: string): Promise<void> {
  await db.uiAssets.delete(id);
  releaseUiAssetUrl(id);
}

/** Materialises an object URL for an asset, reusing one if it already exists. */
export async function uiAssetUrl(id: string): Promise<string | null> {
  const cached = urls.get(id);
  if (cached) return cached;

  const record = await db.uiAssets.get(id);
  if (!record) return null;

  const url = URL.createObjectURL(record.data);
  urls.set(id, url);
  return url;
}

/** The URL for an asset already materialised, without touching the database. */
export function cachedUiAssetUrl(id: string): string | null {
  return urls.get(id) ?? null;
}

/**
 * Loads every stored asset's URL up front.
 *
 * The UI renderer resolves assets synchronously — it is drawing a menu, not awaiting one — so the
 * URLs have to exist before it asks. Priming the cache when the editor starts is cheaper than
 * making every consumer async.
 */
export async function primeUiAssetUrls(): Promise<void> {
  for (const record of await listUiAssets()) {
    if (!urls.has(record.id)) urls.set(record.id, URL.createObjectURL(record.data));
  }
}

export function releaseUiAssetUrl(id: string): void {
  const url = urls.get(id);
  if (!url) return;
  URL.revokeObjectURL(url);
  urls.delete(id);
}
