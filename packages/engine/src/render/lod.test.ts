import * as THREE from 'three';
import { LOD_PROFILES, lodDistances } from '@helaengine/schema';
import { describe, expect, it } from 'vitest';
import { LodGeometries, activeLodLevel, buildLod } from './lod.js';
import { canSimplify, simplifyGeometry, triangleCount } from './simplify.js';

/**
 * Decimation and the level tree.
 *
 * Two separable claims, tested separately. The decimator has to produce a mesh that is genuinely
 * smaller and still the same shape; the tree has to hand Three something it will swap between. What
 * neither can show — that the renderer actually draws fewer triangles when the camera backs away —
 * is in `apps/editor/e2e/lod.spec.ts`, measured against the WebGL renderer's own counter.
 */

/** A sphere: enough triangles to decimate, and a shape a bad decimator visibly ruins. */
function sphere(): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, 32, 24);
}

/** The mean distance of the vertices from the origin — a sphere's radius, if it is still a sphere. */
function meanRadius(geometry: THREE.BufferGeometry): number {
  const position = geometry.getAttribute('position');
  const vector = new THREE.Vector3();
  let total = 0;
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    vector.fromBufferAttribute(position as THREE.BufferAttribute, vertex);
    total += vector.length();
  }
  return total / position.count;
}

describe('simplifyGeometry', () => {
  it('produces a mesh with materially fewer triangles', () => {
    const source = sphere();
    const coarse = simplifyGeometry(source, 0.15);
    expect(coarse).not.toBeNull();
    expect(triangleCount(coarse!)).toBeLessThan(triangleCount(source) * 0.5);
    expect(triangleCount(coarse!)).toBeGreaterThan(0);
  });

  it('keeps the shape', () => {
    /**
     * The claim that makes it a level of detail rather than a corruption. A sphere of radius 1
     * decimated to a seventh of its triangles is still a ball of about radius 1 — clustering pulls
     * vertices to cell centroids, which shrinks it slightly and must not crush it.
     *
     * Without this, a decimator that returned a single tetrahedron would pass every other test
     * here: fewer triangles, non-empty, disposable.
     */
    const coarse = simplifyGeometry(sphere(), 0.15);
    expect(meanRadius(coarse!)).toBeGreaterThan(0.9);
    expect(meanRadius(coarse!)).toBeLessThan(1.05);

    const box = new THREE.Box3().setFromBufferAttribute(
      coarse!.getAttribute('position') as THREE.BufferAttribute,
    );
    expect(box.min.x).toBeLessThan(-0.85);
    expect(box.max.x).toBeGreaterThan(0.85);
  });

  it('carries the texture coordinates and keeps the normals unit length', () => {
    // Averaged normals do not stay unit length, and a shader that trusts them shades the coarse
    // mesh darker than the fine one — a swap that changes the object's brightness, which reads as a
    // bug rather than as a saving.
    const coarse = simplifyGeometry(sphere(), 0.2)!;
    expect(coarse.getAttribute('uv')).toBeDefined();

    const normal = coarse.getAttribute('normal') as THREE.BufferAttribute;
    const vector = new THREE.Vector3();
    for (let vertex = 0; vertex < normal.count; vertex += 1) {
      vector.fromBufferAttribute(normal, vertex);
      expect(vector.length()).toBeCloseTo(1, 3);
    }
  });

  it('leaves no degenerate triangles behind', () => {
    // A triangle whose corners collapsed into fewer than three cells draws nothing and is still
    // rasterised and shaded — cost with no picture, which is the opposite of the point.
    const coarse = simplifyGeometry(sphere(), 0.1)!;
    const index = coarse.getIndex()!;
    for (let triangle = 0; triangle < index.count / 3; triangle += 1) {
      const a = index.getX(triangle * 3);
      const b = index.getX(triangle * 3 + 1);
      const c = index.getX(triangle * 3 + 2);
      expect(a === b || b === c || a === c).toBe(false);
    }
  });

  it('refuses a rigged mesh', () => {
    /**
     * Clustering merges vertices that may belong to different bones, and averaging weights across a
     * joint gives a character whose elbow tears when it bends. Refusing is not a limitation to work
     * around: a torn elbow at forty metres is far more noticeable than the triangles saved.
     */
    const rigged = sphere();
    rigged.setAttribute(
      'skinIndex',
      new THREE.BufferAttribute(new Uint16Array(rigged.getAttribute('position').count * 4), 4),
    );
    expect(canSimplify(rigged)).toBe(false);
    expect(simplifyGeometry(rigged, 0.2)).toBeNull();
  });

  it('refuses when there is nothing to gain', () => {
    // A twelve-triangle box has no coarse version worth a second buffer on the GPU. Returning one
    // anyway would be a level-of-detail system that costs memory and saves nothing.
    expect(simplifyGeometry(new THREE.BoxGeometry(1, 1, 1), 0.3)).toBeNull();
  });
});

