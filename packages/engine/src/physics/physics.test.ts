import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { PlayerSchema, parseAssetManifest, parseScene } from '@helaengine/schema';
import { ManifestAssetResolver } from '../assets.js';
import { SceneLoader } from '../SceneLoader.js';
import { TerrainField } from '../TerrainField.js';
import { buildScenePhysics, resolveColliderType } from './buildScenePhysics.js';
import { collectTrimesh } from './colliders.js';
import { PhysicsWorld } from './PhysicsWorld.js';
import { initPhysics, isPhysicsReady, type RapierModule } from './rapier.js';
import type { MoveInput } from './PlayerController.js';

const manifest = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'building_hut_01', name: 'Hut', category: 'buildings', bounds: [4, 3, 4] },
    {
      id: 'tree_pine_01',
      name: 'Pine',
      category: 'trees',
      bounds: [2, 6, 2],
      colliderType: 'capsule',
    },
    {
      id: 'grass_tuft_01',
      name: 'Grass',
      category: 'props',
      bounds: [1, 1, 1],
      colliderType: 'none',
    },
  ],
});

const player = PlayerSchema.parse({});

let rapier: RapierModule;

beforeAll(async () => {
  rapier = await initPhysics();
}, 30_000);

function makeWorld(options = {}): PhysicsWorld {
  return new PhysicsWorld(rapier, options);
}

/** World height of whatever the physics world has at this X/Z, or null for a miss. */
function probeHeight(world: PhysicsWorld, x: number, z: number, from = 200): number | null {
  const hit = world.world.castRay(
    new world.rapier.Ray({ x, y: from, z }, { x: 0, y: -1, z: 0 }),
    from * 2,
    true,
  );
  return hit ? from - hit.timeOfImpact : null;
}

function hillyField(): TerrainField {
  const field = new TerrainField({ segments: 32, size: [64, 64], maxHeight: 20 });
  // Deliberately off-centre and asymmetric in x and z: a transposed heightfield still lines up
  // against a symmetric hill, which is exactly how an index-order bug survives a test suite.
  field.sculpt(-12, 18, 'raise', { radius: 14, strength: 0.6 });
  return field;
}

describe('initPhysics', () => {
  it('resolves to the same module every time', async () => {
    expect(isPhysicsReady()).toBe(true);
    expect(await initPhysics()).toBe(rapier);
  });
});

describe('terrain collider', () => {
  it('matches the field the editor sculpted, including which way round it is', () => {
    const world = makeWorld();
    const field = hillyField();
    world.addTerrain(field);
    world.step(1 / 60);

    for (const [x, z] of [
      [-12, 18],
      [12, -18],
      [-12, -18],
      [0, 0],
      [20, 20],
    ] as const) {
      const physics = probeHeight(world, x, z);
      expect(physics, `${x},${z}`).not.toBeNull();
      expect(physics!, `${x},${z}`).toBeCloseTo(field.sampleHeight(x, z), 1);
    }

    world.dispose();
  });

  it('replaces the previous terrain rather than stacking a second one', () => {
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [32, 32], maxHeight: 10 }));
    expect(world.hasTerrain).toBe(true);

    const raised = new TerrainField({ segments: 8, size: [32, 32], maxHeight: 10 });
    raised.heights.fill(0.5);
    world.addTerrain(raised);
    world.step(1 / 60);

    expect(probeHeight(world, 0, 0)).toBeCloseTo(5, 1);
    world.dispose();
  });
});

