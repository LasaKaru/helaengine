import * as THREE from 'three';
import { SURFACE_KINDS, SURFACE_SCALE_REPEAT, type SurfaceKind } from '@helaengine/schema';
import { describe, expect, it } from 'vitest';
import { SurfaceTextures } from './surfaces.js';

/**
 * The generated surface maps.
 *
 * These are asserted against the *bytes*, which is unusually direct for this codebase and is only
 * possible because generation is a pure function of (kind, scale) with no `Math.random` anywhere.
 * That is the point of the constraint: a normal map can be checked for the thing that makes it a
 * normal map rather than merely for existing.
 *
 * What a browser has to prove instead — that binding these to a material changes the pixels — is in
 * `apps/editor/e2e/surfaces.spec.ts`. Neither half is sufficient. A map full of correct-looking
 * bytes that no material samples is exactly the failure this repository keeps being bitten by.
 */

/** The RGBA texel at (x, y) of a generated map. */
function texel(texture: THREE.Texture, x: number, y: number): [number, number, number, number] {
  const data = (texture.image as { data: Uint8Array; width: number }).data;
  const width = (texture.image as { width: number }).width;
  const at = (y * width + x) * 4;
  return [data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!];
}

function size(texture: THREE.Texture): number {
  return (texture.image as { width: number }).width;
}

