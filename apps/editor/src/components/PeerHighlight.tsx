import { useEffect, useMemo } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { LoadedScene } from '@helaengine/engine';
import { useCollabPeers } from '../collab/current';
import { useSceneStore } from '../store/sceneStore';

/**
 * Draws a box around what everybody else has selected, in their own colour.
 *
 * The same `BoxHelper` the local selection uses, for the same reasons — one line-segment draw, no
 * render pipeline changes — and deliberately the same *shape*, so that "somebody has this" reads
 * identically whether it is you or a colleague. The colour is what says who.
 *
 * A peer who is mid-gesture gets a second, slightly larger box. That is the soft lock: the CRDT
 * would resolve two people dragging one object without complaint, but they would spend ten seconds
 * watching it stutter before either realised why. A visible "someone is moving this" costs one more
 * helper and removes the confusion entirely, without ever *preventing* an edit — which is the part
 * that matters, because a hard lock in a creative tool is a queue.
 */
export function PeerHighlight({
  loadedScene,
}: {
  loadedScene: LoadedScene | null;
}): React.JSX.Element | null {
  const threeScene = useThree((state) => state.scene);
  const peers = useCollabPeers();
  const objects = useSceneStore((state) => state.scene.objects);

  const group = useMemo(() => {
    const node = new THREE.Group();
    node.name = 'peer-highlight';
    return node;
  }, []);

  useEffect(() => {
    threeScene.add(group);
    return () => {
      threeScene.remove(group);
    };
  }, [threeScene, group]);

  useEffect(() => {
    const clear = (): void => {
      for (const child of [...group.children]) {
        group.remove(child);
        (child as THREE.BoxHelper).dispose?.();
      }
    };

    clear();
    if (!loadedScene) return;

    for (const peer of peers) {
      const color = new THREE.Color(peer.color);

      for (const objectId of peer.selection) {
        const node = loadedScene.objects.get(objectId);
        // A selection can name an object this client has already seen deleted — the two facts
        // travel on different channels and arrive in either order. Skipping is correct and
        // temporary; the next presence update will not mention it.
        if (!node) continue;

        const helper = new THREE.BoxHelper(node, color);
        helper.name = `peer:${peer.userId}:${objectId}`;
        group.add(helper);

        if (!peer.editing) continue;

        // The soft lock: a second, larger box so "being moved right now" is distinguishable from
        // "merely selected" at a glance, without a label to read.
        const lock = new THREE.BoxHelper(node, color);
        lock.name = `peer-lock:${peer.userId}:${objectId}`;
        lock.scale.multiplyScalar(1.12);
        group.add(lock);
      }
    }

    return clear;
    // `objects` is a dependency because somebody else's box has to follow the object they are
    // moving, and a transform edit changes the scene rather than the presence.
  }, [group, loadedScene, peers, objects]);

  return null;
}
