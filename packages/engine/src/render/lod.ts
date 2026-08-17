import * as THREE from 'three';
import { LOD_PROFILES, lodDistances, type LodMode } from '@helaengine/schema';
import { simplifyGeometry, triangleCount } from './simplify.js';

/**
 * Turns one object's visual into a `THREE.LOD` with generated coarse levels.
 *
 * ## Where the swapping happens
 *
 * Nowhere in this file, and that is deliberate. Three's renderer calls `LOD.update(camera)` itself
 * while it walks the scene, so the level in view is chosen during the render it affects. A frame
 * callback doing the same job would be a second answer to "which level is showing", one frame
 * behind the first, and the two would disagree exactly when the camera moves fastest.
 *
 * ## Why the geometries are cached per source
 *
 * A hundred crates share one geometry, so they share one decimation. Without the cache the same
 * mesh would be clustered a hundred times at load — the load-time cost of this feature is entirely
 * in that arithmetic, and paying it per placement rather than per asset would turn a few
 * milliseconds into a visible stall.
 *
 * The cache owns what it makes and is freed with the scene, for the same reason the surface textures
 * are: the editor rebuilds a scene constantly, and buffers that outlive every object that referenced
 * them are a leak whose only symptom is a tab getting slower over an afternoon.
 */
export class LodGeometries {
  readonly #cache = new Map<string, THREE.BufferGeometry | null>();
  readonly #made: THREE.BufferGeometry[] = [];
  #trianglesSaved = 0;

  /**
   * The coarse copy of a geometry at one ratio, or null when there is not one worth having.
   *
   * Null is cached too. A geometry that cannot usefully be decimated — a twelve-triangle box —
   * should be asked about once, not once per placement.
   */
  get(geometry: THREE.BufferGeometry, ratio: number): THREE.BufferGeometry | null {
    const key = `${geometry.uuid}@${ratio}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    const simplified = simplifyGeometry(geometry, ratio);
    this.#cache.set(key, simplified);
    if (simplified) {
      this.#made.push(simplified);
      this.#trianglesSaved += triangleCount(geometry) - triangleCount(simplified);
    }
    return simplified;
  }

  /** Triangles the coarse copies remove from the finest ones, summed over each distinct mesh. */
  get trianglesSaved(): number {
    return this.#trianglesSaved;
  }

  dispose(): void {
    for (const geometry of this.#made) geometry.dispose();
    this.#made.length = 0;
    this.#cache.clear();
    this.#trianglesSaved = 0;
  }
}

/**
 * Wraps a visual in a `THREE.LOD`, or returns it unchanged.
 *
 * Unchanged is the common case and is not a degraded one: with the mode off, or on a model that
 * cannot usefully be decimated, the object is exactly the node it was — no wrapper, no extra
 * buffers, no per-frame distance test.
 *
 * The coarse levels are *clones of the whole visual*, with the simplified geometry swapped in. A
 * flat mesh would have been simpler and would lose every model whose parts sit at an offset from its
 * root: a tree is a trunk and a canopy, and a canopy drawn at the trunk's origin is a shrub.
 */
export function buildLod(
  visual: THREE.Object3D,
  mode: LodMode,
  cache: LodGeometries,
): THREE.Object3D {
  const ratios = LOD_PROFILES[mode].ratios;
  if (ratios.length === 0) return visual;

  const radius = radiusOf(visual);
  if (radius <= 0) return visual;
  const distances = lodDistances(mode, radius);

  const levels: THREE.Object3D[] = [];
  for (const [step, ratio] of ratios.entries()) {
    const level = coarseCopy(visual, ratio, cache);
    if (!level) break;
    level.name = `lod${step + 1}`;
    levels.push(level);
  }
  if (levels.length === 0) return visual;

  const lod = new THREE.LOD();
  lod.name = visual.name;
  // The transform belongs to the wrapper: the levels are clones that already carry the visual's own
  // local transform, and leaving it on both would apply the asset's default scale twice.
  lod.position.copy(visual.position);
  lod.quaternion.copy(visual.quaternion);
  lod.scale.copy(visual.scale);
  visual.position.set(0, 0, 0);
  visual.quaternion.identity();
  visual.scale.set(1, 1, 1);

  lod.addLevel(visual, 0);
  for (const [step, level] of levels.entries()) lod.addLevel(level, distances[step] ?? 0);
  return lod;
}

/**
 * A copy of the visual with every decimatable mesh replaced by its coarse version.
 *
 * Null when nothing in it could be decimated — a level identical to the one below it is a second
 * copy of the mesh on the GPU and a distance test that can never change the picture.
 */
function coarseCopy(
  visual: THREE.Object3D,
  ratio: number,
  cache: LodGeometries,
): THREE.Object3D | null {
  let replaced = 0;
  const copy = visual.clone(true);

  copy.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const simplified = cache.get(mesh.geometry, ratio);
    if (!simplified) return;
    mesh.geometry = simplified;
    replaced += 1;
  });

  if (replaced === 0) return null;
  return copy;
}

/** The visual's radius in its parent's space, which is what a switching distance is measured in. */
function radiusOf(visual: THREE.Object3D): number {
  const box = new THREE.Box3().setFromObject(visual);
  if (box.isEmpty()) return 0;
  return box.getBoundingSphere(new THREE.Sphere()).radius;
}

/**
 * Which level of an object is currently drawn: 0 is the finest, and -1 for an object without levels.
 *
 * Exists for the editor's statistics and for the tests, and the tests are the reason it is not
 * derived from the distance instead. Recomputing "which level should be showing" would be asserting
 * the arithmetic against itself; reading `visible` asks the scene graph what Three actually chose.
 */
export function activeLodLevel(node: THREE.Object3D): number {
  const lod = node.getObjectByProperty('isLOD', true) as THREE.LOD | undefined;
  if (!lod) return -1;
  for (const [index, level] of lod.levels.entries()) {
    if (level.object.visible) return index;
  }
  return -1;
}
