import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { TerrainField } from '../TerrainField.js';
import { terrainHides, terrainRelief } from './horizon.js';

/**
 * Occlusion against the terrain, as arithmetic.
 *
 * Every case here is paired with its opposite, because the failure that matters is not "nothing was
 * culled" — it is "something visible was culled", and a test that only ever checks the hiding half
 * would pass on an implementation that hides everything.
 */

/**
 * A field with a ridge across the middle of it, running along X.
 *
 * The ridge is at z = 0, so a viewer at negative z looking at positive z has a hill in the way. It
 * falls off linearly rather than stepping, because a vertical step is exactly the case the bilinear
 * sampler smooths into something the test did not intend.
 */
function ridge(maxHeight = 20): TerrainField {
  const segments = 64;
  const width = segments + 1;
  const heights = new Float32Array(width * width);
  for (let row = 0; row < width; row += 1) {
    for (let column = 0; column < width; column += 1) {
      // Normalised distance from the middle row, so the ridge peaks at z = 0 and falls to nothing
      // within about a fifth of the field either side.
      const fromMiddle = Math.abs(row / segments - 0.5);
      heights[row * width + column] = Math.max(0, 1 - fromMiddle * 8);
    }
  }
  // `heights` is read-only on the field and normalised 0..1, so the ridge is written in after
  // construction rather than handed to it.
  const field = new TerrainField({ segments, size: [200, 200], maxHeight });
  field.heights.set(heights);
  return field;
}

/** A field with no relief at all. The control for every case below. */
function flat(): TerrainField {
  // A new field is already all zeroes, so this is the same field as `ridge` with nothing written
  // into it — which is what makes it the control rather than a different terrain.
  return new TerrainField({ segments: 64, size: [200, 200], maxHeight: 20 });
}

/**
 * A field that is flat to the eye but not to the arithmetic.
 *
 * Ten centimetres of wobble, which is what a sculpted "flat" area actually looks like once the
 * heightfield has been interpolated. The perfectly-zero field above cannot test the clearance
 * margin at all — every sample comes back exactly zero, so no margin is needed to clear it, and a
 * test written against it passes whether the margin exists or not.
 */
function almostFlat(): TerrainField {
  const field = new TerrainField({ segments: 64, size: [200, 200], maxHeight: 20 });
  for (let index = 0; index < field.heights.length; index += 1) {
    field.heights[index] = index % 2 === 0 ? 0.005 : 0;
  }
  return field;
}

const at = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

describe('terrainHides', () => {
  it('hides what is behind a hill', () => {
    // Eye low on one side, target low on the other, ridge in between.
    expect(terrainHides(ridge(), at(0, 2, -60), at(0, 2, 60))).toBe(true);
  });

  it('does not hide the same thing over flat ground', () => {
    /**
     * The control, and it carries the test. Identical camera, identical target, identical distance
     * — the only difference is whether there is a hill. Without it, "the chunk was hidden" would be
     * satisfied by an implementation that returns true unconditionally.
     */
    expect(terrainHides(flat(), at(0, 2, -60), at(0, 2, 60))).toBe(false);
  });

  it('does not hide something tall enough to see over the hill', () => {
    // The reason the test aims at the top of the tallest thing in a chunk rather than at the
    // ground: a hill that hides a hut's floor does not hide a tower's roof.
    expect(terrainHides(ridge(), at(0, 2, -60), at(0, 60, 60))).toBe(false);
  });

  it('does not hide something in front of the hill', () => {
    // Nothing between eye and target, so nothing can block it. A test that sampled the whole field
    // rather than the segment would find the ridge and hide this.
    expect(terrainHides(ridge(), at(0, 2, -60), at(0, 2, -20))).toBe(false);
  });

  it('does not hide a chunk the camera is standing in', () => {
    // Under a metre apart horizontally: there is no segment to sample, and the ground beneath a
    // standing viewer is close enough to eye height on the line to occlude everything.
    expect(terrainHides(ridge(), at(0, 2, 0), at(0.2, 2, 0.2))).toBe(false);
  });

  it('does not hide a chunk standing on the hill it is on', () => {
    /**
     * Self-occlusion, which is why the samples skip the ends of the segment. The slope a chunk
     * stands on is by definition at the line's height where the chunk is, so sampling right up to
     * the target hides every chunk on a hillside from itself — and a hillside is where a level's
     * scenery mostly is.
     */
    const field = ridge();
    const onTheRidge = field.sampleHeight(0, 0);
    expect(terrainHides(field, at(0, onTheRidge + 3, -12), at(0, onTheRidge + 3, 0))).toBe(false);
  });

  it('is not fooled by ground merely level with the line of sight', () => {
    // Ten centimetres of wobble in nominally flat ground, with eye and target five centimetres up.
    // Without the clearance margin that wobble is an occluder, and a level built on a plain has
    // nothing in it.
    expect(terrainHides(almostFlat(), at(0, 0.05, -60), at(0, 0.05, 60))).toBe(false);
  });
});

describe('terrainRelief', () => {
  it('reports nothing for a flat field and metres for a sculpted one', () => {
    expect(terrainRelief(flat())).toBe(0);
    expect(terrainRelief(ridge(20))).toBeGreaterThan(15);
    // Proportional to the field's own maximum, so the panel's advice scales with the level rather
    // than with a number baked in here.
    expect(terrainRelief(ridge(4))).toBeLessThan(terrainRelief(ridge(20)));
  });
});
