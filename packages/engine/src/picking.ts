import * as THREE from 'three';
import type { LoadedScene } from './SceneLoader.js';

export interface SurfaceHit {
  /** World-space point on the surface. */
  point: THREE.Vector3;
  /** World-space surface normal, or +Y when the geometry supplied none. */
  normal: THREE.Vector3;
}

const UP = new THREE.Vector3(0, 1, 0);

/**
 * Casts a ray at the terrain and reports where it lands.
 *
 * This lives in the engine rather than the editor because it is not an editor concern: play mode,
 * spawn points and the AI layout pass all need to answer "where is the ground under this ray".
 * The editor is simply the first caller.
 */
export function pickTerrain(raycaster: THREE.Raycaster, loaded: LoadedScene): SurfaceHit | null {
  const terrain = loaded.threeScene.getObjectByName('terrain');
  if (!terrain) return null;

  const [hit] = raycaster.intersectObject(terrain, false);
  if (!hit) return null;

  const normal = hit.normal
    ? hit.normal.clone().transformDirection(terrain.matrixWorld).normalize()
    : UP.clone();

  return { point: hit.point.clone(), normal };
}

/**
 * Casts a ray at the placed objects and reports which one was hit.
 *
 * Returns the scene object's id rather than the mesh, since a hit can land on a nested part of a
 * model and callers care about the object the user thinks they clicked.
 */
export function pickObject(raycaster: THREE.Raycaster, loaded: LoadedScene): string | null {
  const roots = [...loaded.objects.values()];
  if (roots.length === 0) return null;

  for (const hit of raycaster.intersectObjects(roots, true)) {
    for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
      const objectId = node.userData['objectId'];
      if (typeof objectId === 'string') return objectId;
    }
  }
  return null;
}