describe('object bodies', () => {
  function nodeAt(x: number, y: number, z: number): THREE.Object3D {
    const node = new THREE.Group();
    node.position.set(x, y, z);
    return node;
  }

  it('sits a box collider on top of the ground, not half buried in it', () => {
    const world = makeWorld();
    world.addObject({
      objectId: 'obj_0001',
      node: nodeAt(0, 0, 0),
      shape: 'box',
      body: 'static',
      size: [4, 3, 4],
    });
    world.step(1 / 60);

    // A 3m box whose pivot is at its base has its top at y=3 and its bottom at y=0.
    expect(probeHeight(world, 0, 0)).toBeCloseTo(3, 2);
    world.dispose();
  });

  it('reports an object that ends up with no collider', () => {
    const world = makeWorld();
    expect(
      world.addObject({
        objectId: 'obj_0001',
        node: nodeAt(0, 0, 0),
        shape: 'none',
        body: 'static',
        size: [1, 1, 1],
      }),
    ).toBe(false);
    expect(world.bodyCount).toBe(0);
    world.dispose();
  });

  it('drops a dynamic body onto the terrain and writes the result back to the node', () => {
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [32, 32], maxHeight: 10 }));

    const node = nodeAt(0, 8, 0);
    world.addObject({
      objectId: 'obj_0001',
      node,
      shape: 'box',
      body: 'dynamic',
      size: [1, 1, 1],
    });

    for (let frame = 0; frame < 180; frame += 1) world.step(1 / 60);

    expect(node.position.y).toBeLessThan(1);
    expect(node.position.y).toBeGreaterThan(-0.1);
    world.dispose();
  });

  it("leaves a static body's node exactly where the document put it", () => {
    const world = makeWorld();
    const node = nodeAt(3, 5, -2);
    world.addObject({
      objectId: 'obj_0001',
      node,
      shape: 'box',
      body: 'static',
      size: [1, 1, 1],
    });

    for (let frame = 0; frame < 60; frame += 1) world.step(1 / 60);

    expect(node.position.toArray()).toEqual([3, 5, -2]);
    world.dispose();
  });

  it("converts a parented body back into its parent's space", () => {
    // Physics works in world space and a scene graph does not. Without the conversion, a crate
    // parented to a building teleports by the building's offset the moment it starts falling.
    const world = makeWorld();
    const parent = nodeAt(20, 0, 0);
    const child = nodeAt(0, 6, 0);
    parent.add(child);
    parent.updateWorldMatrix(true, true);

    world.addObject({
      objectId: 'crate',
      node: child,
      shape: 'box',
      body: 'dynamic',
      size: [1, 1, 1],
    });
    world.addObject({
      objectId: 'ground',
      node: nodeAt(20, 0, 0),
      shape: 'box',
      body: 'static',
      size: [10, 1, 10],
    });

    for (let frame = 0; frame < 180; frame += 1) world.step(1 / 60);

    // Local y falls towards the 1m-tall ground slab; local x stays at zero because the parent
    // already carries the offset.
    expect(child.position.x).toBeCloseTo(0, 1);
    expect(child.position.y).toBeCloseTo(1, 1);
    expect(child.getWorldPosition(new THREE.Vector3()).x).toBeCloseTo(20, 1);
    world.dispose();
  });

  it('removes a body without disturbing the rest', () => {
    const world = makeWorld();
    world.addObject({
      objectId: 'a',
      node: nodeAt(0, 0, 0),
      shape: 'box',
      body: 'static',
      size: [1, 1, 1],
    });
    world.addObject({
      objectId: 'b',
      node: nodeAt(5, 0, 0),
      shape: 'box',
      body: 'dynamic',
      size: [1, 1, 1],
    });
    expect(world.bodyCount).toBe(2);
    expect(world.dynamicCount).toBe(1);

    world.removeObject('b');

    expect(world.bodyCount).toBe(1);
    expect(world.dynamicCount).toBe(0);
    expect(world.bodyFor('a')).toBeDefined();
    world.dispose();
  });
});

describe('trimesh colliders', () => {
  it('bakes scale into the vertices, because a collider has none of its own', () => {
    const node = new THREE.Group();
    node.scale.set(2, 2, 2);
    node.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)));
    node.updateWorldMatrix(true, true);

    const data = collectTrimesh(node)!;
    let maxX = 0;
    for (let index = 0; index < data.vertices.length; index += 3) {
      maxX = Math.max(maxX, Math.abs(data.vertices[index]!));
    }

    expect(maxX).toBeCloseTo(1, 5);
  });

  it('returns nothing for a node with no geometry, rather than an empty shape', () => {
    expect(collectTrimesh(new THREE.Group())).toBeNull();
  });
});

describe('buildScenePhysics', () => {
  function load(objects: unknown[]) {
    const scene = parseScene({ sceneId: 'scene_test', version: 1, objects });
    const loader = new SceneLoader({
      resolver: new ManifestAssetResolver(manifest),
      warn: () => {},
    });
    return { scene, loaded: loader.load(scene) };
  }

  it('gives every collidable object a body and skips the ones marked none', () => {
    const { scene, loaded } = load([
      { id: 'obj_0001', assetId: 'building_hut_01' },
      { id: 'obj_0002', assetId: 'tree_pine_01', transform: { position: [8, 0, 0] } },
      { id: 'obj_0003', assetId: 'grass_tuft_01', transform: { position: [-8, 0, 0] } },
    ]);

    const world = makeWorld();
    const report = buildScenePhysics({
      world,
      scene,
      loaded,
      resolver: new ManifestAssetResolver(manifest),
    });

    expect(report.bodies).toBe(2);
    expect(report.skipped).toEqual([]);
    expect(report.terrain).toBe(true);
    world.dispose();
  });

  it('scales a collider with the instance, not just with the asset', () => {
    const { scene, loaded } = load([
      { id: 'obj_0001', assetId: 'building_hut_01', transform: { scale: [1, 2, 1] } },
    ]);

    const world = makeWorld();
    buildScenePhysics({ world, scene, loaded, resolver: new ManifestAssetResolver(manifest) });
    world.step(1 / 60);

    // A 3m hut scaled 2× vertically stands 6m tall.
    expect(probeHeight(world, 0, 0)).toBeCloseTo(6, 1);
    world.dispose();
  });

  it('lets an instance override the manifest collider', () => {
    const object = { physics: { collider: 'mesh' as const, body: 'static' as const } };
    expect(resolveColliderType({ ...object } as never, 'box')).toBe('mesh');
    expect(resolveColliderType({ physics: { collider: 'auto' } } as never, 'capsule')).toBe(
      'capsule',
    );
  });
});

