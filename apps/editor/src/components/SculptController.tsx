import { useEffect, useMemo, useRef } from 'react';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { pickTerrain, type LoadedScene } from '@helaengine/engine';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';

interface SculptControllerProps {
  loadedScene: LoadedScene | null;
}

/** Stroke samples are applied at most this often, so a fast mouse cannot outrun the GPU upload. */
const STROKE_INTERVAL_MS = 16;

/**
 * Height gained per second at full strength, in normalised units.
 *
 * `TerrainField.sculpt` takes a per-application delta, so without scaling by elapsed time a stroke
 * would build height at whatever rate the machine happens to render — and on a fast machine a
 * flick of the mouse raised a 30m hill instantly.
 */
const SCULPT_RATE = 1.2;
/** Blend operations converge rather than accumulate, so they can afford a faster rate. */
const BLEND_RATE = 8;

/**
 * Sculpting and painting.
 *
 * A stroke mutates the `TerrainField` and refreshes the geometry directly — the scene document is
 * not touched until the pointer comes up. That is the difference between a smooth drag and a
 * stuttering one: the heightmap is a single base64 blob in the document, so committing it per
 * frame would push megabytes through the store and the undo stack for one gesture.
 */
export function SculptController({ loadedScene }: SculptControllerProps): null {
  const camera = useThree((state) => state.camera);
  const domElement = useThree((state) => state.gl.domElement);
  const raycaster = useMemo(() => new THREE.Raycaster(), []);

  const tool = useEditorStore((state) => state.tool);
  const active = tool === 'sculpt' || tool === 'paint';

  const stroking = useRef(false);
  const lastSample = useRef(0);
  const dirty = useRef(false);

  // A live cursor ring showing where the brush will land and how wide it is.
  const cursor = useMemo(() => {
    const geometry = new THREE.RingGeometry(0.97, 1, 48);
    geometry.rotateX(-Math.PI / 2);
    const material = new THREE.MeshBasicMaterial({
      color: '#8fd694',
      transparent: true,
      opacity: 0.85,
      depthTest: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'brush-cursor';
    mesh.renderOrder = 10;
    mesh.visible = false;
    return mesh;
  }, []);

  const threeScene = useThree((state) => state.scene);

  useEffect(() => {
    if (!active) return;
    threeScene.add(cursor);
    return () => {
      cursor.visible = false;
      threeScene.remove(cursor);
    };
  }, [active, cursor, threeScene]);

  useEffect(
    () => () => {
      cursor.geometry.dispose();
      (cursor.material as THREE.Material).dispose();
    },
    [cursor],
  );

  useEffect(() => {
    if (!active || !loadedScene) return;

    const field = loadedScene.terrainField;
    if (!field) return;

    const toNdc = (event: PointerEvent): THREE.Vector2 => {
      const rect = domElement.getBoundingClientRect();
      return new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
    };

    const hitAt = (event: PointerEvent): THREE.Vector3 | null => {
      raycaster.setFromCamera(toNdc(event), camera);
      return pickTerrain(raycaster, loadedScene)?.point ?? null;
    };

    const layerColors = (): string[] =>
      useSceneStore.getState().scene.terrain.layers.map((layer) => layer.color);

    const applyAt = (point: THREE.Vector3, deltaSeconds: number): void => {
      const { brush, tool: currentTool } = useEditorStore.getState();
      // Raise and lower accumulate height, so they move at the slower rate. Paint, smooth and
      // flatten converge on a target and can afford to get there faster.
      const accumulating =
        currentTool === 'sculpt' && (brush.sculptMode === 'raise' || brush.sculptMode === 'lower');
      const scaled = {
        radius: brush.radius,
        strength: brush.strength * deltaSeconds * (accumulating ? SCULPT_RATE : BLEND_RATE),
      };

      const changed =
        currentTool === 'paint'
          ? field.paint(point.x, point.z, brush.layer, scaled)
          : field.sculpt(point.x, point.z, brush.sculptMode, scaled);

      if (!changed) return;
      loadedScene.refreshTerrain(layerColors());
      dirty.current = true;
    };

    const handleMove = (event: PointerEvent): void => {
      const point = hitAt(event);

      const { brush } = useEditorStore.getState();
      cursor.visible = point !== null;
      if (point) {
        // Lifted a little so the ring is not z-fighting the ground it is describing.
        cursor.position.set(point.x, point.y + 0.05, point.z);
        cursor.scale.set(brush.radius, 1, brush.radius);
      }

      if (!stroking.current || !point) return;

      const now = performance.now();
      const elapsed = now - lastSample.current;
      if (elapsed < STROKE_INTERVAL_MS) return;
      lastSample.current = now;
      // Clamped so a stall — a tab switch, a long frame — cannot land one enormous stroke.
      applyAt(point, Math.min(elapsed, 100) / 1000);
    };

    const handleDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      const point = hitAt(event);
      if (!point) return;

      event.preventDefault();
      stroking.current = true;
      lastSample.current = performance.now();
      applyAt(point, STROKE_INTERVAL_MS / 1000);
    };

    const handleUp = (): void => {
      if (!stroking.current) return;
      stroking.current = false;

      // The whole stroke lands as one undo step, here.
      if (dirty.current) {
        dirty.current = false;
        useSceneStore.getState().setTerrainData(field.encodeHeights(), field.encodeWeights());
      }
    };

    domElement.addEventListener('pointerdown', handleDown);
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    return () => {
      domElement.removeEventListener('pointerdown', handleDown);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      handleUp();
    };
  }, [active, loadedScene, camera, domElement, raycaster, cursor]);

  return null;
}
