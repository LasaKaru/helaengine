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
      {
        position: new THREE.Vector3(0, 0, 0),
        quaternion: new THREE.Quaternion(),
        scale: 1,
        tint: null,
      },
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

/**
 * How evenly the field covers the ground.
 *
 * Counts instances per bucket over a coarse grid and returns the spread relative to the mean. A
 * jittered grid is nearly uniform, so its spread is small; a clumped field has thick and thin parts
 * by construction, so its spread is large. That ratio is what "patchy" means as a number.
 */
function unevenness(instances: readonly { position: THREE.Vector3 }[], buckets = 8): number {
  const counts = new Array<number>(buckets * buckets).fill(0);
  for (const instance of instances) {
    const bx = Math.min(
      buckets - 1,
      Math.max(0, Math.floor(((instance.position.x + SIZE[0] / 2) / SIZE[0]) * buckets)),
    );
    const bz = Math.min(
      buckets - 1,
      Math.max(0, Math.floor(((instance.position.z + SIZE[1] / 2) / SIZE[1]) * buckets)),
    );
    counts[bz * buckets + bx] = (counts[bz * buckets + bx] ?? 0) + 1;
  }

  const mean = instances.length / counts.length;
  if (mean === 0) return 0;
  const variance = counts.reduce((total, count) => total + (count - mean) ** 2, 0) / counts.length;
  return Math.sqrt(variance) / mean;
}

describe('clumping', () => {
  it('leaves a layer that does not use it exactly as it was', () => {
    /**
     * The assertion that had to hold before any of this could ship. Clumping and colour both need
     * a per-candidate value, and taking it from the random sequence would have shifted every
     * meadow in every existing project on the first load — silently, with nothing in the document
     * changed. Both take theirs from a hash of the cell instead, which consumes nothing.
     *
     * Written as an exact position match rather than a count, because a count can survive a
     * complete rearrangement.
     */
    const before = buildScatter(layerOf({ density: 40, seed: 3 }), context(hillTerrain()));
    const after = buildScatter(
      layerOf({ density: 40, seed: 3, clumping: 0, colorJitter: 0 }),
      context(hillTerrain()),
    );

    expect(after).toHaveLength(before.length);
    for (const [index, instance] of after.entries()) {
      expect(instance.position.x).toBe(before[index]!.position.x);
      expect(instance.position.z).toBe(before[index]!.position.z);
      expect(instance.tint).toBeNull();
    }
  });

  it('gathers the field into patches', () => {
    const even = buildScatter(layerOf({ density: 60, seed: 5 }), context(flatTerrain()));
    const patchy = buildScatter(
      layerOf({ density: 60, seed: 5, clumping: 1, clumpSize: 8 }),
      context(flatTerrain()),
    );

    // The control is the first line: a jittered grid is nearly uniform by design, so if the two
    // spreads were similar the clumping would be doing nothing but thinning at random.
    expect(unevenness(even)).toBeLessThan(0.15);
    expect(unevenness(patchy)).toBeGreaterThan(unevenness(even) * 2);
  });

  it('keeps roughly as much grass as it started with', () => {
    /**
     * What an author expects from the slider: the same meadow, gathered differently. Clumping
     * rejects candidates, so without the planning compensation a field would lose half its plants
     * on the way to looking patchy, and the author would put the density back up and undo the
     * effect.
     */
    const even = buildScatter(layerOf({ density: 60, seed: 5 }), context(flatTerrain()));
    const patchy = buildScatter(
      layerOf({ density: 60, seed: 5, clumping: 1, clumpSize: 8 }),
      context(flatTerrain()),
    );

    expect(patchy.length).toBeGreaterThan(even.length * 0.75);
    expect(patchy.length).toBeLessThan(even.length * 1.25);
  });

  it('makes patches the size it was asked for', () => {
    // Small patches spread the unevenness across more buckets than large ones do, so at a fixed
    // bucket size a coarser clump reads as more uneven. Without this the clump size could be
    // ignored entirely and the test above would still pass.
    const fine = buildScatter(
      layerOf({ density: 60, seed: 5, clumping: 1, clumpSize: 2 }),
      context(flatTerrain()),
    );
    const coarse = buildScatter(
      layerOf({ density: 60, seed: 5, clumping: 1, clumpSize: 24 }),
      context(flatTerrain()),
    );

    expect(unevenness(coarse)).toBeGreaterThan(unevenness(fine));
  });
});

describe('colour variation', () => {
  it('gives neighbours different shades', () => {
    const instances = buildScatter(
      layerOf({ density: 40, seed: 9, colorJitter: 1 }),
      context(flatTerrain()),
    );

    const tints = instances.map((instance) => instance.tint!);
    expect(tints.every((tint) => tint !== null)).toBe(true);
    expect(Math.max(...tints) - Math.min(...tints)).toBeGreaterThan(0.3);
    // Centred on the model's own colour, so a field with jitter is not a field that got darker.
    const mean = tints.reduce((total, tint) => total + tint, 0) / tints.length;
    expect(mean).toBeCloseTo(1, 1);
  });

  it('writes no colour at all when it is off — the control', () => {
    // Not "writes 1": an instance colour buffer is an attribute uploaded and a multiply per
    // fragment, and a layer that does not use variation must not pay for it.
    const instances = buildScatter(layerOf({ density: 40, seed: 9 }), context(flatTerrain()));
    expect(instances.every((instance) => instance.tint === null)).toBe(true);

    const meshes = buildScatterMeshes(new THREE.Mesh(new THREE.BoxGeometry()), instances);
    expect(meshes[0]?.instanceColor).toBeFalsy();
  });

  it('does not follow the patches', () => {
    /**
     * The trap this arrangement exists to avoid. Clumping and colour ask a question about the same
     * cell, and if they shared a hash every plant in a thick patch would be the same shade — the
     * field would gain variation and immediately lose it again to a second, coarser pattern.
     *
     * Measured as: the shades inside the field are no more organised than the clumping is. If the
     * two shared a salt, the tint's own unevenness would track the patch layout exactly.
     */
    const instances = buildScatter(
      layerOf({ density: 60, seed: 5, clumping: 1, clumpSize: 8, colorJitter: 1 }),
      context(flatTerrain()),
    );

    // Neighbouring instances differ as much as distant ones do: a tint that followed the patches
    // would make the first number far smaller than the second.
    let adjacent = 0;
    let distant = 0;
    for (let index = 1; index < instances.length; index += 1) {
      adjacent += Math.abs(instances[index]!.tint! - instances[index - 1]!.tint!);
      distant += Math.abs(
        instances[index]!.tint! - instances[(index * 37) % instances.length]!.tint!,
      );
    }
    expect(adjacent / instances.length).toBeGreaterThan((distant / instances.length) * 0.7);
  });
});
