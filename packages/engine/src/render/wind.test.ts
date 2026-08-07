import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { WindSchema, type Wind } from '@helaengine/schema';
import { applyWindToObject, createWindUniforms, modelBaseY, updateWindUniforms } from './wind.js';

/**
 * The sway program, checked as source rather than by rendering it.
 *
 * A WebGL context is not available here, and asking for one would mean testing three.js rather than
 * this file. What is worth pinning is the set of things that were wrong the first time I wrote it,
 * each of which produces a world that renders happily and looks broken:
 *
 *  - bending around the model's centre instead of its base, so trunks leave the ground
 *  - ignoring `instanceMatrix`, so a scattered field sways as one rigid sheet
 *  - adding a world-space offset to a model-space vertex, so rotated plants lean the wrong way
 *
 * None of those throw. All of them are visible in the generated shader.
 */

const wind = (parts: Partial<Wind> = {}): Wind =>
  WindSchema.parse({ strength: 1, ...parts }) as Wind;

/** Compiles the patch the way three.js would, and hands back the vertex shader it produced. */
function patchedVertexSource(material: THREE.Material): string {
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: 'void main() {\n#include <project_vertex>\n}',
    fragmentShader: '',
  };
  material.onBeforeCompile?.(shader as never, null as never);
  return shader.vertexShader;
}

function plant(baseY = 0): THREE.Mesh {
  const geometry = new THREE.BoxGeometry(1, 2, 1);
  geometry.translate(0, baseY + 1, 0);
  return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
}

describe('modelBaseY', () => {
  it('finds the lowest vertex, not the origin', () => {
    // The shipped models disagree about where their origin is: some sit on y=0, some are centred on
    // their bounding box. Assuming zero is what swings a tree through the ground.
    expect(modelBaseY(plant(0))).toBeCloseTo(0, 5);
    expect(modelBaseY(plant(-1))).toBeCloseTo(-1, 5);
    expect(modelBaseY(plant(3))).toBeCloseTo(3, 5);
  });

  it('answers zero for something with no geometry at all', () => {
    expect(modelBaseY(new THREE.Group())).toBe(0);
  });
});

describe('the generated shader', () => {
  it('bends around the model base rather than the origin', () => {
    const mesh = plant(-1);
    applyWindToObject(mesh, createWindUniforms(wind()), 'trees');
    const source = patchedVertexSource(mesh.material as THREE.Material);

    expect(source).toContain('transformed.y - helaModelBase');
    // Clamped, or a vertex below the base bends backwards.
    expect(source).toContain('max(transformed.y - helaModelBase, 0.0)');
  });

  it('includes the instance matrix, so a batch does not sway as one sheet', () => {
    const mesh = plant();
    applyWindToObject(mesh, createWindUniforms(wind()), 'grass');
    const source = patchedVertexSource(mesh.material as THREE.Material);

    // three.js applies instancing inside `project_vertex`, which runs after this patch — so without
    // this every blade in a batch shares one world position and one phase.
    expect(source).toContain('#ifdef USE_INSTANCING');
    expect(source).toContain('modelMatrix * instanceMatrix');
  });

  it('rotates the wind into model space', () => {
    const mesh = plant();
    applyWindToObject(mesh, createWindUniforms(wind()), 'grass');
    const source = patchedVertexSource(mesh.material as THREE.Material);

    // Scattered grass is randomly rotated by design, so adding a world-space offset directly would
    // make half a field bend into the wind rather than with it.
    expect(source).toContain('inverse(mat3(helaModel))');
  });

  it('runs before project_vertex, where transformed still exists', () => {
    const mesh = plant();
    applyWindToObject(mesh, createWindUniforms(wind()), 'trees');
    const source = patchedVertexSource(mesh.material as THREE.Material);

    expect(source.indexOf('transformed +=')).toBeLessThan(
      source.indexOf('#include <project_vertex>'),
    );
  });
});

describe('applyWindToObject', () => {
  it('shares one uniform set across every patched material', () => {
    // The point of one wind for the level: a single write per frame drives the whole world.
    const uniforms = createWindUniforms(wind());
    const a = plant();
    const b = plant();
    applyWindToObject(a, uniforms, 'trees');
    applyWindToObject(b, uniforms, 'trees');

    const shaderA = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: 'void main() {\n#include <project_vertex>\n}',
    };
    const shaderB = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: 'void main() {\n#include <project_vertex>\n}',
    };
    (a.material as THREE.Material).onBeforeCompile?.(shaderA as never, null as never);
    (b.material as THREE.Material).onBeforeCompile?.(shaderB as never, null as never);

    expect(shaderA.uniforms.helaWindTime).toBe(shaderB.uniforms.helaWindTime);
  });

  it('gives the material a cache key, or half the scene silently will not move', () => {
    const mesh = plant();
    applyWindToObject(mesh, createWindUniforms(wind()), 'trees');

    // Without this three.js reuses the compiled program of an identical-looking unpatched material.
    // The failure is silent and partial, which is the worst shape a rendering bug can take.
    const key = (mesh.material as THREE.Material).customProgramCacheKey?.();
    expect(key).toContain('helaWind');
    expect(key).toContain('trees');
  });

  it('does not patch the same material twice', () => {
    const mesh = plant();
    const uniforms = createWindUniforms(wind());
    applyWindToObject(mesh, uniforms, 'trees');
    const first = (mesh.material as THREE.Material).onBeforeCompile;
    applyWindToObject(mesh, uniforms, 'trees');

    // Adopting a scene twice must not stack two programs, which would double the sway.
    expect((mesh.material as THREE.Material).onBeforeCompile).toBe(first);
  });

  it('clones rather than restamping when two objects want different groups', () => {
    /**
     * Materials are shared per asset — that is what makes one compiled program serve a forest. So
     * patching in place would let the last object placed decide how every other one moves: setting
     * one hedge to `none` would stop the whole species swaying.
     */
    const shared = new THREE.MeshStandardMaterial();
    const a = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), shared);
    const b = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), shared);
    const uniforms = createWindUniforms(wind());

    applyWindToObject(a, uniforms, 'trees');
    applyWindToObject(b, uniforms, 'grass');

    expect(a.material).toBe(shared);
    expect(b.material).not.toBe(shared);
    expect((a.material as THREE.Material).customProgramCacheKey?.()).toContain('trees');
    expect((b.material as THREE.Material).customProgramCacheKey?.()).toContain('grass');
  });

  it('reports how many materials it touched', () => {
    const group = new THREE.Group();
    group.add(plant(), plant());
    expect(applyWindToObject(group, createWindUniforms(wind()), 'trees')).toBe(2);
    expect(applyWindToObject(new THREE.Group(), createWindUniforms(wind()), 'trees')).toBe(0);
  });
});

describe('uniforms', () => {
  it('scales the direction by strength, so one vector carries both', () => {
    const uniforms = createWindUniforms(wind({ strength: 2, direction: 90 }));
    expect(uniforms.helaWind.value.x).toBeCloseTo(2, 5);
    expect(uniforms.helaWind.value.y).toBeCloseTo(0, 5);
  });

  it('takes a new setting without rebuilding', () => {
    const uniforms = createWindUniforms(wind({ strength: 1, direction: 90 }));
    updateWindUniforms(uniforms, wind({ strength: 3, direction: 270, gustiness: 0.9 }));

    expect(uniforms.helaWind.value.x).toBeCloseTo(-3, 5);
    expect(uniforms.helaWindGust.value).toBeCloseTo(0.9, 5);
  });
});
