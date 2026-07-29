import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { parseAssetManifest, parseScene } from '@helaengine/schema';
import { ManifestAssetResolver } from './assets.js';
import { pickObject } from './picking.js';
import { SceneLoader, type LoadedScene } from './SceneLoader.js';

const manifest = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'tree_pine_01', name: 'Pine', category: 'trees', bounds: [2, 6, 2] },
    { id: 'rock_boulder_01', name: 'Boulder', category: 'rocks', bounds: [2, 1.4, 1.6] },
    { id: 'enemy_goblin_01', name: 'Goblin', category: 'enemies', bounds: [1, 2, 1] },
  ],
});

function loader(instanceThreshold = 8): SceneLoader {
  return new SceneLoader({
    resolver: new ManifestAssetResolver(manifest),
    warn: () => {},
    instanceThreshold,
  });
}

/**
 * Document input, before the schema fills in its defaults.
 *
 * Deliberately looser than `SceneObject`: these are objects as they appear in a saved file, where
 * every defaulted field may simply be absent, and typing them as the parsed shape would mean
 * writing out defaults the parser exists to supply.
 */
type ObjectInput = Record<string, unknown>;

function scatter(count: number, assetId = 'tree_pine_01', from = 0): ObjectInput[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `obj_${String(from + index + 1).padStart(4, '0')}`,
    assetId,
    transform: { position: [index * 3, 0, 0] as [number, number, number] },
  }));
}

function load(objects: ObjectInput[], threshold = 8): LoadedScene {
  const scene = parseScene({ sceneId: 'scene_test', version: 1, objects });
  return loader(threshold).load(scene);
}

/** Every mesh the renderer would actually issue a draw call for. */
function drawnMeshes(loaded: LoadedScene): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  loaded.threeScene.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) meshes.push(mesh);
  });
  return meshes;
}

describe('instancing', () => {
  it('batches a forest into one draw call instead of one per tree', () => {
    const loaded = load(scatter(200));

    expect(loaded.instances?.drawCalls).toBe(1);
    // The terrain, and nothing else: every tree is inside the batch.
    expect(
      drawnMeshes(loaded).filter((mesh) => !(mesh as THREE.InstancedMesh).isInstancedMesh),
    ).toHaveLength(1);
  });

  it('leaves a handful of objects as ordinary meshes', () => {
    const loaded = load(scatter(4));

    expect(loaded.instances).toBeNull();
    expect(drawnMeshes(loaded)).toHaveLength(5);
  });

  it('keeps a node for every object, batched or not, so the editor still works', () => {
    const loaded = load(scatter(20));

    expect(loaded.objects.size).toBe(20);
    for (const node of loaded.objects.values()) {
      expect(node.userData['objectId']).toBeDefined();
    }
  });

  it('refuses to batch anything that gameplay touches individually', () => {
    const objects: ObjectInput[] = [
      ...scatter(10),
      // Ten more pines, but each disqualified for a different reason.
      { id: 'moves', assetId: 'tree_pine_01', behaviors: [{ type: 'patrol', params: {} }] },
      { id: 'dynamic', assetId: 'tree_pine_01', physics: { body: 'dynamic', collider: 'auto' } },
      { id: 'watches', assetId: 'tree_pine_01', trigger: { shape: 'box' } },
      { id: 'parent', assetId: 'tree_pine_01' },
      { id: 'child', assetId: 'tree_pine_01', parentId: 'parent' },
    ];

    const loaded = load(objects);
    const batched = new Set(loaded.instances?.instancedObjectIds ?? []);

    expect(batched.size).toBe(10);
    for (const id of ['moves', 'dynamic', 'watches', 'parent', 'child']) {
      expect(batched.has(id), id).toBe(false);
    }
  });

  it('batches each asset separately', () => {
    const loaded = load([...scatter(10), ...scatter(10, 'rock_boulder_01', 100)]);

    expect(loaded.instances?.batchCount).toBe(2);
    expect(loaded.instances?.instancedObjectIds).toHaveLength(20);
  });

  it('can be turned off entirely', () => {
    const loaded = load(scatter(50), 0);
    expect(loaded.instances).toBeNull();
  });

  it('moves an instance when the document moves the object', () => {
    const objects = scatter(20);
    const scene = parseScene({ sceneId: 'scene_test', version: 1, objects });
    const loaded = loader().load(scene);

    const moved = {
      ...scene,
      objects: scene.objects.map((object) =>
        object.id === 'obj_0001'
          ? { ...object, transform: { ...object.transform, position: [50, 7, -50] as const } }
          : object,
      ),
    };
    loaded.syncTransforms(moved as typeof scene);

    // Read the matrix straight back out of the instance buffer: the node moving is not the claim,
    // the buffer moving is.
    const batch = loaded.threeScene.getObjectByName(
      'instances:tree_pine_01',
    ) as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    batch.getMatrixAt(0, matrix);

    expect(new THREE.Vector3().setFromMatrixPosition(matrix).toArray()).toEqual([50, 7, -50]);
  });

  it('picks the object behind an instanced hit', () => {
    const loaded = load(scatter(20));
    const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 3, 40), new THREE.Vector3(0, 0, -1));

    expect(pickObject(raycaster, loaded)).toBe('obj_0001');
  });

  it('hides an instance when its object is released', () => {
    const loaded = load(scatter(20));
    loaded.release('obj_0001');

    const batch = loaded.threeScene.getObjectByName(
      'instances:tree_pine_01',
    ) as THREE.InstancedMesh;
    const matrix = new THREE.Matrix4();
    batch.getMatrixAt(0, matrix);
    const scale = new THREE.Vector3().setFromMatrixScale(matrix);

    expect(scale.length()).toBe(0);
    expect(loaded.instances?.has('obj_0001')).toBe(false);
  });

  it('frames its content on the batch, not on an empty box', () => {
    // `getContentBounds` walks `objects`, and a batched object's node is detached — if that node
    // carried no geometry the camera would frame nothing at all.
    const loaded = load(scatter(20));
    const bounds = loaded.getContentBounds();

    expect(bounds.isEmpty()).toBe(false);
    expect(bounds.max.x).toBeGreaterThan(50);
  });
});

