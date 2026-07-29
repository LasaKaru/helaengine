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
  // Only the nodes that are actually in the scene: a batched object's node is detached, and
  // raycasting it directly would report hits at a transform the renderer is not drawing at.
  const roots = [...loaded.objects.values()].filter((node) => node.parent !== null);

  let nearestId: string | null = null;
  let nearest = Number.POSITIVE_INFINITY;

  for (const hit of raycaster.intersectObjects(roots, true)) {
    for (let node: THREE.Object3D | null = hit.object; node; node = node.parent) {
      const objectId = node.userData['objectId'];
      if (typeof objectId === 'string') {
        nearestId = objectId;
        nearest = hit.distance;
        break;
      }
    }
    if (nearestId) break;
  }

  // Instanced objects are drawn by a batch, so the hit comes back with an instance number rather
  // than a node. Whichever is closer wins, so clicking a tree in front of a hut selects the tree.
  const instanced = loaded.instances?.raycast(raycaster);
  if (instanced && instanced.distance < nearest) return instanced.objectId;

  return nearestId;
}
