import { useEffect, useState } from 'react';
import { useThree } from '@react-three/fiber';
import type { LoadedScene, SceneLoader } from '@helaengine/engine';
import { useSceneStore } from '../store/sceneStore';

interface EngineBridgeProps {
  loader: SceneLoader;
  onLoaded?: (loaded: LoadedScene) => void;
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

  useEffect(() => {
    // Sprint 3 rebuilds the whole scene on any document change. That is fine at this size and
    // keeps the bridge honest; incremental diffing arrives with the transform gizmos in Sprint 5,
    // when dragging makes rebuild-per-frame actually expensive.
    const loaded = loader.loadInto(threeScene, scene);
    onLoaded?.(loaded);
    return () => loaded.dispose();
  }, [loader, threeScene, scene, onLoaded, modelEpoch]);

  return null;
}
