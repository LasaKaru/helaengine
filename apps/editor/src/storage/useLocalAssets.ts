import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AssetManifestEntry } from '@helaengine/schema';
import type { AssetLibrary } from '../engine/assetLibrary';
import type { StoredLocalAsset } from './db';
import {
  listLocalAssets,
  localAssetEntries,
  refreshLocalAssets,
  subscribeToLocalAssets,
} from './localAssets';

export interface LocalAssets {
  entries: AssetManifestEntry[];
  stored: StoredLocalAsset[];
  /** Re-reads the store. Called after an import or a delete. */
  reload(): void;
}

/**
 * Models imported from disk, as manifest entries the editor can place.
 *
 * Registered with the resolver on every change, and that registration is the part that matters: an
 * asset that appears in a list but is not in the resolver is a card you can drag into the world
 * and then watch fail to draw. The uploaded and `.hela`-imported paths both learned this the same
 * way.
 */
export function useLocalAssets(library: AssetLibrary | null): LocalAssets {
  const entries = useSyncExternalStore(
    subscribeToLocalAssets,
    localAssetEntries,
    localAssetEntries,
  );
  const [stored, setStored] = useState<StoredLocalAsset[]>([]);

  const reload = useCallback(() => {
    void refreshLocalAssets();
    void listLocalAssets().then(setStored);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!library) return;
    for (const entry of entries) library.resolver.add(entry);
  }, [library, entries]);

  return useMemo(() => ({ entries, stored, reload }), [entries, stored, reload]);
}
