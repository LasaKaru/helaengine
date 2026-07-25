import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { pickObject, type LoadedScene } from '@helaengine/engine';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';

interface SelectionControllerProps {
  loadedScene: LoadedScene | null;
}

/** Below this many pixels a drag is treated as a click, not a marquee. */
const MARQUEE_THRESHOLD = 4;

/**
 * Click-to-select, shift to extend, and drag-on-empty-space to marquee-select.
 *
 * Selection is decided against the Three.js scene rather than the document, because "what did the
 * user click" is a question only the rendered geometry can answer.
 */
export function SelectionController({ loadedScene }: SelectionControllerProps): null {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);
  const start = useRef<{ x: number; y: number; additive: boolean } | null>(null);

  useEffect(() => {
    if (!loadedScene) return;

    const toNdc = (clientX: number, clientY: number): THREE.Vector2 => {
      const rect = domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const handleDown = (event: PointerEvent): void => {
      // Placement drags and gizmo drags own the pointer while they are active.
      if (event.button !== 0 || useEditorStore.getState().drag) return;
      if (useEditorStore.getState().gizmoActive) return;
      start.current = { x: event.clientX, y: event.clientY, additive: event.shiftKey };
    };

    const handleMove = (event: PointerEvent): void => {
      const origin = start.current;
      if (!origin) return;

      const dx = Math.abs(event.clientX - origin.x);
      const dy = Math.abs(event.clientY - origin.y);
      if (dx < MARQUEE_THRESHOLD && dy < MARQUEE_THRESHOLD) return;

      useEditorStore.getState().setMarquee({
        x1: origin.x,
        y1: origin.y,
        x2: event.clientX,
        y2: event.clientY,
      });
    };

    const handleUp = (event: PointerEvent): void => {
      const origin = start.current;
      start.current = null;
      const marquee = useEditorStore.getState().marquee;
      useEditorStore.getState().setMarquee(null);
      if (!origin) return;

      const sceneState = useSceneStore.getState();

      if (marquee) {
        // Marquee hits are decided by projecting each object's origin into screen space. Cheap,
        // predictable, and it matches what users expect from a rubber-band selection.
        const rect = domElement.getBoundingClientRect();
        const minX = Math.min(marquee.x1, marquee.x2);
        const maxX = Math.max(marquee.x1, marquee.x2);
        const minY = Math.min(marquee.y1, marquee.y2);
        const maxY = Math.max(marquee.y1, marquee.y2);

        const inside: string[] = [];
        const projected = new THREE.Vector3();
        for (const [objectId, node] of loadedScene.objects) {
          node.getWorldPosition(projected).project(camera);
          const screenX = rect.left + ((projected.x + 1) / 2) * rect.width;
          const screenY = rect.top + ((1 - projected.y) / 2) * rect.height;
          if (screenX >= minX && screenX <= maxX && screenY >= minY && screenY <= maxY) {
            inside.push(objectId);
          }
        }

        sceneState.select(
          origin.additive ? [...new Set([...sceneState.selectedIds, ...inside])] : inside,
        );
        return;
      }

      raycaster.setFromCamera(toNdc(event.clientX, event.clientY), camera);
      const objectId = pickObject(raycaster, loadedScene);

      if (!objectId) {
        // Clicking empty space clears, unless the user is extending a selection.
        if (!origin.additive) sceneState.clearSelection();
        return;
      }

      if (origin.additive) sceneState.toggleSelected(objectId);
      else sceneState.select([objectId]);
    };

    domElement.addEventListener('pointerdown', handleDown);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      domElement.removeEventListener('pointerdown', handleDown);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
  }, [loadedScene, camera, domElement, raycaster]);

  return null;
}
