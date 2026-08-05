import JSZip from 'jszip';
import { migrateScene, type Scene } from '@helaengine/schema';
import {
  ASSET_DIR,
  canonicalJson,
  HELA_FORMAT,
  HELA_FORMAT_VERSION,
  HelaFileError,
  HelaManifestSchema,
  MANIFEST_PATH,
  SCENE_PATH,
  THUMBNAIL_PATH,
  UI_DIR,
  type EmbeddedAsset,
  type EmbeddedUiAsset,
  type HelaManifest,
} from './format.js';

/**
 * Reading and writing `.hela` containers.
 *
 * No filesystem, no DOM: bytes in, bytes out. The editor supplies the assets it has collected and
 * decides where the result goes; a CLI or a server-side importer would do the same with different
 * plumbing. That is also what makes every rule in here testable in Node without a browser.
 */

/** A fixed date on every zip entry, so an unchanged project saves byte-identically. */
const STABLE_DATE = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/**
 * Stored, not deflated.
 *
 * GLBs arrive Draco-compressed and PNGs are already compressed, so deflating them spends CPU to
 * save single-digit percentages. The JSON is small. What uncompressed entries buy is a file git can
 * delta instead of replacing wholesale — which is the difference between a repository that grows by
 * a few lines per save and one that grows by a whole project.
 */
const STORED = { compression: 'STORE' } as const;

export interface AssetPayload extends Omit<EmbeddedAsset, 'path'> {
  bytes: Uint8Array;
}

export interface UiAssetPayload extends Omit<EmbeddedUiAsset, 'path'> {
  bytes: Uint8Array;
}

export interface PackInput {
  scene: Scene;
  engineVersion: string;
  /** Custom `.glb` files the scene places. Curated assets are never embedded. */
  assets?: AssetPayload[];
  /** Images and videos the shell references. */
  uiAssets?: UiAssetPayload[];
  /** PNG bytes for the projects list. */
  thumbnail?: Uint8Array | undefined;
  createdAt?: string;
}

export interface UnpackResult {
  manifest: HelaManifest;
  scene: Scene;
  assets: AssetPayload[];
  uiAssets: UiAssetPayload[];
  thumbnail: Uint8Array | null;
}

/** Writes a container. */
export async function packHelaFile(input: PackInput): Promise<Uint8Array> {
  const assets = input.assets ?? [];
  const uiAssets = input.uiAssets ?? [];

  const manifest: HelaManifest = {
    format: HELA_FORMAT,
    formatVersion: HELA_FORMAT_VERSION,
    engineVersion: input.engineVersion,
    sceneVersion: input.scene.version,
    name: input.scene.name,
    createdAt: input.createdAt ?? new Date().toISOString(),
    assets: assets.map((asset) => ({
      assetId: asset.assetId,
      name: asset.name,
      category: asset.category,
      path: `${ASSET_DIR}${safeSegment(asset.assetId)}.glb`,
    })),
    uiAssets: uiAssets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      mimeType: asset.mimeType,
      path: `${UI_DIR}${safeSegment(asset.id)}${extensionFor(asset.mimeType)}`,
    })),
    hasThumbnail: input.thumbnail !== undefined && input.thumbnail.byteLength > 0,
  };

  const zip = new JSZip();
  zip.file(MANIFEST_PATH, canonicalJson(manifest), { date: STABLE_DATE, ...STORED });
  zip.file(SCENE_PATH, canonicalJson(input.scene), { date: STABLE_DATE, ...STORED });

  if (manifest.hasThumbnail) {
    zip.file(THUMBNAIL_PATH, input.thumbnail!, { date: STABLE_DATE, ...STORED, binary: true });
  }

  for (const [index, asset] of assets.entries()) {
    zip.file(manifest.assets[index]!.path, asset.bytes, {
      date: STABLE_DATE,
      ...STORED,
      binary: true,
    });
  }

  for (const [index, asset] of uiAssets.entries()) {
    zip.file(manifest.uiAssets[index]!.path, asset.bytes, {
      date: STABLE_DATE,
      ...STORED,
      binary: true,
    });
  }

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'STORE',
    // Fixed, for the same reason the entry dates are: the platform byte in a zip header would
    // otherwise make a file written on macOS differ from the same file written on Linux.
    platform: 'UNIX',
  });
}

