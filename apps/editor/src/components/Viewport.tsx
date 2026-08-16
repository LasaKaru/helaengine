import { useCallback, useEffect, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { Grid, OrbitControls } from '@react-three/drei';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import type { AssetResolver, LoadedScene, SceneLoader } from '@helaengine/engine';
import { setCamera, setCameraPoseHandler, setLoadedScene, setRenderer } from '../devApi';
import { PostProcessing } from './PostProcessing';
import { useProjectStore } from '../store/projectStore';
import { EngineBridge } from './EngineBridge';
import { setLiveScene } from '../engine/liveScene';
import { MarqueeOverlay } from './Marquee';
import { PlacementController } from './PlacementController';
import { PlacementToolbar } from './PlacementToolbar';
import { BehaviorPreview, WaypointEditor } from './BehaviorPreview';
import { WorldTick } from './WorldTick';
import { PlayFromHere, PlayFromHereMenu } from './PlayFromHere';
import { PhysicsPreview } from './PhysicsPreview';
import { SculptController } from './SculptController';
import { SelectionController } from './SelectionController';
import { SelectionHighlight } from './SelectionHighlight';
import { PeerHighlight } from './PeerHighlight';
import { TransformGizmo } from './TransformGizmo';

/** Publishes the r3f camera to the dev API. Dev/test tooling only; nothing renders. */
function CameraReporter(): null {
  const camera = useThree((state) => state.camera);
  const gl = useThree((state) => state.gl);
  const controls = useThree((state) => state.controls) as {
    target: { set(x: number, y: number, z: number): void };
    update(): void;
  } | null;

  useEffect(() => {
    setCamera(camera);
    setRenderer(gl);
    setCameraPoseHandler((position, target) => {
      camera.position.set(position[0], position[1], position[2]);
      // The orbit target has to move too, or the next frame swings the camera back to whatever it
      // was looking at before.
      controls?.target.set(target[0], target[1], target[2]);
      camera.lookAt(target[0], target[1], target[2]);
      camera.updateProjectionMatrix();
      controls?.update();
    });
    return () => {
      setCamera(null);
      setRenderer(null);
      setCameraPoseHandler(null);
    };
  }, [camera, gl, controls]);

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
  const possessed = useEditorStore((state) => state.possessed);
  // Set by the export QA suite before it screenshots, so the comparison is scene against scene.
  const furnitureHidden = useEditorStore((state) => state.furnitureHidden);
  const editingWaypoints = useEditorStore((state) => state.editingWaypoints);
  const playerHealth = useEditorStore((state) => state.playerHealth);
  const maxHealth = useSceneStore((state) => state.scene.player.health);
  const cameraMode = useEditorStore((state) => state.cameraMode);
  const uiScreen = useEditorStore((state) => state.uiScreen);

  const handleLoaded = useCallback((loaded: LoadedScene) => {
    setStats({ objects: loaded.objects.size, missing: loaded.missingAssetIds.length });
    setLoadedScene(loaded);
    setLoaded(loaded);
    // So panels can ask the model questions the document cannot answer — bone names, above all.
    setLiveScene(loaded);
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
        <PostProcessing />
        <ThumbnailReporter />
        <EngineBridge loader={loader} onLoaded={handleLoaded} />
        <WorldTick loaded={loadedScene} />
        <PlayFromHere loadedScene={loadedScene} />
        <PlacementController loader={loader} loadedScene={loadedScene} />
        {/* Behaviours-only play. Walk mode runs them through the game runtime instead, so this
            stays out of the way rather than driving the same objects twice. */}
        {!walking && <BehaviorPreview loadedScene={loadedScene} />}
        <PhysicsPreview loadedScene={loadedScene} resolver={resolver} loader={loader} />
        <WaypointEditor loadedScene={loadedScene} />
        {!playing && <SculptController loadedScene={loadedScene} />}
        {/* Outside the select-tool branch on purpose: a collaborator's selection is worth seeing
            while you are sculpting or painting, and it is the only cue that somebody else is about
            to change the thing under your brush. */}
        {!playing && <PeerHighlight loadedScene={loadedScene} />}
        {tool === 'select' && !playing && !editingWaypoints && (
          <>
            <SelectionController loadedScene={loadedScene} />
            <SelectionHighlight loadedScene={loadedScene} />
            <TransformGizmo />
          </>
        )}
        {!walking && !furnitureHidden && (
          <Grid
            // Named so it can be found and hidden. The export QA suite compares an editor
            // screenshot against an export of the same scene, and the grid is editor furniture that
            // an export correctly does not have — so a comparison that leaves it visible is
            // comparing two things that are meant to differ.
            name="editor-grid"
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
          // Orbit is available while ejected: that is the whole point of ejecting.
          enabled={!dragging && !gizmoActive && (!walking || !possessed) && tool === 'select'}
        />
      </Canvas>

      <MarqueeOverlay />
      <PlayFromHereMenu />

      {walking && (
        <div className="walk-hint" role="status" aria-label="Walk mode">
          <strong>{possessed ? 'Walking' : 'Ejected'}</strong>
          <span>
            {possessed
              ? 'WASD move · Shift sprint · C crouch · Space jump · V camera · F8 eject · Escape to return'
              : 'Ejected — drag to look, the world keeps running · F8 to take control · Escape to return'}
          </span>
          {cameraMode && <span className="walk-mode">{cameraMode}</span>}
          {uiScreen && uiScreen !== 'playing' && <span className="walk-mode">{uiScreen}</span>}
        </div>
      )}

      {/* The game shell draws its own health bar from `uiConfig`. This one is the fallback for a
          document that has the shell switched off. */}
      {walking && uiScreen === null && playerHealth !== null && (
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
