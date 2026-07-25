import { useCallback, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import type { LoadedScene, SceneLoader } from '@helaengine/engine';
import { setLoadedScene } from '../devApi';
import { EngineBridge } from './EngineBridge';

interface ViewportProps {
  loader: SceneLoader;
}

/**
 * The 3D viewport. r3f supplies the canvas, camera and loop; the engine supplies the contents.
 *
 * The grid and the camera controls are editor furniture — they exist to help someone build a
 * scene and are deliberately not part of the scene document, so they never end up in an export.
 */
export function Viewport({ loader }: ViewportProps): React.JSX.Element {
  const [stats, setStats] = useState({ objects: 0, missing: 0 });

  const handleLoaded = useCallback((loaded: LoadedScene) => {
    setStats({ objects: loaded.objects.size, missing: loaded.missingAssetIds.length });
    setLoadedScene(loaded);
  }, []);

  return (
    <div className="viewport">
      <Canvas
        shadows
        camera={{ position: [18, 14, 18], fov: 55, near: 0.1, far: 2000 }}
        gl={{ antialias: true }}
        data-testid="viewport-canvas"
      >
        <EngineBridge loader={loader} onLoaded={handleLoaded} />
        <Grid
          args={[200, 200]}
          cellSize={1}
          cellColor="#3a4354"
          sectionSize={10}
          sectionColor="#4d5a72"
          fadeDistance={140}
          fadeStrength={1.4}
          followCamera={false}
          infiniteGrid
        />
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          maxPolarAngle={Math.PI / 2.05}
        />
      </Canvas>

      <div className="viewport-stats" role="status">
        <span>{stats.objects} objects</span>
        {stats.missing > 0 && <span className="warn">{stats.missing} missing assets</span>}
      </div>
    </div>
  );
}
