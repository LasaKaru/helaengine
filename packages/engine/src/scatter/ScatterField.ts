import * as THREE from 'three';
import {
  DENSITY_UNIT_AREA,
  MAX_SCATTER_INSTANCES,
  makeRandom,
  type ScatterLayer,
} from '@helaengine/schema';
import type { TerrainField } from '../TerrainField.js';

/**
 * Expands a scatter layer into instance transforms.
 *
 * ## Why a jittered grid rather than uniform random points
 *
 * Scattering N points uniformly at random over a field does not look like a field. Random points
 * clump — that is what random means — so a meadow generated that way has visible clots of grass and
 * visible bald patches, and an author's only recourse is to raise the density until the bald spots
 * fill in, by which point the clots are solid.
 *
 * A jittered grid divides the area into cells and puts one point somewhere inside each. The spacing
 * is bounded below, so nothing clumps; the jitter is a full cell wide, so nothing lines up. It is
 * one multiply more expensive than uniform random and it is the difference between a meadow and a
 * rash.
 *
 * ## Why the whole thing is deterministic
 *
 * Same document, same field — in the editor, in an export, on a teammate's machine. The random
 * source is seeded per layer and consumed in a fixed order, which is the part that is easy to break:
 * pulling a number conditionally, or skipping one for a rejected candidate, makes the field shift
 * whenever a filter's answer changes. Every candidate here draws exactly the same numbers whether it
 * is accepted or not.
 */

export interface ScatterInstance {
  position: THREE.Vector3;
  /** Y rotation in radians, plus any tilt if the layer asks for it. */
  quaternion: THREE.Quaternion;
  scale: number;
}

export interface ScatterContext {
  terrain: TerrainField;
  /** Terrain extent in world units. */
  size: [number, number];
}

/** How many blend weights a terrain vertex carries. Mirrors `TerrainField`. */
const LAYER_COUNT = 4;

const UP = new THREE.Vector3(0, 1, 0);

/**
 * The ground normal at a point, from the height field.
 *
 * Sampled rather than read from the geometry: the geometry is built once for rendering and its
 * normals are per-vertex, while a scattered instance lands anywhere. Central differences over a
 * metre are stable against the noise a sculpt brush leaves behind — a one-sided difference picks up
 * every ridge and reports cliffs that are not there.
 */
function groundNormal(terrain: TerrainField, x: number, z: number): THREE.Vector3 {
  const step = 0.5;
  const dx = terrain.sampleHeight(x + step, z) - terrain.sampleHeight(x - step, z);
  const dz = terrain.sampleHeight(x, z + step) - terrain.sampleHeight(x, z - step);
  return new THREE.Vector3(-dx, 2 * step, -dz).normalize();
}

/**
 * The blend weight of one painted layer at a point, 0–1.
 *
 * Nearest-vertex rather than interpolated. The splat map is one byte per layer per vertex and the
 * question here is "is this mostly grass", which does not get a better answer from bilinear
 * filtering — it gets a slower one, per candidate, of which there are tens of thousands.
 */
function layerWeight(terrain: TerrainField, x: number, z: number, layer: number): number {
  const { gx, gz } = terrain.worldToGrid(x, z);
  const cx = Math.max(0, Math.min(terrain.width - 1, Math.round(gx)));
  const cz = Math.max(0, Math.min(terrain.width - 1, Math.round(gz)));
  const index = (cz * terrain.width + cx) * LAYER_COUNT + layer;
  return (terrain.weights[index] ?? 0) / 255;
}

/**
 * Generates one layer's instances.
 *
 * Returns fewer than planned whenever the filters reject candidates, which is the normal case and
 * the point: density asks for a covering, and slope, height and paint decide where it actually
 * lands.
 */
