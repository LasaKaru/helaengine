import type { AssetManifest, AssetManifestEntry, Id } from '@helaengine/schema';

/**
 * Resolves an `assetId` from a scene document to something the loader can instantiate.
 *
 * Scene documents never contain file paths, so every path from `assetId` to bytes goes through an
 * implementation of this interface. Sprint 2 adds a GLB-loading resolver behind the same contract;
 * nothing in `SceneLoader` has to change when it does.
 */
export interface AssetResolver {
  get(assetId: Id): AssetManifestEntry | undefined;
  has(assetId: Id): boolean;
}

export class ManifestAssetResolver implements AssetResolver {
  readonly #entries: Map<string, AssetManifestEntry>;

  constructor(manifest: AssetManifest) {
    this.#entries = new Map(manifest.assets.map((entry) => [entry.id, entry]));
  }

  get(assetId: Id): AssetManifestEntry | undefined {
    return this.#entries.get(assetId);
  }

  has(assetId: Id): boolean {
    return this.#entries.has(assetId);
  }

  get size(): number {
    return this.#entries.size;
  }
}

/** The stand-in used when a scene references an asset the resolver has never heard of. */
export const MISSING_ASSET_ENTRY: AssetManifestEntry = {
  id: 'missing',
  name: 'Missing asset',
  category: 'props',
  tags: [],
  defaultScale: [1, 1, 1],
  colliderType: 'none',
  bounds: [1, 1, 1],
  placeholderColor: '#ff00ff',
};