describe('node pooling', () => {
  it('reuses a node instead of building a second one', () => {
    const sceneLoader = loader();
    const scene = parseScene({ sceneId: 'scene_test', version: 1, objects: [] });
    const loaded = sceneLoader.load(scene);

    const first = sceneLoader.instantiateInto(
      loaded,
      parseScene({
        sceneId: 's',
        version: 1,
        objects: [{ id: 'spawn_1', assetId: 'enemy_goblin_01' }],
      }).objects[0]!,
    );

    sceneLoader.recycle(loaded, 'spawn_1');
    expect(sceneLoader.pooledCount('enemy_goblin_01')).toBe(1);

    const second = sceneLoader.instantiateInto(
      loaded,
      parseScene({
        sceneId: 's',
        version: 1,
        objects: [
          { id: 'spawn_2', assetId: 'enemy_goblin_01', transform: { position: [5, 0, 5] } },
        ],
      }).objects[0]!,
    );

    expect(second).toBe(first);
    expect(second.userData['objectId']).toBe('spawn_2');
    expect(second.position.toArray()).toEqual([5, 0, 5]);
    expect(second.visible).toBe(true);
    expect(sceneLoader.pooledCount('enemy_goblin_01')).toBe(0);
  });

  it('caps the pool so recycling can never become a leak', () => {
    const sceneLoader = loader();
    const scene = parseScene({ sceneId: 'scene_test', version: 1, objects: [] });
    const loaded = sceneLoader.load(scene);

    // A hundred live at once, then all released — a wave dying together is exactly the case a
    // cap has to survive. Spawning and recycling one at a time would only ever reuse one node.
    for (let index = 0; index < 100; index += 1) {
      const object = parseScene({
        sceneId: 's',
        version: 1,
        objects: [{ id: `spawn_${index}`, assetId: 'enemy_goblin_01' }],
      }).objects[0]!;
      sceneLoader.instantiateInto(loaded, object);
    }
    for (let index = 0; index < 100; index += 1) sceneLoader.recycle(loaded, `spawn_${index}`);

    expect(sceneLoader.pooledCount('enemy_goblin_01')).toBe(64);
  });

  it('keeps pools separate per asset', () => {
    const sceneLoader = loader();
    const loaded = sceneLoader.load(parseScene({ sceneId: 'scene_test', version: 1, objects: [] }));

    for (const assetId of ['enemy_goblin_01', 'rock_boulder_01']) {
      const object = parseScene({
        sceneId: 's',
        version: 1,
        objects: [{ id: `spawn_${assetId}`, assetId }],
      }).objects[0]!;
      sceneLoader.instantiateInto(loaded, object);
      sceneLoader.recycle(loaded, `spawn_${assetId}`);
    }

    expect(sceneLoader.pooledCount('enemy_goblin_01')).toBe(1);
    expect(sceneLoader.pooledCount('rock_boulder_01')).toBe(1);
    expect(sceneLoader.pooledCount()).toBe(2);
  });
});

describe('frustum culling', () => {
  it('leaves every drawn mesh with the bounds the renderer needs to cull it', () => {
    // Three culls per-object against `geometry.boundingSphere`. A mesh without one is drawn every
    // frame regardless of where the camera is looking, so this is the check that culling can work
    // at all — nested groups do not defeat it, missing bounds do.
    const loaded = load([...scatter(20), ...scatter(3, 'enemy_goblin_01', 500)]);

    for (const mesh of drawnMeshes(loaded)) {
      expect(mesh.frustumCulled, mesh.name).toBe(true);
      mesh.geometry.computeBoundingSphere();
      expect(mesh.geometry.boundingSphere, mesh.name).not.toBeNull();
    }
  });

  it('culls an object the camera is facing away from', () => {
    const loaded = load(scatter(3, 'enemy_goblin_01'));
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 500);
    camera.position.set(0, 2, -60);
    camera.lookAt(0, 2, -200);
    camera.updateMatrixWorld(true);

    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );

    const behind = loaded.objects.get('obj_0001')!;
    behind.updateMatrixWorld(true);
    expect(frustum.intersectsObject(behind.children[0] as THREE.Mesh)).toBe(false);

    camera.lookAt(0, 2, 200);
    camera.updateMatrixWorld(true);
    const ahead = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    expect(ahead.intersectsObject(behind.children[0] as THREE.Mesh)).toBe(true);
  });
});
