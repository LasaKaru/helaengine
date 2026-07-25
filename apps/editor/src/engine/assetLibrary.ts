import { GltfModelSource, ManifestAssetResolver, SceneLoader } from '@helaengine/engine';
import { parseAssetManifest, type AssetManifest } from '@helaengine/schema';

/** Where the ingest pipeline's output is mounted, in both dev and built output. */
export const ASSET_BASE_URL = './assets/';

export interface AssetLibrary {
  manifest: AssetManifest;
  loader: SceneLoader;
}

/**
 * Builds the editor's `SceneLoader`.
 *
 * Note what is *not* here: any editor-specific rendering logic. The editor configures the same
 * loader the demo and every exported project use, then hands it a scene document. If placement or
 * instantiation behaviour ever needs to change, it changes in the engine, and all three get it.
 */
export async function loadAssetLibrary(signal?: AbortSignal): Promise<AssetLibrary> {
  const response = await fetch(`${ASSET_BASE_URL}manifest.json`, signal ? { signal } : {});
  if (!response.ok) {
    throw new Error(
      `Could not load the asset manifest (${response.status}). Run \`pnpm ingest-assets\` to build it.`,
    );
  }

  const manifest = parseAssetManifest(await response.json());
  const loader = new SceneLoader({
    resolver: new ManifestAssetResolver(manifest),
    modelSource: new GltfModelSource({ baseUrl: ASSET_BASE_URL }),
  });

  return { manifest, loader };
}
