import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ScatterLayerSchema, plannedCount, isCapped, type ScatterLayer } from '@helaengine/schema';
import { TerrainField } from '../TerrainField.js';
import { buildScatter, buildScatterMeshes } from './ScatterField.js';

/**
 * The scatter rule, against a real height field.
 *
 * The claims worth pinning are the ones an author would notice and could not diagnose: that the
 * same document gives the same field everywhere, that raising a limit does not rearrange the plants
 * already placed, and that the filters actually filter.
 */

const SIZE: [number, number] = [64, 64];

function flatTerrain(): TerrainField {
  return new TerrainField({ segments: 32, size: SIZE, maxHeight: 20 });
}

/** A field that rises steadily along x, so its slope is the same everywhere. */
function rampTerrain(rise = 20): TerrainField {
  const field = new TerrainField({ segments: 32, size: SIZE, maxHeight: 40 });
  for (let gz = 0; gz < field.width; gz += 1) {
    for (let gx = 0; gx < field.width; gx += 1) {
      field.heights[gz * field.width + gx] = (gx / (field.width - 1)) * (rise / 40);
    }
  }
  return field;
}

/**
 * A smooth hill, so the slope varies across the field.
 *
 * A uniform ramp cannot test a slope filter properly: every point has the same slope, so a limit
 * either accepts all of it or none. The first version of the loosening test used one and passed
 * vacuously — both counts were the full field.
 */
function hillTerrain(): TerrainField {
  const field = new TerrainField({ segments: 32, size: SIZE, maxHeight: 40 });
  const centre = (field.width - 1) / 2;
  for (let gz = 0; gz < field.width; gz += 1) {
    for (let gx = 0; gx < field.width; gx += 1) {
      const distance = Math.hypot(gx - centre, gz - centre) / centre;
      field.heights[gz * field.width + gx] = Math.max(0, Math.cos(distance * Math.PI) * 0.5 + 0.5);
    }
  }
  return field;
}

const layerOf = (parts: Partial<ScatterLayer> = {}): ScatterLayer =>
  ScatterLayerSchema.parse({ id: 'grass', assetId: 'grass_large', ...parts });

const context = (terrain: TerrainField) => ({ terrain, size: SIZE });

describe('determinism', () => {
  it('gives the same field for the same seed', () => {
    // The whole reason a seed is stored rather than a list of positions. Different answers here
    // would mean the editor and the export disagree about where the grass is.
    const layer = layerOf({ density: 40, seed: 7 });
    const a = buildScatter(layer, context(flatTerrain()));
    const b = buildScatter(layer, context(flatTerrain()));

    expect(a).toHaveLength(b.length);
    expect(a.length).toBeGreaterThan(0);
    for (const [index, instance] of a.entries()) {
      expect(instance.position.x).toBeCloseTo(b[index]!.position.x, 10);
      expect(instance.position.z).toBeCloseTo(b[index]!.position.z, 10);
      expect(instance.scale).toBeCloseTo(b[index]!.scale, 10);
    }
  });

  it('gives a different field for a different seed', () => {
    const a = buildScatter(layerOf({ density: 40, seed: 1 }), context(flatTerrain()));
    const b = buildScatter(layerOf({ density: 40, seed: 2 }), context(flatTerrain()));
    expect(a[0]!.position.x).not.toBeCloseTo(b[0]!.position.x, 4);
  });

  it('does not rearrange the field when a filter is loosened', () => {
    /**
     * Every candidate draws the same numbers whether it is accepted or not.
     *
     * Drawing conditionally would make raising `slopeMax` slightly do far more than add plants on
     * the steeper ground: it would shift every plant after the first newly-accepted one, so nudging
     * one setting rebuilds a field the author had already got right.
     */
    const terrain = hillTerrain();
    const tight = buildScatter(layerOf({ density: 40, seed: 3, slopeMax: 15 }), context(terrain));
    const loose = buildScatter(layerOf({ density: 40, seed: 3, slopeMax: 85 }), context(terrain));

    // Both non-trivial, or the comparison below proves nothing.
    expect(tight.length).toBeGreaterThan(0);
    expect(loose.length).toBeGreaterThan(tight.length);
    // Everything the tight setting accepted is still exactly where it was.
    const looseByKey = new Map(
      loose.map((instance) => [
        `${instance.position.x.toFixed(6)}:${instance.position.z.toFixed(6)}`,
        instance,
      ]),
    );
    for (const instance of tight) {
      const key = `${instance.position.x.toFixed(6)}:${instance.position.z.toFixed(6)}`;
      expect(looseByKey.get(key)?.scale).toBeCloseTo(instance.scale, 10);
    }
  });
});

