import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  isBuiltinTriggerAsset,
  pickTerrain,
  type LoadedScene,
  type SceneLoader,
} from '@helaengine/engine';
import { SceneObjectSchema } from '@helaengine/schema';
import { triggerDefaults } from '../triggers';
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
export function PlacementController({ loader, loadedScene }: PlacementControllerProps): null {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const threeScene = useThree((state) => state.scene);

  const drag = useEditorStore((state) => state.drag);
  const assetId = drag?.assetId ?? null;

  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const ghostRef = useRef<THREE.Object3D | null>(null);
  const hitRef = useRef<{ point: THREE.Vector3; normal: THREE.Vector3 } | null>(null);

  // The ghost is built from the same node a real placement will use, so what the user lines up is
  // what they get. It is added straight to the scene rather than rendered as JSX: it is created
  // and destroyed by a drag, not by React, and routing it through state would mean a re-render
  // per drag just to hand r3f an object the effect already has.
  useEffect(() => {
    if (!assetId) return;

    const preview = loader.createPreviewNode(assetId);
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
    threeScene.add(preview.node);

    return () => {
      ghostRef.current = null;
      threeScene.remove(preview.node);
      material.dispose();
      preview.dispose();
    };
  }, [assetId, loader, threeScene]);

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

        // A trigger has no model, so it lands as a volume: an outline the user can scale, with a
        // starting size big enough to walk into rather than a one-metre speck.
        const logic = isBuiltinTriggerAsset(drag.assetId);

        sceneState.addObject(
          SceneObjectSchema.parse({
            id: nextObjectId(sceneState.scene),
            assetId: drag.assetId,
            transform: {
              position,
              rotation: logic ? [0, 0, 0] : rotation,
              scale: logic ? [4, 3, 4] : [1, 1, 1],
            },
            ...(logic ? { trigger: triggerDefaults(drag.assetId) } : {}),
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

  return null;
}
