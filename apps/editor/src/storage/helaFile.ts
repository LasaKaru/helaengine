import {
  HELA_EXTENSION,
  HELA_MIME,
  HelaFileError,
  packHelaFile,
  suggestedFilename,
  unpackHelaFile,
  type AssetPayload,
  type UiAssetPayload,
} from '@helaengine/hela-file';
import type { Scene } from '@helaengine/schema';
import { db, type StoredUiAsset } from './db';
import { cloudAssets } from './backend';
import { releaseUiAssetUrl } from './uiAssets';

/**
 * The editor's side of the `.hela` file: deciding what goes in, and putting back what comes out.
 *
 * The container itself knows nothing about where assets live — that is `@helaengine/hela-file`'s
 * whole point. This is where the question "what does *this* scene actually depend on?" gets
 * answered, and it has exactly one interesting rule: **embed only what the recipient could not
 * otherwise have.**
 *
 * Curated assets ship with every install, so embedding one would add megabytes to a file for
 * something the opener already has. An uploaded model and a home-screen image would otherwise be
 * gone, so they travel.
 */

export { HELA_EXTENSION, HELA_MIME, HelaFileError, suggestedFilename };

/** The version stamped into a file, for diagnostics when somebody sends one in. */
const ENGINE_VERSION = '0.1.0';

/**
 * Which asset ids a scene actually places.
 *
 * "Actually" is the load-bearing word. An organisation with two hundred uploaded models should not
 * put all two hundred into a file that uses three of them.
 */
function referencedAssetIds(scene: Scene): Set<string> {
  return new Set(scene.objects.map((object) => object.assetId));
}

/** Which UI asset ids the shell references. Two fields today; both are optional and often null. */
function referencedUiAssetIds(scene: Scene): Set<string> {
  const ids = new Set<string>();
  const home = scene.uiConfig.homeScreen;
  if (home.backgroundImageAssetId) ids.add(home.backgroundImageAssetId);
  if (home.introVideoAssetId) ids.add(home.introVideoAssetId);
  return ids;
}

/**
 * Fetches the bytes of every custom model this scene places.
 *
 * Returns an empty list when nobody is signed in, which is correct rather than a failure: without
 * an account there are no uploaded assets to miss, and every asset in the scene is a curated one
 * the opener already has.
 */
async function collectCustomAssets(scene: Scene): Promise<AssetPayload[]> {
  const client = cloudAssets();
  if (!client) return [];

  const wanted = referencedAssetIds(scene);
  const payloads: AssetPayload[] = [];

  for (const asset of await client.list()) {
    // Curated rows have no organisation and are not embedded; a pending or failed upload has no
    // bytes to embed.
    if (asset.organizationId === null || asset.status !== 'ready' || !asset.glbPath) continue;
    if (!wanted.has(asset.assetId)) continue;

    try {
      const response = await fetch(`${client.assetUrl(asset.glbPath)}`);
      if (!response.ok) continue;
      payloads.push({
        assetId: asset.assetId,
        name: asset.name,
        category: asset.category,
        bytes: new Uint8Array(await response.arrayBuffer()),
      });
    } catch {
      // A model that cannot be fetched is left out rather than failing the save. The file is still
      // worth having, and the alternative is refusing to save because one asset server hiccuped.
    }
  }

  return payloads;
}

/** Reads the UI blobs this scene references straight out of IndexedDB. */
async function collectUiAssets(scene: Scene): Promise<UiAssetPayload[]> {
  const wanted = referencedUiAssetIds(scene);
  if (wanted.size === 0) return [];

  const payloads: UiAssetPayload[] = [];
  for (const id of wanted) {
    const record = await db.uiAssets.get(id);
    if (!record) continue;
    payloads.push({
      id: record.id,
      name: record.name,
      kind: record.kind,
      mimeType: record.mimeType,
      bytes: new Uint8Array(await record.data.arrayBuffer()),
    });
  }
  return payloads;
}

export interface ExportInput {
  scene: Scene;
  /** Data URL of the projects-list thumbnail, if there is one. */
  thumbnail?: string | undefined;
}

/** Builds the bytes of a `.hela` file for a scene. */
export async function buildHelaFile(input: ExportInput): Promise<Uint8Array> {
  const [assets, uiAssets] = await Promise.all([
    collectCustomAssets(input.scene),
    collectUiAssets(input.scene),
  ]);

  return packHelaFile({
    scene: input.scene,
    engineVersion: ENGINE_VERSION,
    assets,
    uiAssets,
    ...(input.thumbnail ? { thumbnail: dataUrlToBytes(input.thumbnail) } : {}),
  });
}

export interface ImportedProject {
  scene: Scene;
  name: string;
  /** Data URL, so it can go straight into the stored project record. */
  thumbnail: string | undefined;
  /** Custom models the file carried, already registered for this session. */
  restoredAssets: AssetPayload[];
  /**
   * What the opener should be told.
   *
   * Not every import is clean, and the honest cases are worth a sentence: a file carrying custom
   * models opened by somebody with no account keeps them for the session but cannot persist them.
   */
  notes: string[];
}

/**
 * Opens a `.hela` file.
 *
 * UI assets go back into IndexedDB, which is where the shell reads them from, so a home screen
 * looks right immediately and survives a reload.
 *
 * Custom models are the awkward case and are handled honestly rather than silently. They are
 * returned so the caller can register them as blob-backed session assets — which makes the level
 * *draw* correctly straight away. Making them permanent means uploading them to an account, which
 * somebody who is not signed in does not have; that is said out loud in `notes` rather than left
 * as a mystery after the next reload.
 */
export async function importHelaFile(bytes: Uint8Array): Promise<ImportedProject> {
  const read = await unpackHelaFile(bytes);
  const notes: string[] = [];

  for (const asset of read.uiAssets) {
    const record: StoredUiAsset = {
      id: asset.id,
      name: asset.name,
      kind: asset.kind,
      mimeType: asset.mimeType,
      bytes: asset.bytes.byteLength,
      data: new Blob([asset.bytes as BlobPart], { type: asset.mimeType }),
      createdAt: Date.now(),
    };
    await db.uiAssets.put(record);
    // An id that was already materialised must not keep serving the previous bytes.
    releaseUiAssetUrl(asset.id);
  }

  if (read.assets.length > 0 && !cloudAssets()) {
    notes.push(
      `This project uses ${read.assets.length} custom model${read.assets.length === 1 ? '' : 's'}. ` +
        `They will show while this tab is open — sign in and re-upload them under My Assets to keep them.`,
    );
  }

  return {
    scene: read.scene,
    name: read.manifest.name,
    thumbnail: read.thumbnail ? bytesToDataUrl(read.thumbnail, 'image/png') : undefined,
    restoredAssets: read.assets,
    notes,
  };
}

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  // Chunked: `String.fromCharCode(...bytes)` blows the argument limit on anything above a megabyte
  // or so, which a thumbnail will not hit but a future embedded image would.
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}
