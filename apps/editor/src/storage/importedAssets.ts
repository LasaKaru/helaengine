import { AssetCategorySchema, type AssetManifestEntry } from '@helaengine/schema';
import type { AssetPayload } from '@helaengine/hela-file';

/**
 * Custom models that arrived inside a `.hela` file.
 *
 * They cannot go where uploaded assets go — that is an account's asset library, and somebody who
 * just double-clicked a file they were sent may not have an account. So they are held here as blob
 * URLs and merged into the manifest exactly like an uploaded asset, which makes the level *draw*
 * immediately.
 *
 * The honest limitation, stated where it is implemented rather than only in a dialog: a blob URL
 * dies with the tab. Reopening the project after a reload shows placeholders until the models are
 * uploaded to an account under **My Assets**. The alternative — writing them into IndexedDB and
 * inventing a second, local kind of asset library — is a real feature with its own storage limits,
 * its own eviction behaviour and its own export path, and it is not one to grow sideways out of an
 * import.
 */

let entries: AssetManifestEntry[] = [];
const urls = new Set<string>();
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

export function subscribeToImportedAssets(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function importedAssetEntries(): AssetManifestEntry[] {
  return entries;
}

/**
 * Replaces whatever the previous import left behind.
 *
 * Replaces rather than accumulates: opening a second file means working on that file, and keeping
 * the first one's models around would leave a library full of things no open project references.
 */
export function registerImportedAssets(assets: AssetPayload[]): void {
  releaseImportedAssets();
  if (assets.length === 0) return;

  entries = assets.map((asset) => {
    const url = URL.createObjectURL(
      new Blob([asset.bytes as BlobPart], { type: 'model/gltf-binary' }),
    );
    urls.add(url);

    const category = AssetCategorySchema.safeParse(asset.category);
    return {
      id: asset.assetId,
      name: asset.name,
      category: category.success ? category.data : 'props',
      // Tagged so the library panel can say where it came from, and so a test can find them.
      tags: ['imported'],
      // Absolute, which the engine's `joinUrl` passes through untouched — the same trick an
      // uploaded asset uses to live at a different origin from the export's asset folder.
      glbPath: url,
      defaultScale: [1, 1, 1],
      colliderType: 'box',
      bounds: [1, 1, 1],
      placeholderColor: '#8a7ca8',
      // Unknown until the model is loaded, and this runs before that. An imported rig therefore
      // shows no clips in the inspector until it is re-ingested — recorded here rather than
      // guessed, because an empty list is the truth about what has been measured.
      animations: [],
      skinned: false,
      // Unmeasured, not absent: reading which PBR maps a GLB carries means decoding it, and this
      // runs before that. An empty list says nothing has been measured, which is the truth.
      materialMaps: [],
      // An asset that arrived inside somebody's project file. Whoever built that file is the
      // authority on its terms, and this browser has no way to ask — so it is recorded as a
      // customer asset with nothing claimed about its licence, which is the truth.
      origin: 'customer',
    } satisfies AssetManifestEntry;
  });

  announce();
}

export function releaseImportedAssets(): void {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  if (entries.length === 0) return;
  entries = [];
  announce();
}
