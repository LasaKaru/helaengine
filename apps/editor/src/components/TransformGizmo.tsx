import { useEffect, useMemo, useRef } from 'react';
import { TransformControls } from '@react-three/drei';
import * as THREE from 'three';
import type { Transform } from '@helaengine/schema';
import {
  applyGroupDelta,
  normalizeAngle,
  selectionPivot,
  snapPosition,
  type GroupDelta,
} from '../transform';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

function tidy(value: number): number {
  return Number(value.toFixed(4));
}

/**
 * The move/rotate/scale gizmo.
 *
 * Two paths, because they want different things:
 *
 * - **One object selected** — the gizmo attaches to that object's own node, so rotate and scale
 *   act on its local axes, which is what anyone who has used a 3D tool expects.
 * - **Several selected** — the gizmo attaches to an invisible proxy at the selection centroid, and
 *   the frame's delta is applied to every object about that pivot. That makes the selection behave
 *   like one rigid thing instead of each object spinning in place.
 *
 * Writes go to the store on every change, not on release. The inspector fields update live, and
 * `LoadedScene.syncTransforms` makes each write cheap enough to do per frame.
 */
export function TransformGizmo(): React.JSX.Element | null {
  const selectedIds = useSceneStore((state) => state.selectedIds);
  const objects = useSceneStore((state) => state.scene.objects);
  const mode = useEditorStore((state) => state.gizmoMode);
  const placement = useEditorStore((state) => state.placement);

  const selected = useMemo(
    () => objects.filter((object) => selectedIds.includes(object.id)),
    [objects, selectedIds],
  );

  const proxy = useMemo(() => {
    const node = new THREE.Object3D();
    node.name = 'gizmo-proxy';
    return node;
  }, []);

  // The transform each selected object had when the current drag started. Deltas are measured
  // against this rather than the previous frame, so rounding never accumulates across a drag.
  const dragStart = useRef<{
    pivot: [number, number, number];
    transforms: Map<string, Transform>;
  } | null>(null);

  const dragGroup = useRef<string | null>(null);
  const pivot = useMemo(() => selectionPivot(selected), [selected]);
  const single = selected.length === 1 ? selected[0] : null;

  // Park the proxy on the selection whenever it changes, but never mid-drag — moving the gizmo's
  // own target while the user is dragging it makes the object skate away from the cursor.
  //
  // A single selection parks the proxy *on the object*, matching its rotation and scale, so the
  // gizmo's axes are the object's axes. A multi-selection parks it unrotated at the centroid,
  // because a group has no orientation of its own.
  useEffect(() => {
    if (dragStart.current) return;

    if (single) {
      proxy.position.set(...single.transform.position);
      proxy.rotation.set(
        single.transform.rotation[0] * DEG2RAD,
        single.transform.rotation[1] * DEG2RAD,
        single.transform.rotation[2] * DEG2RAD,
      );
      proxy.scale.set(...single.transform.scale);
      return;
    }

    proxy.position.set(pivot[0], pivot[1], pivot[2]);
    proxy.rotation.set(0, 0, 0);
    proxy.scale.set(1, 1, 1);
  }, [proxy, pivot, single, selectedIds]);

  if (selected.length === 0) return null;

  const beginDrag = (): void => {
    const state = useSceneStore.getState();
    // One id for the whole drag, so sixty frames of updates collapse into a single undo step.
    dragGroup.current = `gizmo:${Date.now()}`;
    dragStart.current = {
      pivot,
      transforms: new Map(
        state.scene.objects
          .filter((object) => selectedIds.includes(object.id))
          .map((object) => [
            object.id,
            {
              position: [...object.transform.position],
              rotation: [...object.transform.rotation],
              scale: [...object.transform.scale],
            } as Transform,
          ]),
      ),
    };
    useEditorStore.getState().setGizmoActive(true);
  };

  const endDrag = (): void => {
    dragStart.current = null;
    dragGroup.current = null;
    useEditorStore.getState().setGizmoActive(false);
    proxy.position.set(pivot[0], pivot[1], pivot[2]);
    proxy.rotation.set(0, 0, 0);
    proxy.scale.set(1, 1, 1);
  };

  const handleChange = (): void => {
    const origin = dragStart.current;
    if (!origin) return;
    const store = useSceneStore.getState();

    if (single) {
      // Single selection: the gizmo is on the object, so read its node straight back out.
      const node = proxy;
      const position: [number, number, number] = [
        tidy(node.position.x),
        tidy(node.position.y),
        tidy(node.position.z),
      ];
      const start = origin.transforms.get(single.id);
      if (!start) return;

      store.setTransforms(
        [
          {
            id: single.id,
            transform: {
              position:
                mode === 'translate' && placement.snapToGrid
                  ? snapPosition(position, placement.gridSize)
                  : position,
              rotation: [
                tidy(normalizeAngle(node.rotation.x * RAD2DEG)),
                tidy(normalizeAngle(node.rotation.y * RAD2DEG)),
                tidy(normalizeAngle(node.rotation.z * RAD2DEG)),
              ],
              scale: [tidy(node.scale.x), tidy(node.scale.y), tidy(node.scale.z)],
            },
          },
        ],
        dragGroup.current ?? undefined,
      );
      return;
    }

    const delta: GroupDelta = {
      translation: [
        tidy(proxy.position.x - origin.pivot[0]),
        tidy(proxy.position.y - origin.pivot[1]),
        tidy(proxy.position.z - origin.pivot[2]),
      ],
      yaw: tidy(normalizeAngle(proxy.rotation.y * RAD2DEG)),
      scale: [tidy(proxy.scale.x), tidy(proxy.scale.y), tidy(proxy.scale.z)],
    };

    // `applyGroupDelta` only reads ids and transforms; the rest of the shape is filled in so the
    // helper can keep taking real scene objects rather than a bespoke tuple.
    const sources = [...origin.transforms].map(([id, transform]) => ({
      id,
      assetId: '',
      parentId: null,
      transform,
      behaviors: [],
      physics: { body: 'static' as const, collider: 'auto' as const },
      animation: null,
      material: null,
      trigger: null,
      sway: 'auto' as const,
      metadata: {},
    }));

    const updated = applyGroupDelta(sources, origin.pivot, delta).map((update) =>
      mode === 'translate' && placement.snapToGrid
        ? {
            ...update,
            transform: {
              ...update.transform,
              position: snapPosition(update.transform.position, placement.gridSize),
            },
          }
        : update,
    );

    store.setTransforms(updated, dragGroup.current ?? undefined);
  };

  return (
    <>
      <primitive object={proxy} />
      <TransformControls
        object={proxy}
        mode={mode}
        size={0.9}
        translationSnap={placement.snapToGrid ? placement.gridSize : null}
        rotationSnap={placement.snapToGrid ? Math.PI / 12 : null}
        onMouseDown={beginDrag}
        onMouseUp={endDrag}
        onObjectChange={handleChange}
      />
    </>
  );
}