describe('buildLod', () => {
  const visual = (): THREE.Object3D => {
    const group = new THREE.Group();
    group.add(new THREE.Mesh(sphere(), new THREE.MeshStandardMaterial()));
    return group;
  };

  it('leaves the object alone when the mode is off', () => {
    // Off is the absence of the system rather than one level: no wrapper, no extra buffers, no
    // per-frame distance test. A scene saved before this existed renders exactly as it did.
    const cache = new LodGeometries();
    const node = visual();
    expect(buildLod(node, 'off', cache)).toBe(node);
    expect(cache.trianglesSaved).toBe(0);
  });

  it('builds one level per ratio, finest first', () => {
    const cache = new LodGeometries();
    const lod = buildLod(visual(), 'balanced', cache) as THREE.LOD;

    expect(lod.isLOD).toBe(true);
    expect(lod.levels).toHaveLength(LOD_PROFILES.balanced.ratios.length + 1);
    expect(lod.levels[0]?.distance).toBe(0);

    // Strictly decreasing triangle counts. Levels in the wrong order would draw the *coarsest* mesh
    // up close and the finest at distance — the feature exactly inverted, and still swapping.
    const counts = lod.levels.map((level) => {
      let total = 0;
      level.object.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) total += triangleCount(mesh.geometry);
      });
      return total;
    });
    expect(counts[1]).toBeLessThan(counts[0]!);
    expect(counts[2]).toBeLessThan(counts[1]!);
  });

  it('moves the transform onto the wrapper', () => {
    // The levels are clones that already carry the visual's own local transform. Leaving it on both
    // would apply the asset's default scale twice, so every object with levels would be the square
    // of its intended size.
    const node = visual();
    node.scale.set(2, 2, 2);
    node.position.set(3, 0, 0);

    const lod = buildLod(node, 'balanced', new LodGeometries()) as THREE.LOD;
    expect(lod.scale.x).toBe(2);
    expect(lod.position.x).toBe(3);
    expect(node.scale.x).toBe(1);
    expect(node.position.x).toBe(0);
  });

  it('switches further out for a bigger object', () => {
    // A distance in metres is meaningless without a size: forty metres is far for a crate and close
    // for a cathedral. A fixed number would pop on one and never trigger on the other.
    expect(lodDistances('balanced', 8)[0]).toBeGreaterThan(lodDistances('balanced', 1)[0]!);
    expect(lodDistances('aggressive', 8)[0]).toBeLessThan(lodDistances('balanced', 8)[0]!);
    // The floor: a small object's radius times fourteen is closer than the camera usually gets, and
    // an object that coarsens while you look straight at it is what makes people switch this off.
    expect(lodDistances('balanced', 0.1)[0]).toBe(6);
  });

  it('shares one decimation between every object using the same mesh', () => {
    const cache = new LodGeometries();
    const shared = sphere();

    const first = buildLod(meshOf(shared), 'balanced', cache) as THREE.LOD;
    const saved = cache.trianglesSaved;
    const second = buildLod(meshOf(shared), 'balanced', cache) as THREE.LOD;

    // A hundred crates share one geometry and therefore one decimation. Without the cache the same
    // mesh is clustered once per placement, which is where a few milliseconds becomes a stall.
    expect(geometryAt(second, 1)).toBe(geometryAt(first, 1));
    expect(cache.trianglesSaved).toBe(saved);
  });

  it('frees every geometry it made', () => {
    const cache = new LodGeometries();
    const disposed: string[] = [];
    const lod = buildLod(visual(), 'balanced', cache) as THREE.LOD;
    for (const step of [1, 2]) {
      geometryAt(lod, step)?.addEventListener('dispose', () => disposed.push(String(step)));
    }

    cache.dispose();
    expect(disposed).toHaveLength(2);
    expect(cache.trianglesSaved).toBe(0);
  });

  it('reports which level is showing, and nothing for an object without them', () => {
    const lod = buildLod(visual(), 'balanced', new LodGeometries());
    // Three has not run a distance test yet, so the finest level is the visible one.
    expect(activeLodLevel(lod)).toBe(0);
    expect(activeLodLevel(visual())).toBe(-1);
  });
});

function meshOf(geometry: THREE.BufferGeometry): THREE.Object3D {
  const group = new THREE.Group();
  group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial()));
  return group;
}

function geometryAt(lod: THREE.LOD, level: number): THREE.BufferGeometry | undefined {
  let found: THREE.BufferGeometry | undefined;
  lod.levels[level]?.object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.isMesh) found ??= mesh.geometry;
  });
  return found;
}