/**
 * Reads a container.
 *
 * Every failure here is a sentence rather than an exception from three layers down, because this is
 * the one place the editor is handed a file it did not write. "That is not a HelaEngine project
 * file" is actionable; a `SyntaxError` from `JSON.parse` is not.
 */
export async function unpackHelaFile(bytes: Uint8Array): Promise<UnpackResult> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (error) {
    throw new HelaFileError('That file is not a HelaEngine project (.hela).', { cause: error });
  }

  const manifestEntry = zip.file(MANIFEST_PATH);
  if (!manifestEntry) {
    // A zip that unzipped but holds no manifest: somebody renamed an archive, or an export got
    // confused with a project. Worth its own message, because the fix differs.
    throw new HelaFileError(
      'That archive is not a HelaEngine project — it has no hela.json. If it is an exported game, open the project it came from instead.',
    );
  }

  let manifest: HelaManifest;
  try {
    manifest = HelaManifestSchema.parse(JSON.parse(await manifestEntry.async('string')));
  } catch (error) {
    throw new HelaFileError('That project file’s manifest is damaged and cannot be read.', {
      cause: error,
    });
  }

  if (manifest.formatVersion > HELA_FORMAT_VERSION) {
    // Refused rather than attempted. A newer container may hold entries this build does not know
    // to carry, and opening it would silently drop them — then saving would write the loss to disk.
    throw new HelaFileError(
      `That project was saved by a newer version of HelaEngine (format ${manifest.formatVersion}; this build reads ${HELA_FORMAT_VERSION}). Update the editor to open it.`,
    );
  }

  const sceneEntry = zip.file(SCENE_PATH);
  if (!sceneEntry) throw new HelaFileError('That project file has no scene in it.');

  let scene: Scene;
  try {
    // Migrated on the way in, exactly as a stored or cloud document is. A file is untrusted input
    // no matter how it arrived, and one written by an older build must still open.
    scene = migrateScene(JSON.parse(await sceneEntry.async('string')));
  } catch (error) {
    throw new HelaFileError('That project file’s scene could not be read.', { cause: error });
  }

  const assets: AssetPayload[] = [];
  for (const entry of manifest.assets) {
    const file = zip.file(entry.path);
    // A manifest entry with no file behind it is a damaged container. Skipped rather than fatal:
    // the rest of the level is still worth opening, and the missing model draws as a placeholder
    // exactly as it would if the asset had been deleted from an account.
    if (!file) continue;
    assets.push({
      assetId: entry.assetId,
      name: entry.name,
      category: entry.category,
      bytes: await file.async('uint8array'),
    });
  }

  const uiAssets: UiAssetPayload[] = [];
  for (const entry of manifest.uiAssets) {
    const file = zip.file(entry.path);
    if (!file) continue;
    uiAssets.push({
      id: entry.id,
      name: entry.name,
      kind: entry.kind,
      mimeType: entry.mimeType,
      bytes: await file.async('uint8array'),
    });
  }

  const thumbnailEntry = manifest.hasThumbnail ? zip.file(THUMBNAIL_PATH) : null;
  const thumbnail = thumbnailEntry ? await thumbnailEntry.async('uint8array') : null;

  return { manifest, scene, assets, uiAssets, thumbnail };
}

/**
 * Whether these bytes even look like a container, without decoding one.
 *
 * `PK\x03\x04`. Used to tell "you picked a .png" from "your project file is corrupt" before doing
 * the work of parsing, so the message can be the right one.
 */
export function looksLikeHelaFile(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

/**
 * A path segment that cannot escape its directory.
 *
 * Asset ids are already constrained where they are minted, but this container is also written from
 * ids that arrived inside somebody else's file — and a `../` in a path is how an archive writes
 * outside the folder it was extracted to.
 */
function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'asset';
}

function extensionFor(mimeType: string): string {
  const known: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
  };
  return known[mimeType] ?? '.bin';
}
