import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { AssetCategory, AssetManifestEntry } from '@helaengine/schema';
import type { AssetLibrary } from '../engine/assetLibrary';
import { cloudAssets, subscribeToSession, type CloudAssets } from './backend';
import { assetIdFromFilename, type CloudAsset } from './cloudAssets';

/**
 * An organisation's own assets, as far as the editor is concerned.
 *
 * Owns three things the panel should not have to: the list, the upload, and the registration of a
 * finished upload with the loader's resolver. That last one is the part worth stating — an asset
 * that exists in a list but not in the resolver is a card that can be dragged into the world and
 * then fails to draw, which is a worse outcome than not offering it at all. So a `ready` asset is
 * registered before it is ever rendered as a card.
 *
 * When nobody is signed in this is empty and every action refuses. That is not a degraded mode: the
 * curated library is the whole product for somebody who never made an account, and it works.
 */

export interface UploadedAssets {
  /** Every row, including the ones still processing and the ones that failed. */
  all: CloudAsset[];
  /** Just the placeable ones, in manifest shape, already registered with the resolver. */
  entries: AssetManifestEntry[];
  available: boolean;
  busy: boolean;
  error: string | null;
  upload: (files: FileList | File[], category: AssetCategory) => Promise<void>;
  remove: (assetId: string) => Promise<void>;
  dismissError: () => void;
}

export function useUploadedAssets(library: AssetLibrary | null): UploadedAssets {
  const [fetched, setAll] = useState<CloudAsset[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped to ask for a refetch. An upload's own response is what the server said at that instant;
  // re-reading afterwards is how anything a later processing stage adds arrives without a reload.
  const [generation, setGeneration] = useState(0);

  // Subscribed rather than read once: signing in halfway through a session has to reach this panel,
  // and the client is a module-level value React has no other way to notice changing.
  const client: CloudAssets | null = useSyncExternalStore(
    subscribeToSession,
    cloudAssets,
    () => null,
  );
  const available = client !== null;

  // Derived rather than cleared in an effect. Signing out does not have to *do* anything to the
  // list — with no client there is nothing to show, and the state left over from the previous
  // account is unreachable rather than stale.
  // Memoised so the fallback is one array rather than a new empty one per render, which would make
  // every downstream memo re-run forever while signed out.
  const all = useMemo(() => (client ? fetched : []), [client, fetched]);

  useEffect(() => {
    if (!client) return;

    let live = true;
    client
      .list()
      .then((assets) => {
        if (live) setAll(assets);
      })
      .catch((problem: unknown) => {
        // Not fatal, and not silent. The curated library still works; the panel says this part did
        // not load rather than showing an empty section that looks like "you have no assets".
        if (live) setError(problem instanceof Error ? problem.message : String(problem));
      });

    return () => {
      live = false;
    };
  }, [client, generation]);

  /**
   * The placeable ones, registered as they appear.
   *
   * In a memo rather than an effect because the manifest built from it is a render-time value: an
   * effect would leave one frame in which a card exists and the resolver does not know about it,
   * and one frame is enough for a drag that started in the same tick.
   */
  const entries = useMemo(() => {
    if (!client) return [];
    const mapped: AssetManifestEntry[] = [];
    for (const asset of all) {
      const entry = client.toManifestEntry(asset);
      if (!entry) continue;
      library?.resolver.add(entry);
      mapped.push(entry);
    }
    return mapped;
  }, [all, client, library]);

  const upload = useCallback(
    async (files: FileList | File[], category: AssetCategory) => {
      if (!client) return;
      setBusy(true);
      setError(null);

      const problems: string[] = [];
      try {
        // Sequential, deliberately. Parallel uploads of a handful of 20 MB files compete for the
        // same connection and make every progress indication meaningless; one at a time finishes
        // sooner in practice and can report which file failed.
        for (const file of Array.from(files)) {
          try {
            const assetId = assetIdFromFilename(file.name);
            const uploaded = await client.upload(file, {
              assetId,
              name: file.name.replace(/\.[^.]+$/, ''),
              category,
            });
            setAll((current) => [...current.filter((a) => a.assetId !== assetId), uploaded]);
          } catch (problem: unknown) {
            problems.push(problem instanceof Error ? problem.message : String(problem));
          }
        }
      } finally {
        setBusy(false);
        // Refetched even on success: the row the upload returned is what the server said at that
        // moment, and anything a later processing stage adds — a thumbnail, a poly count — lands
        // here rather than on the next reload.
        setGeneration((n) => n + 1);
      }

      if (problems.length > 0) setError(problems.join(' '));
    },
    [client],
  );

  const remove = useCallback(
    async (assetId: string) => {
      if (!client) return;
      try {
        await client.remove(assetId);
        setAll((current) => current.filter((asset) => asset.assetId !== assetId));
      } catch (problem: unknown) {
        setError(problem instanceof Error ? problem.message : String(problem));
      }
    },
    [client],
  );

  const dismissError = useCallback(() => setError(null), []);

  return { all, entries, available, busy, error, upload, remove, dismissError };
}