export function buildScatter(layer: ScatterLayer, context: ScatterContext): ScatterInstance[] {
  if (!layer.enabled || layer.density <= 0) return [];

  const [width, depth] = context.size;
  const area = width * depth;
  const wanted = Math.min(
    MAX_SCATTER_INSTANCES,
    Math.floor((layer.density * area) / DENSITY_UNIT_AREA),
  );
  if (wanted <= 0) return [];

  /**
   * A grid whose cell count is at least `wanted`, kept square in world units.
   *
   * Square cells matter: a grid of 10×1000 over a square field would produce rows a hundred metres
   * apart, which reads as planting rather than as growth.
   *
   * Every cell then gets a candidate and the count is whatever survives the filters. An earlier
   * version stopped the moment it had `wanted` instances, which sounds harmless and is not: the
   * grid is walked in row order, so stopping early drops the *last rows* — a bald strip along one
   * edge of the map, wider the more the filters rejected. The cap belongs on the grid size, where
   * it thins the whole field evenly, not on the loop.
   */
  const cells = Math.ceil(Math.sqrt(wanted));
  const cellWidth = width / cells;
  const cellDepth = depth / cells;

  const random = makeRandom(layer.seed);
  const instances: ScatterInstance[] = [];

  const slopeLimit = Math.cos((layer.slopeMax * Math.PI) / 180);
  const scaleSpan = Math.max(0, layer.scaleMax - layer.scaleMin);
  const tilt = (layer.tiltJitter * Math.PI) / 180;

  const tiltAxis = new THREE.Vector3();
  const alignment = new THREE.Quaternion();
  const spin = new THREE.Quaternion();

  for (let cz = 0; cz < cells; cz += 1) {
    for (let cx = 0; cx < cells; cx += 1) {
      /**
       * Every candidate draws the same five numbers, accepted or not.
       *
       * Drawing conditionally would make the whole field shift whenever one candidate's filter
       * answer changed — raising `slopeMax` slightly would not just add plants on the steeper
       * ground, it would rearrange every plant after the first newly-accepted one.
       */
      const jitterX = random();
      const jitterZ = random();
      const spinAngle = random() * Math.PI * 2;
      const scaleRoll = random();
      const tiltRoll = random();

      const x = -width / 2 + (cx + jitterX) * cellWidth;
      const z = -depth / 2 + (cz + jitterZ) * cellDepth;

      const y = context.terrain.sampleHeight(x, z);
      if (y < layer.heightMin || y > layer.heightMax) continue;

      const normal = groundNormal(context.terrain, x, z);
      if (normal.y < slopeLimit) continue;

      if (layer.terrainLayer !== null) {
        const weight = layerWeight(context.terrain, x, z, layer.terrainLayer);
        if (weight < layer.layerThreshold) continue;
      }

      spin.setFromAxisAngle(UP, spinAngle);

      if (layer.alignToSlope) {
        alignment.setFromUnitVectors(UP, normal);
        spin.premultiply(alignment);
      } else if (tilt > 0) {
        // A small lean in a random direction. Grass grows upward whatever it stands on, so a full
        // alignment combs the hillside — this just stops the field looking ironed.
        tiltAxis.set(Math.cos(tiltRoll * Math.PI * 2), 0, Math.sin(tiltRoll * Math.PI * 2));
        alignment.setFromAxisAngle(tiltAxis, (tiltRoll - 0.5) * 2 * tilt);
        spin.premultiply(alignment);
      }

      instances.push({
        position: new THREE.Vector3(x, y, z),
        quaternion: spin.clone(),
        scale: layer.scaleMin + scaleRoll * scaleSpan,
      });
    }
  }

  return instances;
}

/**
 * Builds one `InstancedMesh` per mesh in the template.
 *
 * Per *mesh*, not per model: a plant whose leaves and stem are separate meshes with separate
 * materials needs one batch each, and flattening them into a single geometry would throw away the
 * materials. The same shape `InstanceManager` uses for placed objects, so wind and culling see one
 * kind of thing.
 */
export function buildScatterMeshes(
  template: THREE.Object3D,
  instances: readonly ScatterInstance[],
): THREE.InstancedMesh[] {
  if (instances.length === 0) return [];

  template.updateWorldMatrix(false, true);
  const inverse = new THREE.Matrix4().copy(template.matrixWorld).invert();
  const meshes: THREE.InstancedMesh[] = [];
  const local = new THREE.Matrix4();
  const composed = new THREE.Matrix4();
  const scale = new THREE.Vector3();

  template.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;

    // The part's own offset inside the model, so a stem and its leaves stay assembled.
    local.copy(inverse).multiply(mesh.matrixWorld);

    const batch = new THREE.InstancedMesh(mesh.geometry, mesh.material, instances.length);
    batch.name = `scatter:${mesh.name || 'part'}`;
    // Scattered vegetation casts no shadows: tens of thousands of shadow-casting blades is a second
    // full render of the field, and the shadow a blade of grass casts is not visible anyway.
    batch.castShadow = false;
    batch.receiveShadow = true;

    for (const [index, instance] of instances.entries()) {
      scale.setScalar(instance.scale);
      composed.compose(instance.position, instance.quaternion, scale);
      composed.multiply(local);
      batch.setMatrixAt(index, composed);
    }
    batch.instanceMatrix.needsUpdate = true;
    // Computed once from the instances rather than left at the template's bounds, or the whole
    // field is culled the moment the template's origin leaves the frustum.
    batch.computeBoundingSphere();

    meshes.push(batch);
  });

  return meshes;
}