describe('spacing', () => {
  it('spreads across the whole terrain rather than clumping in a corner', () => {
    const instances = buildScatter(layerOf({ density: 30, seed: 5 }), context(flatTerrain()));
    const xs = instances.map((instance) => instance.position.x);
    const zs = instances.map((instance) => instance.position.z);

    // A jittered grid reaches the edges. Uniform random points would too, eventually — what it
    // would not do is reach them *evenly*, which is the next test.
    expect(Math.min(...xs)).toBeLessThan(-SIZE[0] / 2 + 4);
    expect(Math.max(...xs)).toBeGreaterThan(SIZE[0] / 2 - 4);
    expect(Math.min(...zs)).toBeLessThan(-SIZE[1] / 2 + 4);
    expect(Math.max(...zs)).toBeGreaterThan(SIZE[1] / 2 - 4);
  });

  it('leaves no quadrant bald', () => {
    /**
     * The reason for a jittered grid rather than uniform random points.
     *
     * Random points clump — that is what random means — so a meadow generated that way has visible
     * clots and visible bald patches. With a grid the count per quadrant is near-identical, and an
     * author never has to raise the density to paper over a gap.
     */
    const instances = buildScatter(layerOf({ density: 40, seed: 11 }), context(flatTerrain()));
    const quadrants = [0, 0, 0, 0];
    for (const instance of instances) {
      const index = (instance.position.x > 0 ? 1 : 0) + (instance.position.z > 0 ? 2 : 0);
      quadrants[index] = quadrants[index]! + 1;
    }
    const smallest = Math.min(...quadrants);
    const largest = Math.max(...quadrants);
    expect(smallest).toBeGreaterThan(0);
    expect(largest / smallest).toBeLessThan(1.3);
  });
});

describe('filters', () => {
  it('refuses ground steeper than the limit', () => {
    const terrain = rampTerrain(40);
    const steep = buildScatter(layerOf({ density: 40, seed: 2, slopeMax: 5 }), context(terrain));
    const any = buildScatter(layerOf({ density: 40, seed: 2, slopeMax: 90 }), context(terrain));

    expect(steep.length).toBeLessThan(any.length);
    // Grass on a cliff face intersects it, because the models are built to stand on flat ground.
    expect(steep.length).toBe(0);
  });

  it('keeps to its height band', () => {
    const terrain = rampTerrain(20);
    const low = buildScatter(
      layerOf({ density: 40, seed: 4, heightMin: -1000, heightMax: 5, slopeMax: 90 }),
      context(terrain),
    );
    expect(low.length).toBeGreaterThan(0);
    for (const instance of low) expect(instance.position.y).toBeLessThanOrEqual(5);
  });

  it('follows the painted terrain layer', () => {
    // This is what makes scatter answer to the brush: paint sand and the grass retreats, with no
    // second mask to keep in step.
    const terrain = flatTerrain();
    terrain.paint(0, 0, 2, { radius: 20, strength: 1 });

    const onLayerTwo = buildScatter(
      layerOf({ density: 40, seed: 6, terrainLayer: 2, layerThreshold: 0.5 }),
      context(terrain),
    );
    const onLayerThree = buildScatter(
      layerOf({ density: 40, seed: 6, terrainLayer: 3, layerThreshold: 0.5 }),
      context(terrain),
    );

    expect(onLayerTwo.length).toBeGreaterThan(0);
    expect(onLayerThree).toHaveLength(0);
    // Only inside the painted circle.
    for (const instance of onLayerTwo) {
      expect(Math.hypot(instance.position.x, instance.position.z)).toBeLessThan(22);
    }
  });

  it('grows nothing when disabled or at zero density', () => {
    expect(buildScatter(layerOf({ enabled: false, density: 40 }), context(flatTerrain()))).toEqual(
      [],
    );
    expect(buildScatter(layerOf({ density: 0 }), context(flatTerrain()))).toEqual([]);
  });
});

