import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { LoadedScene } from '@helaengine/engine';
import { useSceneStore } from '../store/sceneStore';

/**
 * Draws a box around each selected object.
 *
 * A box helper rather than an outline post-process: it costs one line-segment draw per selection,
 * needs no render pipeline changes, and reads clearly against both the terrain and the sky. An
 * outline pass is a nicer look and a Sprint 12 concern, once there is a perf budget to spend.
 */
export function SelectionHighlight({
  loadedScene,
}: {
  loadedScene: LoadedScene | null;
}): React.JSX.Element | null {
  const threeScene = useThree((state) => state.scene);
  const selectedIds = useSceneStore((state) => state.selectedIds);
  const objects = useSceneStore((state) => state.scene.objects);

  const group = useMemo(() => {
    const node = new THREE.Group();
    node.name = 'selection-highlight';
    return node;
  }, []);

  useEffect(() => {
    threeScene.add(group);
    return () => {
      threeScene.remove(group);
    };
  }, [threeScene, group]);

  useEffect(() => {
    for (const child of [...group.children]) {
      group.remove(child);
      (child as THREE.BoxHelper).dispose?.();
    }
    if (!loadedScene) return;

    for (const objectId of selectedIds) {
      const node = loadedScene.objects.get(objectId);
      if (!node) continue;
      const helper = new THREE.BoxHelper(node, 0x8fd694);
      helper.name = `selection:${objectId}`;
      group.add(helper);
    }

    return () => {
      for (const child of [...group.children]) {
        group.remove(child);
        (child as THREE.BoxHelper).dispose?.();
      }
    };
    // `objects` is a dependency because a transform edit moves the box, not just a selection change.
  }, [group, loadedScene, selectedIds, objects]);

  return null;
}
