import type * as THREE from 'three';
import { WaterSchema } from '@helaengine/schema';
import { describe, expect, it } from 'vitest';
import { buildWater } from './Water.js';

/**
 * The water surface, against its geometry.
 *
 * What a browser has to prove is that the pixels move and that they do not when water is off. What
 * can be asserted here is the part the shader depends on and cannot check for itself: that the depth
 * baked into every vertex is the real distance to the ground beneath it, signed.
 */

/** A bowl: ground at -3 in the middle, rising to +4 at the edges. */
const bowl = (x: number, z: number): number => {
  const fromCentre = Math.hypot(x, z) / 50;
  return -3 + fromCentre * 7;
};

function depths(mesh: THREE.Mesh): Float32Array {
  return (mesh.geometry.getAttribute('aDepth') as THREE.BufferAttribute).array as Float32Array;
}

const water = WaterSchema.parse({ height: 0, kind: 'pond' });

describe('buildWater', () => {
  it('bakes a signed depth against the ground under each vertex', () => {
    const surface = buildWater(water, [100, 100], bowl, '#a0c8ff');
    const values = depths(surface.mesh);

    // The middle is three metres deep; the rim is a metre of dry bank above the surface.
    expect(Math.max(...values)).toBeCloseTo(3, 1);
    expect(Math.min(...values)).toBeLessThan(0);

    /**
     * Negative rather than clamped, and this is the assertion that matters. The shader fades the
     * surface out over the last of the shallows, and discards where the depth has gone negative —
     * clamped to zero, every point on land reads as the waterline and the shore becomes a hard
     * edge again, which is the artefact the whole design is arranged around avoiding.
     */
    expect(values.some((value) => value < -0.5)).toBe(true);
    surface.dispose();
  });

  it('measures depth from the surface height, not from zero', () => {
    const raised = buildWater(WaterSchema.parse({ height: 2 }), [100, 100], bowl, '#a0c8ff');
    const surface = buildWater(water, [100, 100], bowl, '#a0c8ff');

    // Two metres higher is two metres deeper, everywhere.
    expect(Math.max(...depths(raised.mesh))).toBeCloseTo(Math.max(...depths(surface.mesh)) + 2, 1);
    // And the plane itself sits at the height it was given, or the waves are drawn in the wrong place.
    expect(raised.mesh.position.y).toBe(2);
    raised.dispose();
    surface.dispose();
  });

  it('lies flat, and is not culled by bounds the waves move outside', () => {
    const surface = buildWater(water, [100, 100], bowl, '#a0c8ff');
    const position = surface.mesh.geometry.getAttribute('position');

    // Built in XY by Three and rotated into XZ: a surface still standing upright is a wall.
    let spread = 0;
    for (let vertex = 0; vertex < position.count; vertex += 1) {
      spread = Math.max(spread, Math.abs(position.getY(vertex)));
    }
    expect(spread).toBeLessThan(0.001);
    expect(surface.mesh.frustumCulled).toBe(false);
    surface.dispose();
  });

  it('does not write depth, or the bed beneath it disappears', () => {
    // A transparent surface that writes depth carves a hole for everything drawn after it. The
    // symptom is water you can see through onto the sky rather than onto the bottom.
    const surface = buildWater(water, [100, 100], bowl, '#a0c8ff');
    const material = surface.mesh.material as THREE.ShaderMaterial;
    expect(material.transparent).toBe(true);
    expect(material.depthWrite).toBe(false);
    surface.dispose();
  });

  it('advances only when it is told to', () => {
    // The clock is the scene's, not the wall's: a paused game holds its waves still, and two runs
    // of the pre-delivery gate see the same surface at the same frame.
    const surface = buildWater(water, [100, 100], bowl, '#a0c8ff');
    const material = surface.mesh.material as THREE.ShaderMaterial;

    expect(material.uniforms['uTime']?.value).toBe(0);
    surface.update(2.5);
    expect(material.uniforms['uTime']?.value).toBe(2.5);
    surface.dispose();
  });

  it('frees what it made', () => {
    const surface = buildWater(water, [100, 100], bowl, '#a0c8ff');
    const freed: string[] = [];
    surface.mesh.geometry.addEventListener('dispose', () => freed.push('geometry'));
    (surface.mesh.material as THREE.Material).addEventListener('dispose', () =>
      freed.push('material'),
    );

    surface.dispose();
    expect(freed.sort()).toEqual(['geometry', 'material']);
  });
});

describe('a setting that did not arrive', () => {
  it('still builds a surface when a wave value is missing', () => {
    /**
     * The failure this guards against is the worst shape a bug can take here, and it happened: a
     * partial environment patch that never went through the schema left `waveScale` undefined, the
     * shader divided by it, and every vertex of the plane became NaN. Nothing was logged — no
     * shader warning, no exception, no console output. The plane was in the scene, visible,
     * positioned correctly, with the right attributes and a compiled material, and drew nothing.
     *
     * A document like this cannot come out of the schema, which is why the assertion is about the
     * *symptom* rather than the value: whatever arrives, the geometry must stay finite.
     */
    const broken = { ...water, waveScale: undefined } as unknown as typeof water;
    const surface = buildWater(broken, [100, 100], bowl, '#a0c8ff');
    const material = surface.mesh.material as THREE.ShaderMaterial;

    expect(Number.isFinite(material.uniforms['uWaveScale']?.value as number)).toBe(true);
    expect((material.uniforms['uWaveScale']?.value as number) > 0).toBe(true);
    surface.dispose();
  });

  it('keeps the author’s value when there is one — the control', () => {
    // Without this the guard could be "always use the default", which would silently ignore every
    // wave setting anybody ever typed.
    const surface = buildWater(WaterSchema.parse({ waveScale: 17 }), [100, 100], bowl, '#a0c8ff');
    const material = surface.mesh.material as THREE.ShaderMaterial;
    expect(material.uniforms['uWaveScale']?.value).toBe(17);
    surface.dispose();
  });
});
