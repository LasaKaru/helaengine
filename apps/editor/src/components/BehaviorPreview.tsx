import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import {
  BehaviorRuntime,
  pickTerrain,
  registerBuiltinBehaviors,
  type LoadedScene,
} from '@helaengine/engine';
import type { Vec3 } from '@helaengine/schema';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';

registerBuiltinBehaviors();

/**
 * Runs the scene's behaviours in the viewport while play mode is on.
 *
 * The runtime moves the Three.js nodes directly and never touches the document — so stopping is
 * just a matter of re-applying the document's transforms, and a preview can never accidentally
 * become an edit. This is the same `BehaviorRuntime` an exported project runs; the editor's only
 * addition is knowing when to start and stop it.
 */
export function BehaviorPreview({ loadedScene }: { loadedScene: LoadedScene | null }): null {
  const playing = useEditorStore((state) => state.playing);
  const scene = useSceneStore((state) => state.scene);
  const runtime = useRef<BehaviorRuntime | null>(null);

  useEffect(() => {
    if (!playing || !loadedScene) return;

    const instance = new BehaviorRuntime({ loaded: loadedScene, scene });
    instance.start();
    runtime.current = instance;

    if (instance.problems.length > 0) {
      console.warn('[helaengine] behaviour problems:', instance.problems);
    }

    return () => {
      instance.stop();
      runtime.current = null;
      // Put every object back where the document says it is. Without this, stopping would leave
      // actors wherever their patrol happened to reach.
      loadedScene.syncTransforms(scene);
    };
  }, [playing, loadedScene, scene]);

  useFrame((_state, delta) => {
    runtime.current?.update(delta);
  });

  return null;
}

/**
 * Click-to-add waypoints.
 *
 * Path editing is the one behaviour parameter that is hopeless to type in by hand — the numbers
 * only mean something in relation to the ground — so it gets a viewport interaction while the
 * rest of the params stay auto-generated fields.
 */
export function WaypointEditor({ loadedScene }: { loadedScene: LoadedScene | null }): null {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const threeScene = useThree((state) => state.scene);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  const editing = useEditorStore((state) => state.editingWaypoints);
  const objects = useSceneStore((state) => state.scene.objects);

  const markers = useMemo(() => {
    const group = new THREE.Group();
    group.name = 'waypoint-markers';
    return group;
  }, []);

  // Draw the path being edited: a sphere per point, a line through them.
  useEffect(() => {
    threeScene.add(markers);
    return () => {
      threeScene.remove(markers);
    };
  }, [threeScene, markers]);

  const points: Vec3[] = useMemo(() => {
    if (!editing) return [];
    const [objectId, indexText] = editing.split(':');
    const object = objects.find((item) => item.id === objectId);
    const entry = object?.behaviors[Number(indexText)];
    const waypoints = entry?.params['waypoints'];
    return Array.isArray(waypoints) ? (waypoints as Vec3[]) : [];
  }, [editing, objects]);

  useEffect(() => {
    for (const child of [...markers.children]) {
      markers.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry?.dispose();
      if (mesh.material) (mesh.material as THREE.Material).dispose();
    }
    if (points.length === 0) return;

    const material = new THREE.MeshBasicMaterial({ color: '#8fd694', depthTest: false });
    const geometry = new THREE.SphereGeometry(0.45, 12, 8);
    for (const point of points) {
      const marker = new THREE.Mesh(geometry, material);
      marker.position.set(point[0], point[1] + 0.5, point[2]);
      marker.renderOrder = 11;
      markers.add(marker);
    }

    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(
        points.map((point) => new THREE.Vector3(point[0], point[1] + 0.5, point[2])),
      ),
      new THREE.LineBasicMaterial({ color: '#8fd694', depthTest: false }),
    );
    line.renderOrder = 11;
    markers.add(line);

    return () => {
      geometry.dispose();
      material.dispose();
    };
  }, [markers, points]);

  useEffect(() => {
    if (!editing || !loadedScene) return;

    const handleDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;

      const rect = domElement.getBoundingClientRect();
      raycaster.setFromCamera(
        new THREE.Vector2(
          ((event.clientX - rect.left) / rect.width) * 2 - 1,
          -((event.clientY - rect.top) / rect.height) * 2 + 1,
        ),
        camera,
      );

      const hit = pickTerrain(raycaster, loadedScene);
      if (!hit) return;
      event.preventDefault();

      const [objectId, indexText] = editing.split(':');
      if (!objectId) return;
      const index = Number(indexText);

      const state = useSceneStore.getState();
      const object = state.scene.objects.find((item) => item.id === objectId);
      const entry = object?.behaviors[index];
      if (!entry) return;

      const existing = Array.isArray(entry.params['waypoints'])
        ? (entry.params['waypoints'] as Vec3[])
        : [];
      const point: Vec3 = [
        Number(hit.point.x.toFixed(2)),
        Number(hit.point.y.toFixed(2)),
        Number(hit.point.z.toFixed(2)),
      ];

      state.setBehaviorParams(objectId, index, {
        ...entry.params,
        waypoints: [...existing, point],
      });
    };

    domElement.addEventListener('pointerdown', handleDown);
    return () => domElement.removeEventListener('pointerdown', handleDown);
  }, [editing, loadedScene, camera, domElement, raycaster]);

  return null;
}