describe('generated surface maps', () => {
  it('produces both maps for every kind in the vocabulary', () => {
    const textures = new SurfaceTextures();
    for (const kind of SURFACE_KINDS) {
      const maps = textures.get(kind, 'normal');
      expect(size(maps.normalMap), kind).toBeGreaterThan(0);
      expect(size(maps.ormMap), kind).toBeGreaterThan(0);
    }
    textures.dispose();
  });

  it('generates identical bytes twice over, on the same inputs', () => {
    // Determinism is load-bearing rather than tidy: an export whose surfaces differed from the
    // editor preview they were made in would be an export the pre-delivery gate could not check.
    const first = new SurfaceTextures().get('brick', 'normal');
    const second = new SurfaceTextures().get('brick', 'normal');
    const bytes = (texture: THREE.Texture): Uint8Array =>
      (texture.image as { data: Uint8Array }).data;

    expect(bytes(second.normalMap)).toEqual(bytes(first.normalMap));
    expect(bytes(second.ormMap)).toEqual(bytes(first.ormMap));
  });

  it('shares one texture pair between every object asking for the same kind and scale', () => {
    const textures = new SurfaceTextures();
    const first = textures.get('stone', 'coarse');
    const second = textures.get('stone', 'coarse');

    // Fifty stone walls are one pair of textures. Generating per object would put fifty copies of
    // the same 256×256 map on the GPU, which is the whole reason the cache exists.
    expect(second.normalMap).toBe(first.normalMap);
    expect(textures.get('stone', 'fine').normalMap).not.toBe(first.normalMap);
    textures.dispose();
  });

  it('tiles the pattern according to the scale', () => {
    const textures = new SurfaceTextures();
    for (const scale of ['fine', 'normal', 'coarse'] as const) {
      const maps = textures.get('tile', scale);
      expect(maps.normalMap.repeat.x).toBe(SURFACE_SCALE_REPEAT[scale]);
      expect(maps.ormMap.repeat.x).toBe(SURFACE_SCALE_REPEAT[scale]);
    }
    textures.dispose();
  });

  it('samples the maps without colour conversion', () => {
    // A normal map read as sRGB has every value bent along the transfer curve, and the symptom is
    // lighting that is subtly wrong everywhere rather than anything that looks broken.
    const maps = new SurfaceTextures().get('metal', 'normal');
    expect(maps.normalMap.colorSpace).toBe(THREE.NoColorSpace);
    expect(maps.ormMap.colorSpace).toBe(THREE.NoColorSpace);
  });

  it('repeats without a seam', () => {
    /**
     * The pattern has to wrap, or the repeat shows as a hard grid of lines across the object — the
     * single most recognisable failure a generated texture has.
     *
     * Measured on the occlusion channel rather than the normal map, and that took a wrong test to
     * work out. The normal map is a *derivative*: where a joint falls on the texture edge, the two
     * walls of that groove legitimately tilt in opposite directions, so the first and last columns
     * differ enormously in a pattern that tiles perfectly. Occlusion is a blur of the height field
     * and is therefore continuous wherever the height is, which is exactly the property under test.
     */
    const textures = new SurfaceTextures();
    for (const kind of SURFACE_KINDS) {
      const map = textures.get(kind, 'normal').ormMap;
      const width = size(map);

      let acrossTheSeam = 0;
      let withinTheTexture = 0;
      for (let y = 0; y < width; y += 1) {
        acrossTheSeam += Math.abs(texel(map, 0, y)[0] - texel(map, width - 1, y)[0]);
        // Ten arbitrary interior pairs, so the comparison is against this kind's own texel-to-texel
        // variation rather than against a number picked by hand. A smooth kind and a noisy one have
        // very different baselines, and a single fixed threshold would either pass everything or
        // fail plaster.
        for (let x = 20; x < 220; x += 20) {
          withinTheTexture += Math.abs(texel(map, x, y)[0] - texel(map, x + 1, y)[0]) / 10;
        }
      }

      expect(acrossTheSeam, `${kind} seam`).toBeLessThan(withinTheTexture * 3 + 256);
    }
    textures.dispose();
  });

  it('encodes flat as pointing straight out, and a joint as pointing sideways', () => {
    /**
     * The property that makes a normal map a normal map: red and green are the surface's tilt, blue
     * is how much of it faces the viewer. A flat texel is (128, 128, 255); a texel on the wall of a
     * mortar joint is tilted, so its red or green is a long way from 128.
     *
     * Without this, a map full of any bytes at all would pass — including the all-zero buffer a
     * generator that silently did nothing would produce.
     */
    const map = new SurfaceTextures().get('brick', 'normal').normalMap;
    const width = size(map);

    let flat = 0;
    let tilted = 0;
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const [red, green, blue] = texel(map, x, y);
        const tilt = Math.max(Math.abs(red - 128), Math.abs(green - 128));
        if (tilt > 40) tilted += 1;
        else if (blue > 240) flat += 1;
      }
    }

    // Mostly flat brick face, with the joints as a minority — a pattern that was *mostly* joint
    // would be a wall of grooves rather than a wall of bricks.
    expect(flat).toBeGreaterThan(width * width * 0.4);
    expect(tilted).toBeGreaterThan(width * 4);
    expect(tilted).toBeLessThan(width * width * 0.5);
  });

  it('darkens the joints and leaves the faces lit', () => {
    // The occlusion channel. A map that came out uniform would bind, sample, and contribute nothing
    // — which looks exactly like the feature not existing.
    const map = new SurfaceTextures().get('tile', 'normal').ormMap;
    const width = size(map);

    let darkest = 255;
    let brightest = 0;
    for (let y = 0; y < width; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const occlusion = texel(map, x, y)[0];
        darkest = Math.min(darkest, occlusion);
        brightest = Math.max(brightest, occlusion);
      }
    }

    expect(brightest - darkest).toBeGreaterThan(40);
  });

  it('gives each kind its own roughness, and only metal any metalness', () => {
    const textures = new SurfaceTextures();
    const meanChannel = (kind: SurfaceKind, channel: 1 | 2): number => {
      const map = textures.get(kind, 'normal').ormMap;
      const data = (map.image as { data: Uint8Array }).data;
      let total = 0;
      for (let at = channel; at < data.length; at += 4) total += data[at]!;
      return total / (data.length / 4);
    };

    // Concrete is rougher than tile, which is glazed. If the roughness channel were constant this
    // would pass by accident, so the metalness assertion below carries the other half.
    expect(meanChannel('concrete', 1)).toBeGreaterThan(meanChannel('tile', 1));
    expect(meanChannel('metal', 2)).toBeGreaterThan(200);
    expect(meanChannel('brick', 2)).toBe(0);
    textures.dispose();
  });

  it('frees every texture it made', () => {
    // The reason the cache is owned by the scene rather than by the module: the editor rebuilds a
    // scene constantly, and maps that outlive it are a leak whose only symptom is a tab getting
    // slower over an afternoon.
    const textures = new SurfaceTextures();
    const disposed: string[] = [];
    for (const kind of SURFACE_KINDS) {
      const maps = textures.get(kind, 'normal');
      maps.normalMap.addEventListener('dispose', () => disposed.push(`${kind}:normal`));
      maps.ormMap.addEventListener('dispose', () => disposed.push(`${kind}:orm`));
    }

    textures.dispose();
    expect(disposed).toHaveLength(SURFACE_KINDS.length * 2);
  });
});
