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
      bounds: [1, 4, 1],
      placeholderColor: '#2f6f3f',
    },
    {
      id: 'rock_small_01',
      name: 'Small Rock',
      category: 'rocks',
      bounds: [1, 1, 1],
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

    // The object node carries the document's scale; the manifest default lives on an inner node,
    // so the two multiply out to the effective world scale.
    const node = loaded.objects.get('obj_0001')!;
    expect(node.scale.toArray()).toEqual([3, 3, 3]);
    node.updateWorldMatrix(true, true);
    expect(
      node.getObjectByName('obj_0001:visual')!.getWorldScale(new THREE.Vector3()).toArray(),
    ).toEqual([6, 6, 6]);

    loaded.dispose();
  });

  it('keeps an asset default scale off nested children', () => {
    // A child of a scaled parent must inherit the parent's *document* scale, not the manifest
    // default of the parent's asset — that is a rendering detail, not part of the scene graph.
    const loaded = makeLoader().load(
      makeScene([
        { id: 'parent', assetId: 'rock_small_01' },
        { id: 'child', assetId: 'tree_pine_02', parentId: 'parent' },
      ]),
    );

    const child = loaded.objects.get('child')!;
    child.updateWorldMatrix(true, true);
    expect(child.getWorldScale(new THREE.Vector3()).toArray()).toEqual([1, 1, 1]);

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

    const first = loaded.objects.get('obj_0001')!.children[0] as THREE.Mesh;
    const second = loaded.objects.get('obj_0002')!.children[0] as THREE.Mesh;
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

/** Stands in for a GLB download: hands back a tagged mesh, or fails on demand. */
class FakeModelSource {
  readonly requests: string[] = [];
  #fail = new Set<string>();

  constructor(failFor: string[] = []) {
    this.#fail = new Set(failFor);
  }

  async load(assetId: string, glbPath: string): Promise<THREE.Object3D> {
    this.requests.push(glbPath);
    if (this.#fail.has(assetId)) throw new Error('404');
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(1, 6, 4),
      new THREE.MeshStandardMaterial(),
    );
    mesh.userData['fromModel'] = assetId;
    return mesh;
  }

  dispose(): void {}
}

const manifestWithModels = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'tree_pine_02', name: 'Pine', category: 'trees', glbPath: 'models/tree_pine_02.glb' },
    { id: 'rock_small_01', name: 'Rock', category: 'rocks', glbPath: 'models/rock_small_01.glb' },
    { id: 'logic_trigger', name: 'Trigger', category: 'props', bounds: [2, 2, 2] },
  ],
});

function makeModelLoader(source: FakeModelSource): SceneLoader {
  return new SceneLoader({
    resolver: new ManifestAssetResolver(manifestWithModels),
    modelSource: source,
    warn: () => {},
  });
}

