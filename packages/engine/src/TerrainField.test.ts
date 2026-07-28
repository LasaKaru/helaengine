import type * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './base64.js';
import { LAYER_COUNT, TerrainField } from './TerrainField.js';

function field(segments = 16, size: [number, number] = [64, 64], maxHeight = 20): TerrainField {
  return new TerrainField({ segments, size, maxHeight });
}

const BRUSH = { radius: 8, strength: 0.5 };

describe('base64 codec', () => {
  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
  });

  it('handles every remainder length', () => {
    for (let length = 0; length <= 8; length += 1) {
      const bytes = new Uint8Array(length).map((_, index) => index * 31);
      expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    }
  });

  it('produces standard base64', () => {
    // "Hela" in ASCII, so the output can be checked against any other implementation.
    expect(bytesToBase64(new Uint8Array([72, 101, 108, 97]))).toBe('SGVsYQ==');
  });
});

describe('TerrainField', () => {
  it('starts flat and fully covered by the first layer', () => {
    const terrain = field();
    expect(terrain.isFlat()).toBe(true);
    expect(terrain.sampleHeight(0, 0)).toBe(0);
    expect(terrain.weights[0]).toBe(255);
    expect(terrain.weights[1]).toBe(0);
  });

  it('sizes its grid from the segment count', () => {
    expect(field(16).width).toBe(17);
    expect(field(16).heights).toHaveLength(17 * 17);
  });

  it('maps the world centre to the grid centre', () => {
    const terrain = field(16, [64, 64]);
    expect(terrain.worldToGrid(0, 0)).toEqual({ gx: 8, gz: 8 });
    expect(terrain.gridToWorld(0, 0)).toEqual({ x: -32, z: -32 });
  });

  it('raises the terrain under the brush and leaves the rest alone', () => {
    const terrain = field();
    terrain.sculpt(0, 0, 'raise', BRUSH);

    expect(terrain.sampleHeight(0, 0)).toBeGreaterThan(0);
    // A corner well outside an 8m brush on a 64m terrain must be untouched.
    expect(terrain.sampleHeight(-32, -32)).toBe(0);
    expect(terrain.isFlat()).toBe(false);
  });

  it('falls off towards the brush edge', () => {
    const terrain = field();
    terrain.sculpt(0, 0, 'raise', BRUSH);

    expect(terrain.sampleHeight(0, 0)).toBeGreaterThan(terrain.sampleHeight(6, 0));
    expect(terrain.sampleHeight(6, 0)).toBeGreaterThan(0);
  });

  it('lowers what it previously raised', () => {
    const terrain = field();
    terrain.sculpt(0, 0, 'raise', BRUSH);
    const peak = terrain.sampleHeight(0, 0);

    terrain.sculpt(0, 0, 'lower', BRUSH);

    expect(terrain.sampleHeight(0, 0)).toBeLessThan(peak);
  });

  it('never pushes heights outside the normalised range', () => {
    const terrain = field();
    for (let stroke = 0; stroke < 20; stroke += 1) terrain.sculpt(0, 0, 'raise', BRUSH);
    expect(terrain.sampleHeight(0, 0)).toBeLessThanOrEqual(terrain.maxHeight);

    for (let stroke = 0; stroke < 40; stroke += 1) terrain.sculpt(0, 0, 'lower', BRUSH);
    expect(terrain.sampleHeight(0, 0)).toBeGreaterThanOrEqual(0);
  });

  it('smooths a spike towards its surroundings', () => {
    const terrain = field();
    // A single sharp vertex, then smooth it.
    const centre = Math.floor(terrain.heights.length / 2);
    terrain.heights[centre] = 1;
    const world = terrain.gridToWorld(centre % terrain.width, Math.floor(centre / terrain.width));

    terrain.sculpt(world.x, world.z, 'smooth', { radius: 12, strength: 1 });

    expect(terrain.heights[centre]!).toBeLessThan(1);
    expect(terrain.heights[centre]!).toBeGreaterThan(0);
  });

  it('flattens towards the height under the brush centre', () => {
    const terrain = field();
    terrain.sculpt(0, 0, 'raise', { radius: 20, strength: 0.6 });
    const target = terrain.sampleHeight(0, 0);
    const before = terrain.sampleHeight(10, 0);

    terrain.sculpt(0, 0, 'flatten', { radius: 20, strength: 1 });

    // The outer sample moves towards the centre height rather than towards zero.
    expect(Math.abs(terrain.sampleHeight(10, 0) - target)).toBeLessThan(Math.abs(before - target));
  });

  it('reports when a brush lands entirely off the terrain', () => {
    const terrain = field();
    expect(terrain.sculpt(500, 500, 'raise', BRUSH)).toBe(false);
    expect(terrain.isFlat()).toBe(true);
  });

  it('interpolates between vertices rather than snapping to them', () => {
    const terrain = field(4, [40, 40], 10);
    terrain.heights[0] = 0;
    terrain.heights[1] = 1;

    // Halfway between grid columns 0 and 1 should read about half the height.
    const a = terrain.gridToWorld(0, 0);
    const b = terrain.gridToWorld(1, 0);
    const middle = terrain.sampleHeight((a.x + b.x) / 2, a.z);

    expect(middle).toBeGreaterThan(1);
    expect(middle).toBeLessThan(9);
  });
});

