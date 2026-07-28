import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type { LoadedScene, SceneLoader } from '@helaengine/engine';
import type { Scene } from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';

interface EngineBridgeProps {
  loader: SceneLoader;
  onLoaded?: (loaded: LoadedScene) => void;
}

/**
 * Identifies the *shape* of a scene: which objects exist and what asset each uses.
 *
 * Transforms are deliberately excluded. A change to this key means nodes must be created or
 * destroyed; anything else can be applied to the nodes already there.
 */
function structureKey(scene: Scene): string {
  const { terrain } = scene;
  // Terrain shape belongs here too: changing its type, resolution or palette needs new geometry
  // and a differently-configured material, not just new vertex data. Height and paint data are
  // deliberately excluded — those take the cheap sync path below.
  const terrainKey = [
    terrain.type,
    terrain.segments,
    terrain.size.join('x'),
    terrain.maxHeight,
    terrain.layers.map((layer) => layer.color).join(','),
  ].join(':');

  return `${terrainKey}#${scene.objects.map((object) => `${object.id}:${object.assetId}`).join('|')}`;
}

/** Identifies the terrain's *data* — the part that can change without new geometry being needed. */
function terrainDataKey(scene: Scene): string {
  return `${scene.terrain.heightmap?.data ?? ''}|${scene.terrain.splatmap?.data ?? ''}`;
}

/**
 * The seam between the editor and the runtime.
 *
 * react-three-fiber owns the canvas, the camera and the render loop. Everything about *what is in
 * the world* comes from the engine: this component reads the scene document out of the store and
 * hands it to `SceneLoader.loadInto`, which populates r3f's scene.
 *
 * The temptation is to write `<mesh>` JSX per object and let React reconcile it. That would be
 * shorter and completely wrong — the exported project has no React, so any placement logic
 * expressed as JSX is logic that cannot be exported. Keeping instantiation inside the engine is
 * what makes "what you see in the editor" and "what you get in the export" the same code.
 */
export function EngineBridge({ loader, onLoaded }: EngineBridgeProps): null {
  const threeScene = useThree((state) => state.scene);
  const scene = useSceneStore((state) => state.scene);
  const [modelEpoch, setModelEpoch] = useState(0);
  const loadedRef = useRef<LoadedScene | null>(null);
  const appliedTerrain = useRef<string | null>(null);

  // Models are fetched separately from scene construction so that `loadInto` stays synchronous.
  // Anything not yet downloaded renders as a placeholder on the first pass; when new models do
  // arrive the epoch bumps and the scene is rebuilt with them.
  useEffect(() => {
    let cancelled = false;
    void loader.preload(scene).then((report) => {
      // `preload` only reports assets it actually fetched, so a scene whose models are already
      // cached bumps nothing and rebuilds nothing extra.
      if (!cancelled && report.loaded > 0) setModelEpoch((epoch) => epoch + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [loader, scene]);

  const structure = useMemo(() => structureKey(scene), [scene]);

  // Full rebuild, but only when objects are added, removed or re-assigned.
  useEffect(() => {
    const loaded = loader.loadInto(threeScene, scene);
    loadedRef.current = loaded;
    appliedTerrain.current = terrainDataKey(scene);
    onLoaded?.(loaded);
    return () => {
      loadedRef.current = null;
      loaded.dispose();
    };
    // `scene` is intentionally absent: rebuilding on every transform edit would destroy the node
    // a gizmo is attached to, mid-drag, sixty times a second. Transform-only changes take the
    // incremental path below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loader, threeScene, structure, onLoaded, modelEpoch]);

  // Transform-only changes: update the existing nodes in place.
  useEffect(() => {
    loadedRef.current?.syncTransforms(scene);
  }, [scene]);

  // Terrain data changes that did not come from the live sculpt stroke — an undo, a redo, a loaded
  // document — are pushed back into the field. Skipped when the data already matches, so a stroke
  // committing what it just drew does not decode it all over again.
  const terrainData = terrainDataKey(scene);
  useEffect(() => {
    if (appliedTerrain.current === terrainData) return;
    appliedTerrain.current = terrainData;
    loadedRef.current?.syncTerrain(scene.terrain);
    // `scene.terrain` is read through the ref-guarded key rather than listed, so an unrelated
    // object edit does not re-decode the heightmap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terrainData]);

  return null;
}
