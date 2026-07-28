import * as THREE from 'three';
import type { ColliderType } from '@helaengine/schema';
import type { RapierModule } from './rapier.js';

type ColliderDesc = ReturnType<RapierModule['ColliderDesc']['cuboid']>;

/** Triangle soup in a node's own space, ready to become a Rapier trimesh. */
export interface TrimeshData {
  vertices: Float32Array;
  indices: Uint32Array;
}

const localMatrix = new THREE.Matrix4();
const nodeMatrix = new THREE.Matrix4();
const worldPosition = new THREE.Vector3();
const worldQuaternion = new THREE.Quaternion();
const worldScale = new THREE.Vector3();
const vertex = new THREE.Vector3();

/**
 * Collects a node's triangles in the space of its own position and rotation.
 *
 * Scale is deliberately baked into the vertices rather than left on the transform: a Rapier
 * collider has no scale of its own, so a tree placed at 1.4× has to be a 1.4×-sized shape. The
 * body then only ever carries position and rotation, which is also all a body can carry.
 *
 * Returns null when the node has no renderable geometry — a group of empties, or a model that
 * failed to load and is standing in as nothing.
 */
export function collectTrimesh(node: THREE.Object3D): TrimeshData | null {
  node.updateWorldMatrix(true, true);
  node.matrixWorld.decompose(worldPosition, worldQuaternion, worldScale);
  // Everything below is expressed relative to position+rotation only, so scale survives in the
  // vertex data where a collider can actually see it.
  nodeMatrix.compose(worldPosition, worldQuaternion, new THREE.Vector3(1, 1, 1)).invert();

  const vertices: number[] = [];
  const indices: number[] = [];

  node.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    const position = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position) return;

    localMatrix.multiplyMatrices(nodeMatrix, mesh.matrixWorld);
    const offset = vertices.length / 3;

    for (let index = 0; index < position.count; index += 1) {
      vertex.fromBufferAttribute(position, index).applyMatrix4(localMatrix);
      vertices.push(vertex.x, vertex.y, vertex.z);
    }

    const index = mesh.geometry.getIndex();
    if (index) {
      for (let at = 0; at < index.count; at += 1) indices.push(offset + index.getX(at));
    } else {
      for (let at = 0; at < position.count; at += 1) indices.push(offset + at);
    }
  });

  if (indices.length < 3) return null;
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

export interface ColliderShapeInput {
  shape: ColliderType;
  /** World-space bounding size in metres, [width, height, depth]. */
  size: [number, number, number];
  /** Supplies triangles for `mesh`. Ignored otherwise. */
  node?: THREE.Object3D;
}

/**
 * Turns a resolved collider type and a measured size into a Rapier descriptor.
 *
 * Assets are authored with their pivot at the base (see ASSET-CONVENTIONS.md), so every shape here
 * is lifted by half its height: a body sitting at y=0 is standing on the ground, not buried to the
 * waist in it. Getting this wrong is invisible in the editor and immediately obvious the first
 * time somebody walks into a building.
 *
 * Returns null for `none`, and for a `mesh` request that found no triangles — a caller should read
 * that as "this object does not collide" rather than falling back to a box, because a silent box
 * around a doorway is worse than no collider at all.
 */
export function colliderDescFor(
  rapier: RapierModule,
  input: ColliderShapeInput,
): ColliderDesc | null {
  const [width, height, depth] = input.size;
  const halfHeight = Math.max(height / 2, 0.01);

  switch (input.shape) {
    case 'none':
      return null;

    case 'box':
      return rapier.ColliderDesc.cuboid(
        Math.max(width / 2, 0.01),
        halfHeight,
        Math.max(depth / 2, 0.01),
      ).setTranslation(0, halfHeight, 0);

    case 'sphere': {
      // The largest sphere that still fits inside the measured bounds, so a rock never collides
      // wider than it looks.
      const radius = Math.max(Math.min(width, height, depth) / 2, 0.01);
      return rapier.ColliderDesc.ball(radius).setTranslation(0, radius, 0);
    }

    case 'capsule': {
      const radius = Math.max(Math.min(width, depth) / 2, 0.01);
      // A capsule's half-height excludes its caps; clamping keeps a short, wide asset from
      // producing a negative cylinder section.
      const cylinderHalf = Math.max(height / 2 - radius, 0.01);
      return rapier.ColliderDesc.capsule(cylinderHalf, radius).setTranslation(
        0,
        cylinderHalf + radius,
        0,
      );
    }

    case 'mesh': {
      if (!input.node) return null;
      const data = collectTrimesh(input.node);
      if (!data) return null;
      // No base offset: trimesh vertices are already where the model's own geometry puts them.
      return rapier.ColliderDesc.trimesh(data.vertices, data.indices);
    }

    default:
      return null;
  }
}
