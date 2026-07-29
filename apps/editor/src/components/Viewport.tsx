import { useCallback, useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import type { AssetResolver, LoadedScene, SceneLoader } from '@helaengine/engine';
import { setCamera, setLoadedScene, setRenderer } from '../devApi';
import { useProjectStore } from '../store/projectStore';
import { EngineBridge } from './EngineBridge';
import { MarqueeOverlay } from './Marquee';
import { PlacementController } from './PlacementController';
import { PlacementToolbar } from './PlacementToolbar';
import { BehaviorPreview, WaypointEditor } from './BehaviorPreview';
import { PhysicsPreview } from './PhysicsPreview';
import { SculptController } from './SculptController';
import { SelectionController } from './SelectionController';
import { SelectionHighlight } from './SelectionHighlight';
import { TransformGizmo } from './TransformGizmo';

/** Publishes the r3f camera to the dev API. Dev/test tooling only; nothing renders. */
function CameraReporter(): null {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);

  useEffect(() => {
    setCamera(camera);
    setRenderer(gl);
    return () => {
      setCamera(null);
      setRenderer(null);
    };
  }, [camera, gl]);

  return null;
}

/**
 * Hands the project store a way to screenshot the viewport for project thumbnails.
 *
 * Registered from inside the Canvas because that is the only place with the renderer. The canvas
 * is created with `preserveDrawingBuffer`, without which `toDataURL` returns a blank image on most
 * drivers — the back buffer is normally cleared as soon as it has been presented.
 */
function ThumbnailReporter(): null {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);

  useEffect(() => {
    useProjectStore.getState().setCaptureThumbnail(() => {
      try {
        // Rendered on demand rather than trusting whatever is in the buffer, so the thumbnail
        // matches the scene at save time even if the loop was idle.
        gl.render(scene, camera);
        return gl.domElement.toDataURL('image/jpeg', 0.6);
      } catch {
        return null;
      }
    });

    return () => useProjectStore.getState().setCaptureThumbnail(null);
  }, [gl, scene, camera]);

  return null;
}

interface ViewportProps {
  loader: SceneLoader;
  resolver: AssetResolver;
}

/**
 * The 3D viewport. r3f supplies the canvas, camera and loop; the engine supplies the contents.
 *
 * The grid and the camera controls are editor furniture — they exist to help someone build a
 * scene and are deliberately not part of the scene document, so they never end up in an export.
 */
export function Viewport({ loader, resolver }: ViewportProps): React.JSX.Element {
  const [stats, setStats] = useState({ objects: 0, missing: 0 });
  const [loadedScene, setLoaded] = useState<LoadedScene | null>(null);
  const dragging = useEditorStore((state) => state.drag !== null);
  const gizmoActive = useEditorStore((state) => state.gizmoActive);
  const tool = useEditorStore((state) => state.tool);
  const playing = useEditorStore((state) => state.playing);
  const walking = useEditorStore((state) => state.walking);
  const editingWaypoints = useEditorStore((state) => state.editingWaypoints);
  const playerHealth = useEditorStore((state) => state.playerHealth);
  const maxHealth = useSceneStore((state) => state.scene.player.health);

  const handleLoaded = useCallback((loaded: LoadedScene) => {
    setStats({ objects: loaded.objects.size, missing: loaded.missingAssetIds.length });
    setLoadedScene(loaded);
    setLoaded(loaded);
  }, []);

  return (
    <div className="viewport">
      <PlacementToolbar />
      <Canvas
        shadows
        camera={{ position: [18, 14, 18], fov: 55, near: 0.1, far: 2000 }}
        gl={{ antialias: true, preserveDrawingBuffer: true }}
        data-testid="viewport-canvas"
      >
        <CameraReporter />
        <ThumbnailReporter />
        <EngineBridge loader={loader} onLoaded={handleLoaded} />
        <PlacementController loader={loader} loadedScene={loadedScene} />
        {/* Behaviours-only play. Walk mode runs them through the game runtime instead, so this
            stays out of the way rather than driving the same objects twice. */}
        {!walking && <BehaviorPreview loadedScene={loadedScene} />}
        <PhysicsPreview loadedScene={loadedScene} resolver={resolver} loader={loader} />
        <WaypointEditor loadedScene={loadedScene} />
        {!playing && <SculptController loadedScene={loadedScene} />}
        {tool === 'select' && !playing && !editingWaypoints && (
          <>
            <SelectionController loadedScene={loadedScene} />
            <SelectionHighlight loadedScene={loadedScene} />
            <TransformGizmo />
          </>
        )}
        {!walking && (
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
        )}
        <OrbitControls
          makeDefault
          enableDamping
          dampingFactor={0.08}
          maxPolarAngle={Math.PI / 2.05}
          // Orbiting mid-drop would fight the ghost for the same pointer.
          // Orbiting during a sculpt stroke would drag the camera instead of the ground.
          enabled={!dragging && !gizmoActive && !walking && tool === 'select'}
        />
      </Canvas>

      <MarqueeOverlay />

      {walking && (
        <div className="walk-hint" role="status" aria-label="Walk mode">
          <strong>Walking</strong>
          <span>WASD to move, Space to jump, click to look, Escape to return</span>
        </div>
      )}

      {walking && playerHealth !== null && (
        <div className="health-bar" role="status" aria-label="Player health">
          <div
            className="health-fill"
            style={{ width: `${Math.max(0, (playerHealth / maxHealth) * 100)}%` }}
          />
          <span>{playerHealth <= 0 ? 'Down' : `${Math.round(playerHealth)} HP`}</span>
        </div>
      )}

      <div className="viewport-stats" role="status" aria-label="Viewport stats">
        <span>{stats.objects} objects</span>
        {stats.missing > 0 && <span className="warn">{stats.missing} missing assets</span>}
      </div>
    </div>
  );
}
