import { loadAssetLibrary, type AssetLibrary } from './assetLibrary';

/**
 * The asset library, loaded at most once per page.
 *
 * Two things now want it — the editor workspace, to render, and the dev API, which the e2e suite
 * reaches for on the *projects* screen before any workspace exists — and they must not each fetch
 * and parse the manifest. Memoised on the promise rather than the result, so two callers arriving
 * while the first fetch is still in flight share it instead of starting a second.
 *
 * A failure is not cached: the manifest is generated output, and the most likely reason it is
 * missing is that somebody has not run `pnpm ingest-assets` yet. Caching the rejection would mean
 * a reload is the only way to recover from a problem that fixes itself.
 */
let inFlight: Promise<AssetLibrary> | null = null;

export function assetLibraryOnce(signal?: AbortSignal): Promise<AssetLibrary> {
  inFlight ??= loadAssetLibrary(signal).catch((error: unknown) => {
    inFlight = null;
    throw error;
  });
  return inFlight;
}
