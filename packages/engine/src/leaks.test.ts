import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseAssetManifest, parseScene, type Scene } from '@helaengine/schema';
import { ManifestAssetResolver } from './assets.js';
import { SceneLoader } from './SceneLoader.js';

/**
 * Sprint 36 — does the engine give back what it takes?
 *
 * The plan asks for a two-hour Play Preview session watched in Chrome's memory profiler. This is
 * the same question asked deterministically: a profiler tells you memory grew, this tells you
 * *which* resource was not released and fails a build over it. A number that drifts up on a graph
 * is an argument; an undisposed geometry with a name is a bug.
 *
 * Geometries and materials are counted by patching `dispose` on the prototypes, so nothing has to
 * be threaded through the loader for the test's benefit — the objects under test are exactly the
 * ones a browser would hold on the GPU.
 */

const manifest = parseAssetManifest({
  version: 1,
  assets: [
    {
      id: 'tree_pine_02',
      name: 'Pine Tree',
      category: 'trees',
      bounds: [1, 4, 1],
      placeholderColor: '#2f6f3f',
    },
    {
      id: 'trigger_volume',
      name: 'Trigger Volume',
      category: 'props',
      bounds: [1, 1, 1],
      placeholderColor: '#f2c14e',
    },
  ],
});

function sceneWith(count: number, withTriggers = false): Scene {
  return parseScene({
    sceneId: 'scene_leak',
    version: 1,
    name: 'Leak Check',
    objects: [
      ...Array.from({ length: count }, (_, index) => ({
        id: `obj_${String(index + 1).padStart(4, '0')}`,
        assetId: 'tree_pine_02',
        transform: { position: [index % 16, 0, Math.floor(index / 16)] },
      })),
      ...(withTriggers
        ? [
            {
              id: 'trg_0001',
              assetId: 'trigger_volume',
              kind: 'trigger' as const,
              transform: { position: [0, 1, 0] },
              trigger: { shape: 'box' as const, event: 'enter' as const, actions: [] },
            },
          ]
        : []),
    ],
  });
}

/**
 * Counts the GPU-backed resources freed while `body` runs.
 *
 * Patched for the duration of one measurement and restored afterwards, because a global patch left
 * in place would make every other test in this file count the others' disposals.
 */
async function disposalsDuring(body: () => Promise<void> | void): Promise<number> {
  let disposed = 0;

  const geometry = THREE.BufferGeometry.prototype;
  const material = THREE.Material.prototype;
  const originalGeometryDispose = geometry.dispose;
  const originalMaterialDispose = material.dispose;

  geometry.dispose = function patched(this: THREE.BufferGeometry) {
    disposed += 1;
    return originalGeometryDispose.call(this);
  };
  material.dispose = function patched(this: THREE.Material) {
    disposed += 1;
    return originalMaterialDispose.call(this);
  };

  try {
    await body();
  } finally {
    geometry.dispose = originalGeometryDispose;
    material.dispose = originalMaterialDispose;
  }

  return disposed;
}

function makeLoader(): SceneLoader {
  return new SceneLoader({ resolver: new ManifestAssetResolver(manifest) });
}

describe('what the loader frees', () => {
  it('disposes everything it built when the scene goes', async () => {
    const loaded = makeLoader().load(sceneWith(50, true));

    const disposed = await disposalsDuring(() => {
      loaded.dispose();
    });

    // The whole-scene path is the one the editor takes when a project closes, and it is the one
    // that has always worked. It is here as the control: if this ever drops to zero, the
    // measurement itself has broken rather than the engine.
    expect(disposed).toBeGreaterThan(0);
  });

  it('does not grow across repeated load and dispose cycles', async () => {
    // The soak, compressed: what a long session does to memory, without the two hours. Twenty
    // cycles of a fifty-object scene is six hundred objects' worth of churn.
    const counts: number[] = [];

    for (let cycle = 0; cycle < 20; cycle += 1) {
      const loader = makeLoader();
      const disposed = await disposalsDuring(() => {
        loader.load(sceneWith(50, true)).dispose();
      });
      counts.push(disposed);
    }

    // Every cycle frees the same amount. A cycle that frees *less* than the one before it is the
    // signature of a leak: something built this time was not built last time, or was not freed.
    expect(new Set(counts).size).toBe(1);
  });

  it('frees a released object rather than holding it until the scene closes', async () => {
    const loaded = makeLoader().load(sceneWith(20, true));

    const disposedOnRelease = await disposalsDuring(() => {
      // Deleting an object mid-session — the single most common editing action after placing one.
      loaded.release('trg_0001');
    });

    /**
     * This is the pitfall the sprint plan names by name: "un-disposed geometries/materials on
     * object deletion". A trigger volume builds its own edges geometry and line material, and
     * `release` detached the node without freeing either — so a session that placed and deleted
     * fifty triggers held fifty of each until the project was closed.
     */
    expect(disposedOnRelease).toBeGreaterThan(0);
  });

  it('does not free a released object a second time when the scene closes', async () => {
    const loaded = makeLoader().load(sceneWith(10, true));

    // Identities, not a count: the question is whether one *particular* resource is freed twice,
    // and two owners each freeing one thing looks identical to one owner freeing two.
    const seen: object[] = [];
    const geometry = THREE.BufferGeometry.prototype;
    const material = THREE.Material.prototype;
    const originalGeometryDispose = geometry.dispose;
    const originalMaterialDispose = material.dispose;
    geometry.dispose = function patched(this: THREE.BufferGeometry) {
      seen.push(this);
      return originalGeometryDispose.call(this);
    };
    material.dispose = function patched(this: THREE.Material) {
      seen.push(this);
      return originalMaterialDispose.call(this);
    };

    try {
      loaded.release('trg_0001');
      loaded.dispose();
    } finally {
      geometry.dispose = originalGeometryDispose;
      material.dispose = originalMaterialDispose;
    }

    // Disposing a Three.js resource twice is not fatal today, but it means two owners each believe
    // they are responsible — which is how the *next* refactor produces a use-after-free.
    expect(seen.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