describe('SceneLoader model preloading', () => {
  it('uses a preloaded model instead of a placeholder box', async () => {
    const loader = makeModelLoader(new FakeModelSource());
    const scene = makeScene([{ id: 'obj_0001', assetId: 'tree_pine_02' }]);

    await loader.preload(scene);
    const loaded = loader.load(scene);

    expect(loaded.objects.get('obj_0001')!.userData['hasModel']).toBe(true);
    loaded.dispose();
  });

  it('renders placeholders when preload was never called', () => {
    const loaded = makeModelLoader(new FakeModelSource()).load(
      makeScene([{ id: 'obj_0001', assetId: 'tree_pine_02' }]),
    );

    expect(loaded.objects.get('obj_0001')!.userData['hasModel']).toBe(false);
    loaded.dispose();
  });

  it('fetches each asset once no matter how many instances use it', async () => {
    const source = new FakeModelSource();
    const loader = makeModelLoader(source);
    const scene = makeScene([
      { id: 'obj_0001', assetId: 'tree_pine_02' },
      { id: 'obj_0002', assetId: 'tree_pine_02' },
      { id: 'obj_0003', assetId: 'tree_pine_02' },
    ]);

    const report = await loader.preload(scene);

    expect(source.requests).toEqual(['models/tree_pine_02.glb']);
    expect(report).toMatchObject({ requested: 1, loaded: 1 });
  });

  it('skips assets that have no model, leaving them as placeholders', async () => {
    const source = new FakeModelSource();
    const loader = makeModelLoader(source);

    const report = await loader.preload(makeScene([{ id: 'obj_0001', assetId: 'logic_trigger' }]));

    expect(source.requests).toEqual([]);
    expect(report.requested).toBe(0);
  });

  it('degrades a failed download to a placeholder instead of failing the scene', async () => {
    const loader = makeModelLoader(new FakeModelSource(['rock_small_01']));
    const scene = makeScene([
      { id: 'obj_0001', assetId: 'tree_pine_02' },
      { id: 'obj_0002', assetId: 'rock_small_01' },
    ]);

    const report = await loader.preload(scene);
    const loaded = loader.load(scene);

    expect(report).toMatchObject({ requested: 2, loaded: 1 });
    expect(report.failed[0]).toMatchObject({ assetId: 'rock_small_01', reason: '404' });
    // The healthy asset still renders as a model, and the broken one still renders as something.
    expect(loaded.objects.get('obj_0001')!.userData['hasModel']).toBe(true);
    expect(loaded.objects.get('obj_0002')!.userData['hasModel']).toBe(false);

    loaded.dispose();
  });

  it('reports progress once per asset plus an initial tick', async () => {
    const loader = makeModelLoader(new FakeModelSource());
    const ticks: Array<[number, number]> = [];

    await loader.preload(
      makeScene([
        { id: 'obj_0001', assetId: 'tree_pine_02' },
        { id: 'obj_0002', assetId: 'rock_small_01' },
      ]),
      (completed, total) => ticks.push([completed, total]),
    );

    expect(ticks[0]).toEqual([0, 2]);
    expect(ticks.at(-1)).toEqual([2, 2]);
  });

  it('clones models so instances do not share a transform', async () => {
    const loader = makeModelLoader(new FakeModelSource());
    const scene = makeScene([
      { id: 'obj_0001', assetId: 'tree_pine_02', transform: { position: [1, 0, 0] } },
      { id: 'obj_0002', assetId: 'tree_pine_02', transform: { position: [9, 0, 0] } },
    ]);

    await loader.preload(scene);
    const loaded = loader.load(scene);

    const first = loaded.objects.get('obj_0001')!;
    const second = loaded.objects.get('obj_0002')!;
    expect(first).not.toBe(second);
    expect(first.position.x).toBe(1);
    expect(second.position.x).toBe(9);
    // Clones share geometry with the source model — that is what makes 200 trees affordable.
    expect((first.children[0] as THREE.Mesh).geometry).toBe(
      (second.children[0] as THREE.Mesh).geometry,
    );

    loaded.dispose();
  });
});

describe('SceneLoader.loadInto', () => {
  it('populates a scene it does not own', () => {
    const host = new THREE.Scene();
    const loaded = makeLoader().loadInto(host, makeScene([{ id: 'o1', assetId: 'tree_pine_02' }]));

    expect(loaded.threeScene).toBe(host);
    expect(host.getObjectByName('terrain')).toBeDefined();
    expect(host.getObjectByName('o1')).toBeDefined();

    loaded.dispose();
  });

  it('leaves pre-existing children alone on dispose', () => {
    // react-three-fiber owns the editor's scene and puts its own helpers in it. Tearing a scene
    // document down must not take those with it.
    const host = new THREE.Scene();
    const hostOwned = new THREE.Object3D();
    hostOwned.name = 'r3f-grid';
    host.add(hostOwned);

    const loaded = makeLoader().loadInto(host, makeScene([{ id: 'o1', assetId: 'tree_pine_02' }]));
    expect(host.children.length).toBeGreaterThan(1);

    loaded.dispose();

    expect(host.children).toEqual([hostOwned]);
    expect(host.background).toBeNull();
    expect(host.fog).toBeNull();
  });

  it('swaps cleanly when the same host is reloaded', () => {
    const host = new THREE.Scene();
    const loader = makeLoader();

    const first = loader.loadInto(host, makeScene([{ id: 'o1', assetId: 'tree_pine_02' }]));
    first.dispose();
    const second = loader.loadInto(host, makeScene([{ id: 'o2', assetId: 'rock_small_01' }]));

    expect(host.getObjectByName('o1')).toBeUndefined();
    expect(host.getObjectByName('o2')).toBeDefined();

    second.dispose();
    expect(host.children).toHaveLength(0);
  });
});

