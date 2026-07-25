import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { pickTerrain, type LoadedScene, type SceneLoader } from '@helaengine/engine';
import { SceneObjectSchema } from '@helaengine/schema';
import { computePlacement } from '../placement';
import { useEditorStore } from '../store/editorStore';
import { nextObjectId, useSceneStore } from '../store/sceneStore';

interface PlacementControllerProps {
  loader: SceneLoader;
  loadedScene: LoadedScene | null;
}

/** Ghost material: readable against both terrain and sky, and unmistakably not placed yet. */
function makeGhostMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: '#8fd694',
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    roughness: 1,
  });
}

/**
 * Drives drag-to-place: follows the pointer, raycasts the terrain, shows a ghost of the asset at
 * the hit point, and commits an object to the scene document on release.
 *
 * Pointer events rather than HTML5 drag-and-drop, deliberately. The transform gizmos in Sprint 5
 * are pointer-driven, and mixing the two interaction models in one viewport produces subtly
 * different drag thresholds and cancel behaviour for no benefit.
 */
export function PlacementController({
  loader,
  loadedScene,
}: PlacementControllerProps): React.JSX.Element | null {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);

  const drag = useEditorStore((state) => state.drag);
  const assetId = drag?.assetId ?? null;

  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const ghostRef = useRef<THREE.Object3D | null>(null);
  const hitRef = useRef<{ point: THREE.Vector3; normal: THREE.Vector3 } | null>(null);

  // Build the ghost from the same node the real placement will use, so what the user lines up is
  // what they get. Rebuilt whenever the dragged asset changes, disposed when the drag ends.
  const preview = useMemo(
    () => (assetId ? loader.createPreviewNode(assetId) : null),
    [assetId, loader],
  );

  useEffect(() => {
    if (!preview) return;

    const material = makeGhostMaterial();
    preview.node.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.material = material;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
    });
    preview.node.visible = false;
    ghostRef.current = preview.node;

    return () => {
      ghostRef.current = null;
      material.dispose();
      preview.dispose();
    };
  }, [preview]);

  useEffect(() => {
    if (!drag || !loadedScene) return;

    const updateDrag = useEditorStore.getState().updateDrag;
    const endDrag = useEditorStore.getState().endDrag;

    const toNdc = (event: PointerEvent): THREE.Vector2 => {
      const rect = domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const handleMove = (event: PointerEvent): void => {
      raycaster.setFromCamera(toNdc(event), camera);
      const hit = pickTerrain(raycaster, loadedScene);
      hitRef.current = hit;

      const ghost = ghostRef.current;
      if (ghost) {
        ghost.visible = hit !== null;
        if (hit) {
          const { position, rotation } = computePlacement(
            hit.point,
            hit.normal,
            useEditorStore.getState().placement,
          );
          ghost.position.set(...position);
          ghost.rotation.set(
            THREE.MathUtils.degToRad(rotation[0]),
            THREE.MathUtils.degToRad(rotation[1]),
            THREE.MathUtils.degToRad(rotation[2]),
          );
        }
      }

      updateDrag(event.clientX, event.clientY, hit !== null);
    };

    const handleUp = (event: PointerEvent): void => {
      handleMove(event);
      const hit = hitRef.current;

      // Dropping off the terrain — over the sky, or outside the viewport — cancels rather than
      // guessing a position. Silently placing an object at y=0 somewhere off-screen is worse than
      // nothing happening.
      if (hit) {
        const sceneState = useSceneStore.getState();
        const { position, rotation } = computePlacement(
          hit.point,
          hit.normal,
          useEditorStore.getState().placement,
        );

        sceneState.addObject(
          SceneObjectSchema.parse({
            id: nextObjectId(sceneState.scene),
            assetId: drag.assetId,
            transform: { position, rotation, scale: [1, 1, 1] },
          }),
        );
      }

      hitRef.current = null;
      endDrag();
    };

    const handleCancel = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        hitRef.current = null;
        endDrag();
      }
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('keydown', handleCancel);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('keydown', handleCancel);
    };
  }, [drag, loadedScene, camera, domElement, raycaster]);

  if (!preview) return null;
  return <primitive object={preview.node} />;
}
