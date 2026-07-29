import * as THREE from 'three';

/** One mesh of a template, with its transform relative to the template's root. */
interface TemplatePart {
  geometry: THREE.BufferGeometry;
  material: THREE.Material | THREE.Material[];
  offset: THREE.Matrix4;
}

interface Batch {
  assetId: string;
  parts: THREE.InstancedMesh[];
  offsets: THREE.Matrix4[];
  /** Object id at each instance slot. Holes are `null` after a removal. */
  slots: Array<string | null>;
  indexByObject: Map<string, number>;
}

const composed = new THREE.Matrix4();
const HIDDEN = new THREE.Matrix4().makeScale(0, 0, 0);

/**
 * Pulls the drawable meshes out of a template, flattened into the template root's space.
 *
 * A GLB is a small tree — a trunk mesh and a canopy mesh under a group, say — and each distinct
 * geometry/material pair becomes its own `InstancedMesh`. So a tree that is two meshes costs two
 * draw calls no matter whether there are five of them or five hundred, which is the whole point.
 */
function collectParts(template: THREE.Object3D): TemplatePart[] {
  template.updateWorldMatrix(false, true);
  const inverse = new THREE.Matrix4().copy(template.matrixWorld).invert();
  const parts: TemplatePart[] = [];

  template.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    parts.push({
      geometry: mesh.geometry,
      material: mesh.material,
      offset: new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld),
    });
  });

  return parts;
}

/**
 * Draws repeated static objects as instanced meshes.
 *
 * Five hundred pine trees are five hundred draw calls, and draw calls are the thing a browser
 * renderer runs out of first — long before it runs out of triangles. Batching identical assets into
 * one `InstancedMesh` each turns that into one call per distinct mesh, which is the single largest
 * win available in a scene built out of a small asset library.
 *
 * What it deliberately does *not* do is take those objects out of the editor. Each one still has a
 * node in `LoadedScene.objects` — detached from the scene graph, so it costs nothing to render —
 * carrying the same transform and bounds. Selection boxes, framing and transform sync all keep
 * working on it, and `raycast` maps a hit on a batch back to the object the user thinks they
 * clicked. Instancing that made objects unselectable would be a rendering optimisation that broke
 * the editor, which is not an optimisation.
 */
export class InstanceManager {
  readonly #batches = new Map<string, Batch>();
  readonly #objectToBatch = new Map<string, Batch>();
  readonly #root: THREE.Object3D;

  constructor(root: THREE.Object3D) {
    this.#root = root;
  }

  get batchCount(): number {
    return this.#batches.size;
  }

  /** Draw calls these batches cost — one per distinct mesh in each batched asset. */
  get drawCalls(): number {
    let calls = 0;
    for (const batch of this.#batches.values()) calls += batch.parts.length;
    return calls;
  }

  get instancedObjectIds(): string[] {
    return [...this.#objectToBatch.keys()];
  }

  has(objectId: string): boolean {
    return this.#objectToBatch.has(objectId);
  }

  /**
   * Builds a batch for one asset.
   *
   * `template` is the same node a non-instanced placement would get, so what is drawn is identical
   * either way — including the manifest's default scale, which is already baked into the template.
   */
  addBatch(assetId: string, template: THREE.Object3D, matrices: Map<string, THREE.Matrix4>): void {
    const parts = collectParts(template);
    if (parts.length === 0 || matrices.size === 0) return;

    const slots = [...matrices.keys()];
    const meshes = parts.map((part) => {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, slots.length);
      mesh.name = `instances:${assetId}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // Static by definition — these are the objects nothing moves at runtime.
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.userData['assetId'] = assetId;
      return mesh;
    });

    const batch: Batch = {
      assetId,
      parts: meshes,
      offsets: parts.map((part) => part.offset),
      slots,
      indexByObject: new Map(slots.map((objectId, index) => [objectId, index])),
    };

    for (const [objectId, matrix] of matrices) {
      this.#write(batch, batch.indexByObject.get(objectId)!, matrix);
      this.#objectToBatch.set(objectId, batch);
    }

    for (const mesh of meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      this.#root.add(mesh);
    }
    this.#batches.set(assetId, batch);
  }

  /** Moves one instance. Returns false when the object is not batched. */
  setMatrix(objectId: string, matrix: THREE.Matrix4): boolean {
    const batch = this.#objectToBatch.get(objectId);
    if (!batch) return false;

    const index = batch.indexByObject.get(objectId);
    if (index === undefined) return false;

    this.#write(batch, index, matrix);
    for (const mesh of batch.parts) mesh.instanceMatrix.needsUpdate = true;
    return true;
  }

  /**
   * Hides one instance by collapsing it to zero scale.
   *
   * Shrinking rather than rebuilding the buffer: removing a slot would renumber every instance
   * after it, and the alternative — a per-frame compaction pass — costs more than the empty slot
   * it saves. Zero-scaled instances are discarded by the rasteriser before they cost anything.
   */
  remove(objectId: string): void {
    const batch = this.#objectToBatch.get(objectId);
    if (!batch) return;

    const index = batch.indexByObject.get(objectId);
    if (index === undefined) return;

    this.#write(batch, index, HIDDEN, true);
    for (const mesh of batch.parts) mesh.instanceMatrix.needsUpdate = true;
    batch.slots[index] = null;
    batch.indexByObject.delete(objectId);
    this.#objectToBatch.delete(objectId);
  }

  /**
   * Maps a raycast hit on a batch back to the scene object it belongs to.
   *
   * Three reports `instanceId` for a hit on an `InstancedMesh`, which is exactly the slot number
   * the batch handed out — so the lookup is a single array index.
   */
  raycast(raycaster: THREE.Raycaster): { objectId: string; distance: number } | null {
    const meshes: THREE.InstancedMesh[] = [];
    for (const batch of this.#batches.values()) meshes.push(...batch.parts);
    if (meshes.length === 0) return null;

    for (const hit of raycaster.intersectObjects(meshes, false)) {
      if (hit.instanceId === undefined) continue;
      const batch = this.#batches.get(String(hit.object.userData['assetId']));
      const objectId = batch?.slots[hit.instanceId];
      if (objectId) return { objectId, distance: hit.distance };
    }
    return null;
  }

  dispose(): void {
    for (const batch of this.#batches.values()) {
      for (const mesh of batch.parts) {
        mesh.removeFromParent();
        // The geometry and materials belong to the template the batch was built from, and the
        // loader disposes those. Only the per-instance buffers are this object's to free.
        mesh.dispose();
      }
    }
    this.#batches.clear();
    this.#objectToBatch.clear();
  }

  #write(batch: Batch, index: number, matrix: THREE.Matrix4, raw = false): void {
    for (let part = 0; part < batch.parts.length; part += 1) {
      if (raw) {
        batch.parts[part]!.setMatrixAt(index, matrix);
        continue;
      }
      composed.multiplyMatrices(matrix, batch.offsets[part]!);
      batch.parts[part]!.setMatrixAt(index, composed);
    }
  }
}