describe('the instance cap', () => {
  it('thins the field rather than letting the count run away', () => {
    // Density is per unit area, so a setting that looked fine on a small map becomes millions of
    // instances on a large one. The cap turns a tab that never finishes loading into a thin field.
    const huge = plannedCount(layerOf({ density: 400 }), 100_000_000);
    expect(huge).toBe(40_000);
    expect(isCapped(layerOf({ density: 400 }), 100_000_000)).toBe(true);
    expect(isCapped(layerOf({ density: 1 }), 1000)).toBe(false);
  });

  it('honours the cap when actually building', () => {
    const instances = buildScatter(layerOf({ density: 400, seed: 1 }), context(flatTerrain()));
    expect(instances.length).toBeLessThanOrEqual(40_000);
  });
});

describe('buildScatterMeshes', () => {
  function twoPartPlant(): THREE.Object3D {
    const group = new THREE.Group();
    const stem = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 1, 0.1),
      new THREE.MeshStandardMaterial(),
    );
    const leaves = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.4, 0.6),
      new THREE.MeshStandardMaterial(),
    );
    leaves.position.y = 1;
    group.add(stem, leaves);
    return group;
  }

  it('makes one batch per mesh, keeping the model assembled', () => {
    // Per mesh, not per model: a plant whose leaves and stem have separate materials needs a batch
    // each, and flattening them into one geometry would throw the materials away.
    const instances = buildScatter(layerOf({ density: 10, seed: 1 }), context(flatTerrain()));
    const meshes = buildScatterMeshes(twoPartPlant(), instances);

    expect(meshes).toHaveLength(2);
    for (const mesh of meshes) expect(mesh.count).toBe(instances.length);
  });

  it('keeps each part at its offset inside the model', () => {
    const instances = [
      { position: new THREE.Vector3(0, 0, 0), quaternion: new THREE.Quaternion(), scale: 1 },
    ];
    const meshes = buildScatterMeshes(twoPartPlant(), instances);

    const matrix = new THREE.Matrix4();
    const position = new THREE.Vector3();
    const heights = meshes.map((mesh) => {
      mesh.getMatrixAt(0, matrix);
      return position.setFromMatrixPosition(matrix).y;
    });

    // The leaves sit a metre above the stem in the template, and must still after batching —
    // otherwise every plant in the field arrives disassembled at the origin.
    expect(Math.max(...heights)).toBeCloseTo(1, 5);
    expect(Math.min(...heights)).toBeCloseTo(0, 5);
  });

  it('computes bounds from the instances, not the template', () => {
    const instances = buildScatter(layerOf({ density: 20, seed: 1 }), context(flatTerrain()));
    const [mesh] = buildScatterMeshes(twoPartPlant(), instances);

    // Left at the template's bounds, the whole field is culled the moment the origin leaves the
    // frustum — grass that vanishes when you look away from the middle of the map.
    expect(mesh!.boundingSphere!.radius).toBeGreaterThan(SIZE[0] / 4);
  });

  it('makes nothing from no instances', () => {
    expect(buildScatterMeshes(twoPartPlant(), [])).toEqual([]);
  });
});