describe('PlayerController', () => {
  function walk(
    world: PhysicsWorld,
    controller: ReturnType<PhysicsWorld['createPlayer']>,
    seconds: number,
    input: MoveInput = { forward: 0, right: 0, jump: false, yaw: 0 },
  ) {
    const frames = Math.round(seconds * 60);
    for (let frame = 0; frame < frames; frame += 1) {
      world.step(1 / 60, (step) => controller.move(input, step));
    }
  }

  it('lands on the terrain instead of falling through it', () => {
    const world = makeWorld();
    const field = hillyField();
    world.addTerrain(field);

    const controller = world.createPlayer(player, new THREE.Vector3(-12, 30, 18));
    walk(world, controller, 4);

    expect(controller.grounded).toBe(true);
    expect(controller.position.y).toBeCloseTo(field.sampleHeight(-12, 18), 0);
    world.dispose();
  });

  it('walks in the direction it is facing', () => {
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [64, 64], maxHeight: 10 }));
    const controller = world.createPlayer(player, new THREE.Vector3(0, 1, 0));

    walk(world, controller, 1, { forward: 1, right: 0, jump: false, yaw: 0 });

    // Yaw 0 faces -Z, the direction an unrotated camera looks, and a second at the default
    // 6 m/s covers most of six metres.
    expect(controller.position.z).toBeLessThan(-4);
    expect(Math.abs(controller.position.x)).toBeLessThan(0.5);
    world.dispose();
  });

  it('is stopped by a wall rather than walking through it', () => {
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [64, 64], maxHeight: 10 }));

    const wall = new THREE.Group();
    wall.position.set(0, 0, -4);
    world.addObject({
      objectId: 'wall',
      node: wall,
      shape: 'box',
      body: 'static',
      size: [20, 4, 1],
    });

    const controller = world.createPlayer(player, new THREE.Vector3(0, 1, 0));
    walk(world, controller, 3, { forward: 1, right: 0, jump: false, yaw: 0 });

    // The wall's near face is at z=-3.5; the player's capsule radius keeps them short of it.
    expect(controller.position.z).toBeGreaterThan(-3.5);
    world.dispose();
  });

  it('steps over a low ledge but not a high one', () => {
    const buildStep = (height: number): number => {
      const world = makeWorld();
      world.addTerrain(new TerrainField({ segments: 8, size: [64, 64], maxHeight: 10 }));
      const ledge = new THREE.Group();
      ledge.position.set(0, 0, -3);
      world.addObject({
        objectId: 'ledge',
        node: ledge,
        shape: 'box',
        body: 'static',
        size: [20, height, 4],
      });
      const controller = world.createPlayer(player, new THREE.Vector3(0, 0.5, 0));
      walk(world, controller, 3, { forward: 1, right: 0, jump: false, yaw: 0 });
      const reached = -controller.position.z;
      world.dispose();
      return reached;
    };

    expect(buildStep(0.25)).toBeGreaterThan(3);
    expect(buildStep(2)).toBeLessThan(2);
  });

  it('jumps and comes back down', () => {
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [64, 64], maxHeight: 10 }));
    const controller = world.createPlayer(player, new THREE.Vector3(0, 0.2, 0));

    walk(world, controller, 1);
    const standing = controller.position.y;

    world.step(1 / 60, (step) =>
      controller.move({ forward: 0, right: 0, jump: true, yaw: 0 }, step),
    );
    walk(world, controller, 0.25);
    const midair = controller.position.y;

    walk(world, controller, 3);

    expect(midair).toBeGreaterThan(standing + 0.3);
    expect(controller.position.y).toBeCloseTo(standing, 1);
    expect(controller.grounded).toBe(true);
    world.dispose();
  });

  it('sprints faster than it walks, and crouches slower', () => {
    const distances: Record<string, number> = {};

    for (const [name, input] of [
      ['walk', { forward: 1, right: 0, jump: false, yaw: 0 }],
      ['sprint', { forward: 1, right: 0, jump: false, yaw: 0, sprint: true }],
      ['crouch', { forward: 1, right: 0, jump: false, yaw: 0, crouch: true }],
    ] as const) {
      const world = makeWorld();
      world.addTerrain(new TerrainField({ segments: 8, size: [128, 128], maxHeight: 10 }));
      const controller = world.createPlayer(player, new THREE.Vector3(0, 1, 0));
      walk(world, controller, 1, input);
      distances[name] = Math.abs(controller.position.z);
      world.dispose();
    }

    expect(distances['sprint']!).toBeGreaterThan(distances['walk']! * 1.4);
    expect(distances['crouch']!).toBeLessThan(distances['walk']! * 0.7);
  });

  it('holds a sprinting crouch to crouch speed — sneaking beats an exploit', () => {
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [128, 128], maxHeight: 10 }));
    const controller = world.createPlayer(player, new THREE.Vector3(0, 1, 0));

    walk(world, controller, 1, {
      forward: 1,
      right: 0,
      jump: false,
      yaw: 0,
      sprint: true,
      crouch: true,
    });

    expect(Math.abs(controller.position.z)).toBeLessThan(4);
    world.dispose();
  });

  it('lowers the eye height while crouched and restores it after', () => {
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [128, 128], maxHeight: 10 }));
    const controller = world.createPlayer(player, new THREE.Vector3(0, 1, 0));
    const standing = controller.eyeHeight;

    walk(world, controller, 0.5, { forward: 0, right: 0, jump: false, yaw: 0, crouch: true });
    expect(controller.crouched).toBe(true);
    expect(controller.eyeHeight).toBeLessThan(standing);

    walk(world, controller, 0.5, { forward: 0, right: 0, jump: false, yaw: 0 });
    expect(controller.crouched).toBe(false);
    expect(controller.eyeHeight).toBeCloseTo(standing, 5);
    world.dispose();
  });

  it('refuses to stand up under a low ceiling', () => {
    // Standing into solid geometry would eject the player through it, which is the classic
    // crouch bug. The controller simply stays crouched instead.
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [128, 128], maxHeight: 10 }));

    const ceiling = new THREE.Group();
    ceiling.position.set(0, 1.2, 0);
    world.addObject({
      objectId: 'ceiling',
      node: ceiling,
      shape: 'box',
      body: 'static',
      size: [8, 0.4, 8],
    });

    const controller = world.createPlayer(player, new THREE.Vector3(0, 0, 0));
    walk(world, controller, 0.5, { forward: 0, right: 0, jump: false, yaw: 0, crouch: true });
    expect(controller.crouched).toBe(true);

    walk(world, controller, 0.5, { forward: 0, right: 0, jump: false, yaw: 0 });

    expect(controller.crouched).toBe(true);
    world.dispose();
  });

  it('reports the speed it actually achieved, not the speed it asked for', () => {
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [128, 128], maxHeight: 10 }));
    const controller = world.createPlayer(player, new THREE.Vector3(0, 1, 0));

    walk(world, controller, 0.5, { forward: 1, right: 0, jump: false, yaw: 0 });
    expect(controller.speed).toBeGreaterThan(3);

    walk(world, controller, 0.5, { forward: 0, right: 0, jump: false, yaw: 0 });
    expect(controller.speed).toBeLessThan(0.5);
    world.dispose();
  });

  it('teleports without carrying a fall across', () => {
    const world = makeWorld();
    world.addTerrain(new TerrainField({ segments: 8, size: [64, 64], maxHeight: 10 }));
    const controller = world.createPlayer(player, new THREE.Vector3(0, 20, 0));
    walk(world, controller, 1);
    expect(controller.verticalVelocity).toBeLessThan(-1);

    controller.teleport(new THREE.Vector3(10, 1, 10));

    expect(controller.verticalVelocity).toBe(0);
    expect(controller.position.x).toBeCloseTo(10, 5);
    world.dispose();
  });
});

describe('fixed timestep', () => {
  it('never runs more than the substep ceiling in one frame', () => {
    const world = makeWorld({ fixedTimestep: 1 / 60, maxSubsteps: 5 });
    expect(world.step(10)).toBe(5);
    world.dispose();
  });

  it('accumulates short frames rather than dropping them', () => {
    const world = makeWorld({ fixedTimestep: 1 / 60, maxSubsteps: 5 });
    expect(world.step(1 / 240)).toBe(0);
    expect(world.step(1 / 240)).toBe(0);
    expect(world.step(1 / 240)).toBe(0);
    expect(world.step(1 / 240)).toBe(1);
    world.dispose();
  });
});
