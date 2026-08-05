import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { AssetManifestEntry } from '@helaengine/schema';
import type { AssetLibrary } from '../engine/assetLibrary';
import { importedAssetEntries, subscribeToImportedAssets } from './importedAssets';

/**
 * Models that came in with a `.hela` file, as manifest entries the editor can place.
 *
 * The same shape `useUploadedAssets` produces, and registered with the resolver the same way: an
 * asset that is in a list but not in the resolver is a card you can drag into the world and then
 * watch fail to draw.
 */
export function useImportedAssets(library: AssetLibrary | null): AssetManifestEntry[] {
  const entries = useSyncExternalStore(
    subscribeToImportedAssets,
    importedAssetEntries,
    importedAssetEntries,
  );

  useEffect(() => {
    if (!library) return;
    for (const entry of entries) library.resolver.add(entry);
  }, [library, entries]);

  return useMemo(() => entries, [entries]);
}
