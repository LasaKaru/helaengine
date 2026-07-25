import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseAssetManifest, parseScene, type Scene } from '@helaengine/schema';
import { ManifestAssetResolver } from './assets.js';
import { MissingAssetError, SceneLoader } from './SceneLoader.js';

const manifest = parseAssetManifest({
  version: 1,
  assets: [
    {
      id: 'tree_pine_02',
      name: 'Pine Tree',
      category: 'trees',
      placeholderSize: [1, 4, 1],
      placeholderColor: '#2f6f3f',
    },
    {
      id: 'rock_small_01',
      name: 'Small Rock',
      category: 'rocks',
      placeholderSize: [1, 1, 1],
      defaultScale: [2, 2, 2],
      placeholderColor: '#7a7a7a',
    },
  ],
});

function makeLoader(overrides: Partial<ConstructorParameters<typeof SceneLoader>[0]> = {}) {
  return new SceneLoader({
    resolver: new ManifestAssetResolver(manifest),
    warn: () => {},
    ...overrides,
  });
}

function makeScene(objects: unknown[]): Scene {
  return parseScene({ sceneId: 'scene_test', version: 1, objects });
}

describe('SceneLoader', () => {
  it('places objects at the world coordinates given in the document', () => {
    const loaded = makeLoader().load(
      makeScene([
        {
          id: 'obj_0001',
          assetId: 'tree_pine_02',
          transform: { position: [10, 0, -4], rotation: [0, 90, 0], scale: [1, 1, 1] },
        },
      ]),
    );

    const mesh = loaded.objects.get('obj_0001');
    expect(mesh).toBeDefined();
    expect(mesh!.position.toArray()).toEqual([10, 0, -4]);
    // Rotation is authored in degrees and converted exactly once, here.
    expect(mesh!.rotation.y).toBeCloseTo(Math.PI / 2, 10);

    loaded.dispose();
  });

  it('multiplies the instance scale by the asset default scale', () => {
    const loaded = makeLoader().load(
      makeScene([{ id: 'obj_0001', assetId: 'rock_small_01', transform: { scale: [3, 3, 3] } }]),
    );

    expect(loaded.objects.get('obj_0001')!.scale.toArray()).toEqual([6, 6, 6]);
    loaded.dispose();
  });

  it('grounds placeholders so y=0 rests on the terrain', () => {
    const loaded = makeLoader().load(makeScene([{ id: 'obj_0001', assetId: 'tree_pine_02' }]));

    const box = new THREE.Box3().setFromObject(loaded.objects.get('obj_0001')!);
    expect(box.min.y).toBeCloseTo(0, 6);
    expect(box.max.y).toBeCloseTo(4, 6);

    loaded.dispose();
  });

  it('builds terrain sized from the document', () => {
    const scene = parseScene({
      sceneId: 'scene_test',
      version: 1,
      terrain: { size: [64, 32] },
      objects: [],
    });
    const loaded = makeLoader().load(scene);

    const terrain = loaded.threeScene.getObjectByName('terrain');
    expect(terrain).toBeDefined();
    const box = new THREE.Box3().setFromObject(terrain!);
    expect(box.max.x - box.min.x).toBeCloseTo(64, 6);
    expect(box.max.z - box.min.z).toBeCloseTo(32, 6);

    loaded.dispose();
  });

  it('applies environment fog and lighting from the document', () => {
    const scene = parseScene({
      sceneId: 'scene_test',
      version: 1,
      environment: {
        fog: { color: '#a0c8ff', near: 10, far: 200 },
        lighting: { ambient: 0.7, sun: { intensity: 2 } },
      },
      objects: [],
    });
    const loaded = makeLoader().load(scene);

    expect((loaded.threeScene.fog as THREE.Fog).far).toBe(200);
    expect((loaded.threeScene.getObjectByName('ambient') as THREE.AmbientLight).intensity).toBe(
      0.7,
    );
    expect((loaded.threeScene.getObjectByName('sun') as THREE.DirectionalLight).intensity).toBe(2);

    loaded.dispose();
  });

  it('bounds content by the placed objects, not the terrain or lights', () => {
    const scene = parseScene({
      sceneId: 'scene_test',
      version: 1,
      terrain: { size: [512, 512] },
      objects: [{ id: 'obj_0001', assetId: 'tree_pine_02', transform: { position: [5, 0, 5] } }],
    });
    const loaded = makeLoader().load(scene);

    const box = loaded.getContentBounds();
    // The 512m terrain and the sun 100m overhead must not drag the bounds outwards.
    expect(box.max.x).toBeCloseTo(5.5, 6);
    expect(box.max.y).toBeCloseTo(4, 6);

    loaded.dispose();
  });

  it('falls back to terrain bounds when a scene has no objects', () => {
    const scene = parseScene({
      sceneId: 'scene_test',
      version: 1,
      terrain: { size: [64, 64] },
      objects: [],
    });
    const loaded = makeLoader().load(scene);

    const box = loaded.getContentBounds();
    expect(box.isEmpty()).toBe(false);
    expect(box.max.x - box.min.x).toBeCloseTo(64, 6);

    loaded.dispose();
  });

  it('shares one geometry between instances of the same asset', () => {
    const loaded = makeLoader().load(
      makeScene([
        { id: 'obj_0001', assetId: 'tree_pine_02' },
        { id: 'obj_0002', assetId: 'tree_pine_02' },
      ]),
    );

    const first = loaded.objects.get('obj_0001') as THREE.Mesh;
    const second = loaded.objects.get('obj_0002') as THREE.Mesh;
    expect(first.geometry).toBe(second.geometry);

    loaded.dispose();
  });

  it('substitutes a placeholder for an unknown assetId and reports it', () => {
    const loaded = makeLoader().load(makeScene([{ id: 'obj_0001', assetId: 'does_not_exist' }]));

    expect(loaded.missingAssetIds).toEqual(['does_not_exist']);
    expect(loaded.objects.get('obj_0001')).toBeDefined();

    loaded.dispose();
  });

  it('throws on an unknown assetId when configured to be strict', () => {
    const loader = makeLoader({ onMissingAsset: 'throw' });
    expect(() => loader.load(makeScene([{ id: 'obj_0001', assetId: 'nope' }]))).toThrow(
      MissingAssetError,
    );
  });

  it('disposes every geometry and material it created', () => {
    const loaded = makeLoader().load(
      makeScene([
        { id: 'obj_0001', assetId: 'tree_pine_02' },
        { id: 'obj_0002', assetId: 'rock_small_01' },
      ]),
    );

    const disposed: string[] = [];
    loaded.threeScene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.addEventListener('dispose', () => disposed.push('geometry'));
      (mesh.material as THREE.Material).addEventListener('dispose', () =>
        disposed.push('material'),
      );
    });

    loaded.dispose();

    // 3 geometries (terrain + two assets) and 3 materials (terrain + two colours).
    expect(disposed.filter((kind) => kind === 'geometry')).toHaveLength(3);
    expect(disposed.filter((kind) => kind === 'material')).toHaveLength(3);
    expect(loaded.threeScene.children).toHaveLength(0);
  });
});