describe('LoadedScene.syncTransforms', () => {
  function sceneWith(position: [number, number, number], rotationY = 0, scale = 1) {
    return parseScene({
      sceneId: 'scene_test',
      version: 1,
      objects: [
        {
          id: 'obj_0001',
          assetId: 'rock_small_01',
          transform: { position, rotation: [0, rotationY, 0], scale: [scale, scale, scale] },
        },
      ],
    });
  }

  it('moves existing nodes without rebuilding them', () => {
    const loader = makeLoader();
    const loaded = loader.load(sceneWith([0, 0, 0]));
    const node = loaded.objects.get('obj_0001')!;

    const updated = loaded.syncTransforms(sceneWith([5, 1, -3], 90));

    expect(updated).toBe(1);
    // Same node object: this is the whole point — a gizmo attached to it stays attached.
    expect(loaded.objects.get('obj_0001')).toBe(node);
    expect(node.position.toArray()).toEqual([5, 1, -3]);
    expect(node.rotation.y).toBeCloseTo(Math.PI / 2, 10);

    loaded.dispose();
  });

  it('writes the document scale straight through', () => {
    const loaded = makeLoader().load(sceneWith([0, 0, 0]));
    loaded.syncTransforms(sceneWith([0, 0, 0], 0, 3));

    const node = loaded.objects.get('obj_0001')!;
    expect(node.scale.toArray()).toEqual([3, 3, 3]);
    // rock_small_01's default scale of 2 still applies, from the inner node.
    node.updateWorldMatrix(true, true);
    expect(
      node.getObjectByName('obj_0001:visual')!.getWorldScale(new THREE.Vector3()).toArray(),
    ).toEqual([6, 6, 6]);

    loaded.dispose();
  });

  it('skips objects it has no node for rather than throwing', () => {
    const loaded = makeLoader().load(sceneWith([0, 0, 0]));

    const updated = loaded.syncTransforms(
      parseScene({
        sceneId: 'scene_test',
        version: 1,
        objects: [
          { id: 'obj_0001', assetId: 'rock_small_01' },
          { id: 'obj_0002', assetId: 'rock_small_01' },
        ],
      }),
    );

    expect(updated).toBe(1);
    loaded.dispose();
  });
});

describe('SceneLoader hierarchy', () => {
  it('nests a child under its parent node', () => {
    const loaded = makeLoader().load(
      makeScene([
        { id: 'building', assetId: 'tree_pine_02' },
        { id: 'lamp', assetId: 'rock_small_01', parentId: 'building' },
      ]),
    );

    expect(loaded.objects.get('lamp')!.parent).toBe(loaded.objects.get('building'));
    loaded.dispose();
  });

  it('treats a nested transform as parent-local', () => {
    const loaded = makeLoader().load(
      makeScene([
        { id: 'building', assetId: 'tree_pine_02', transform: { position: [10, 0, 0] } },
        {
          id: 'lamp',
          assetId: 'rock_small_01',
          parentId: 'building',
          transform: { position: [2, 0, 0] },
        },
      ]),
    );

    const lamp = loaded.objects.get('lamp')!;
    lamp.updateWorldMatrix(true, false);
    // Local x=2 under a parent at x=10 puts the child at world x=12.
    expect(lamp.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(12, 6);

    loaded.dispose();
  });

  it('nests correctly even when a child is declared before its parent', () => {
    const loaded = makeLoader().load(
      makeScene([
        { id: 'lamp', assetId: 'rock_small_01', parentId: 'building' },
        { id: 'building', assetId: 'tree_pine_02' },
      ]),
    );

    expect(loaded.objects.get('lamp')!.parent).toBe(loaded.objects.get('building'));
    loaded.dispose();
  });

  it('adds only roots to the host scene, so a child is disposed with its parent', () => {
    const host = new THREE.Scene();
    const loaded = makeLoader().loadInto(
      host,
      makeScene([
        { id: 'building', assetId: 'tree_pine_02' },
        { id: 'lamp', assetId: 'rock_small_01', parentId: 'building' },
      ]),
    );

    expect(host.children.filter((child) => child.userData['objectId'])).toHaveLength(1);

    loaded.dispose();
    expect(host.children).toHaveLength(0);
  });

  it('places an object at the root when its parent cannot be resolved', () => {
    // The schema rejects dangling parents, but the loader is also fed hand-written and
    // partially-migrated documents, so it degrades rather than throwing.
    const warnings: string[] = [];
    const loader = new SceneLoader({
      resolver: new ManifestAssetResolver(manifest),
      warn: (message) => warnings.push(message),
    });

    const scene = {
      ...makeScene([{ id: 'lamp', assetId: 'rock_small_01' }]),
      objects: [
        {
          id: 'lamp',
          assetId: 'rock_small_01',
          parentId: 'ghost',
          transform: {
            position: [0, 0, 0] as [number, number, number],
            rotation: [0, 0, 0] as [number, number, number],
            scale: [1, 1, 1] as [number, number, number],
          },
          metadata: {},
        },
      ],
    };

    const loaded = loader.loadInto(new THREE.Scene(), scene as never);

    expect(loaded.objects.get('lamp')!.parent).toBe(loaded.threeScene);
    expect(warnings.join(' ')).toContain('unknown parentId');

    loaded.dispose();
  });
});