describe('TerrainField painting', () => {
  it('shifts weight towards the painted layer', () => {
    const terrain = field();
    terrain.paint(0, 0, 1, { radius: 10, strength: 1 });

    const centre =
      (Math.floor(terrain.width / 2) * terrain.width + Math.floor(terrain.width / 2)) * LAYER_COUNT;
    expect(terrain.weights[centre + 1]!).toBeGreaterThan(terrain.weights[centre]!);
  });

  it('keeps every vertex weight set summing to 255', () => {
    const terrain = field();
    terrain.paint(0, 0, 1, { radius: 10, strength: 0.4 });
    terrain.paint(4, 4, 2, { radius: 10, strength: 0.7 });
    terrain.paint(-3, 2, 3, { radius: 6, strength: 0.9 });

    for (let vertex = 0; vertex < terrain.width * terrain.width; vertex += 1) {
      let sum = 0;
      for (let channel = 0; channel < LAYER_COUNT; channel += 1) {
        sum += terrain.weights[vertex * LAYER_COUNT + channel]!;
      }
      expect(sum, `vertex ${vertex}`).toBe(255);
    }
  });

  it('clamps an out-of-range layer index instead of writing out of bounds', () => {
    const terrain = field();
    expect(() => terrain.paint(0, 0, 99, { radius: 8, strength: 1 })).not.toThrow();
    expect(() => terrain.paint(0, 0, -5, { radius: 8, strength: 1 })).not.toThrow();
  });
});

describe('TerrainField persistence', () => {
  it('round-trips a sculpted heightmap', () => {
    const source = field();
    source.sculpt(0, 0, 'raise', BRUSH);
    source.sculpt(12, -8, 'raise', { radius: 6, strength: 0.3 });

    const restored = field();
    restored.decodeHeights(source.encodeHeights());

    for (let index = 0; index < source.heights.length; index += 1) {
      // 16-bit quantisation, so equality is to within one part in 65535.
      expect(restored.heights[index]!).toBeCloseTo(source.heights[index]!, 4);
    }
  });

  it('round-trips painted weights exactly', () => {
    const source = field();
    source.paint(0, 0, 2, { radius: 10, strength: 0.8 });

    const restored = field();
    restored.decodeWeights(source.encodeWeights());

    expect([...restored.weights]).toEqual([...source.weights]);
  });

  it('survives a full encode/decode/encode cycle unchanged', () => {
    const source = field();
    source.sculpt(0, 0, 'raise', BRUSH);
    const once = source.encodeHeights();

    const restored = field();
    restored.decodeHeights(once);

    expect(restored.encodeHeights()).toBe(once);
  });

  it('stays sane when handed data from a smaller terrain', () => {
    const small = field(8);
    small.sculpt(0, 0, 'raise', BRUSH);

    const large = field(16);
    expect(() => large.decodeHeights(small.encodeHeights())).not.toThrow();
  });
});

describe('TerrainField geometry', () => {
  it('displaces vertices to match the field', () => {
    const terrain = field();
    terrain.sculpt(0, 0, 'raise', BRUSH);
    const geometry = terrain.buildGeometry(['#ff0000', '#00ff00', '#0000ff', '#ffffff']);

    const position = geometry.getAttribute('position');
    let highest = 0;
    for (let index = 0; index < position.count; index += 1) {
      highest = Math.max(highest, position.getY(index));
    }

    expect(highest).toBeCloseTo(terrain.sampleHeight(0, 0), 4);
    geometry.dispose();
  });

  it('colours vertices from the layer palette', () => {
    const terrain = field();
    const geometry = terrain.buildGeometry(['#ff0000', '#00ff00', '#0000ff', '#ffffff']);

    const color = geometry.getAttribute('color');
    // Untouched terrain is pure layer 0, which is red here.
    expect(color.getX(0)).toBeCloseTo(1, 3);
    expect(color.getY(0)).toBeCloseTo(0, 3);

    geometry.dispose();
  });

  it('updates an existing geometry in place', () => {
    const terrain = field();
    const geometry = terrain.buildGeometry(['#ff0000', '#00ff00', '#0000ff', '#ffffff']);
    const position = geometry.getAttribute('position') as THREE.BufferAttribute;

    terrain.sculpt(0, 0, 'raise', BRUSH);
    terrain.updateGeometry(geometry, ['#ff0000', '#00ff00', '#0000ff', '#ffffff']);

    // Same attribute object — a sculpt stroke must not swap the geometry the raycaster holds.
    expect(geometry.getAttribute('position')).toBe(position);
    // `needsUpdate` is write-only in Three; the version counter is what it bumps.
    expect(position.version).toBeGreaterThan(0);

    geometry.dispose();
  });
});
