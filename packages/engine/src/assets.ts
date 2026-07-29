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
    // Built-ins first, so a manifest is free to override one and a scene never has to ship the
    // definition of a thing the engine itself provides.
    this.#entries = new Map(BUILTIN_ASSET_ENTRIES.map((entry) => [entry.id, entry]));
    for (const entry of manifest.assets) this.#entries.set(entry.id, entry);
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

/**
 * Assets the engine provides itself, with no ingest pipeline involved.
 *
 * Trigger volumes are placed in the world like props and saved in the document like props, so they
 * need an `assetId` like props — but there is no model to compress and no thumbnail to render.
 * Shipping them as built-ins keeps the document shape uniform without inventing a second kind of
 * scene object that half the editor would have to special-case.
 */
export const BUILTIN_ASSET_ENTRIES: AssetManifestEntry[] = [
  {
    id: 'logic_trigger_box',
    name: 'Trigger box',
    category: 'logic',
    tags: ['logic', 'trigger'],
    defaultScale: [1, 1, 1],
    colliderType: 'none',
    bounds: [1, 1, 1],
    placeholderColor: '#f2c14e',
  },
  {
    id: 'logic_trigger_sphere',
    name: 'Trigger sphere',
    category: 'logic',
    tags: ['logic', 'trigger'],
    defaultScale: [1, 1, 1],
    colliderType: 'none',
    bounds: [1, 1, 1],
    placeholderColor: '#f2c14e',
  },
];

/** True for the ids above — the editor uses it to place a trigger rather than a model. */
export function isBuiltinTriggerAsset(assetId: string): boolean {
  return assetId === 'logic_trigger_box' || assetId === 'logic_trigger_sphere';
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
