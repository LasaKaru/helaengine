import type * as THREE from 'three';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { parseAssetManifest, parseScene } from '@helaengine/schema';
import { ManifestAssetResolver } from '../assets.js';
import { SceneLoader } from '../SceneLoader.js';
import { BehaviorRuntime } from '../BehaviorRuntime.js';
import {
  BehaviorRegistry,
  InvalidBehaviorParamsError,
  UnknownBehaviorError,
} from './BehaviorRegistry.js';
import { patrolDefinition, PatrolParamsSchema } from './PatrolBehavior.js';
import type { Behavior, BehaviorDefinition, GameObject } from './Behavior.js';

const manifest = parseAssetManifest({
  version: 1,
  assets: [{ id: 'enemy_goblin_01', name: 'Goblin', category: 'enemies', bounds: [1, 2, 1] }],
});

function makeRegistry(): BehaviorRegistry {
  return new BehaviorRegistry().register(patrolDefinition);
}

function makeRuntime(
  behaviors: unknown[],
  registry = makeRegistry(),
): { runtime: BehaviorRuntime; node: THREE.Object3D } {
  const scene = parseScene({
    sceneId: 'scene_test',
    version: 1,
    objects: [{ id: 'obj_0001', assetId: 'enemy_goblin_01', behaviors }],
  });

  const loader = new SceneLoader({
    resolver: new ManifestAssetResolver(manifest),
    warn: () => {},
  });
  const loaded = loader.load(scene);

  return {
    runtime: new BehaviorRuntime({ loaded, scene, registry, warn: () => {} }),
    node: loaded.objects.get('obj_0001')!,
  };
}

describe('BehaviorRegistry', () => {
  it('creates a registered behaviour', () => {
    expect(makeRegistry().create('patrol', { speed: 3 })).toBeDefined();
  });

  it('refuses a type it does not know', () => {
    expect(() => makeRegistry().create('rm -rf', {})).toThrow(UnknownBehaviorError);
  });

  it('refuses params that fail the type schema', () => {
    expect(() => makeRegistry().create('patrol', { speed: -5 })).toThrow(
      InvalidBehaviorParamsError,
    );
    expect(() => makeRegistry().create('patrol', { mode: 'teleport' })).toThrow(
      InvalidBehaviorParamsError,
    );
  });

  it('never lets a document choose what code runs', () => {
    // The closed vocabulary is the whole safety story for export: a scene can name a type, and
    // that name only ever selects from types registered ahead of time. Anything that looks like
    // code is just an unknown string.
    const registry = makeRegistry();
    for (const hostile of ['eval', 'Function', 'constructor', '__proto__', 'toString']) {
      expect(() => registry.create(hostile, {}), hostile).toThrow(UnknownBehaviorError);
    }
  });

  it('rejects a duplicate registration rather than silently replacing one', () => {
    const registry = makeRegistry();
    expect(() => registry.register(patrolDefinition)).toThrow(/already registered/);
  });

  it('fills in defaults for the editor', () => {
    expect(makeRegistry().defaultParams('patrol')).toEqual({
      waypoints: [],
      speed: 2,
      mode: 'loop',
      faceDirection: true,
      waitSeconds: 0,
    });
  });

  it('reports a type whose params cannot be defaulted', () => {
    const definition: BehaviorDefinition = {
      type: 'needsValues',
      label: 'Needs values',
      description: 'Has a required field with no default.',
      params: z.object({ target: z.string() }),
      create: () => ({}),
    };
    const registry = new BehaviorRegistry().register(definition);

    expect(() => registry.defaultParams('needsValues')).toThrow(InvalidBehaviorParamsError);
  });

  it('lists what the editor can offer', () => {
    expect(
      makeRegistry()
        .list()
        .map((definition) => definition.type),
    ).toEqual(['patrol']);
  });
});

describe('PatrolBehavior', () => {
  const waypoints = [
    [0, 0, 0],
    [10, 0, 0],
  ];

  it('starts on its first waypoint rather than wherever the object was placed', () => {
    const { runtime, node } = makeRuntime([
      {
        type: 'patrol',
        params: {
          waypoints: [
            [5, 0, 5],
            [10, 0, 5],
          ],
        },
      },
    ]);
    node.position.set(-99, 0, -99);

    runtime.start();

    expect(node.position.toArray()).toEqual([5, 0, 5]);
  });

  it('walks towards the next waypoint at the given speed', () => {
    const { runtime, node } = makeRuntime([
      { type: 'patrol', params: { waypoints, speed: 2, faceDirection: false } },
    ]);
    runtime.start();

    // Ten frames of 0.1s rather than one of 1s: the runtime clamps a single delta to 0.1s, so a
    // one-second frame would only advance a tenth of a second's worth.
    for (let frame = 0; frame < 10; frame += 1) runtime.update(0.1);

    expect(node.position.x).toBeCloseTo(2, 5);
  });

  it('never overshoots a waypoint on a slow frame', () => {
    // Without clamping, one long frame sails past the point and the patrol widens into a zig-zag.
    const { runtime, node } = makeRuntime([
      { type: 'patrol', params: { waypoints, speed: 50, faceDirection: false } },
    ]);
    runtime.start();

    runtime.update(10);

    expect(node.position.x).toBeLessThanOrEqual(10);
  });

  it('loops back to the first waypoint', () => {
    const { runtime, node } = makeRuntime([
      { type: 'patrol', params: { waypoints, speed: 10, mode: 'loop', faceDirection: false } },
    ]);
    runtime.start();

    // Out to the far point, then keep going: loop mode heads back to the start.
    for (let step = 0; step < 40; step += 1) runtime.update(0.1);

    expect(node.position.x).toBeGreaterThanOrEqual(0);
    expect(node.position.x).toBeLessThanOrEqual(10);
  });

  it('reverses along the path in pingPong mode', () => {
    const path = [
      [0, 0, 0],
      [5, 0, 0],
      [10, 0, 0],
    ];
    const { runtime, node } = makeRuntime([
      {
        type: 'patrol',
        params: { waypoints: path, speed: 10, mode: 'pingPong', faceDirection: false },
      },
    ]);
    runtime.start();

    for (let step = 0; step < 15; step += 1) runtime.update(0.1);
    const forward = node.position.x;
    for (let step = 0; step < 15; step += 1) runtime.update(0.1);

    expect(node.position.x).not.toBe(forward);
    expect(node.position.x).toBeLessThanOrEqual(10);
  });

  it('turns to face the way it is going', () => {
    const { runtime, node } = makeRuntime([
      { type: 'patrol', params: { waypoints, speed: 2, faceDirection: true } },
    ]);
    runtime.start();

    runtime.update(0.1);

    // Travelling along +X means yaw of 90 degrees.
    expect(node.rotation.y).toBeCloseTo(Math.PI / 2, 5);
  });

  it('waits at a waypoint when asked', () => {
    const { runtime, node } = makeRuntime([
      {
        type: 'patrol',
        params: { waypoints, speed: 100, waitSeconds: 5, faceDirection: false },
      },
    ]);
    runtime.start();

    runtime.update(0.1);
    const arrived = node.position.x;
    runtime.update(0.1);

    expect(node.position.x).toBe(arrived);
  });

  it('stands still with fewer than two waypoints', () => {
    const { runtime, node } = makeRuntime([
      { type: 'patrol', params: { waypoints: [[3, 0, 3]], speed: 5 } },
    ]);
    runtime.start();
    runtime.update(1);

    expect(node.position.toArray()).toEqual([3, 0, 3]);
  });

  it('accepts a document that omits every optional param', () => {
    expect(PatrolParamsSchema.parse({})).toMatchObject({ speed: 2, mode: 'loop' });
  });
});

describe('BehaviorRuntime', () => {
  it('reports and skips a behaviour it cannot create, keeping the rest', () => {
    // One bad entry in a document must not cost the user their scene.
    const { runtime } = makeRuntime([
      { type: 'nonsense', params: {} },
      {
        type: 'patrol',
        params: {
          waypoints: [
            [0, 0, 0],
            [1, 0, 0],
          ],
        },
      },
    ]);

    expect(runtime.attachmentCount).toBe(1);
    expect(runtime.problems).toHaveLength(1);
    expect(runtime.problems[0]).toMatchObject({ objectId: 'obj_0001', behaviorType: 'nonsense' });
  });

  it('does nothing until started', () => {
    const { runtime, node } = makeRuntime([
      {
        type: 'patrol',
        params: {
          waypoints: [
            [0, 0, 0],
            [10, 0, 0],
          ],
          speed: 5,
        },
      },
    ]);

    runtime.update(1);

    expect(node.position.x).toBe(0);
  });

  it('clamps a huge frame delta, so a stalled tab cannot teleport actors', () => {
    const { runtime, node } = makeRuntime([
      {
        type: 'patrol',
        params: {
          waypoints: [
            [0, 0, 0],
            [1000, 0, 0],
          ],
          speed: 10,
          faceDirection: false,
        },
      },
    ]);
    runtime.start();

    runtime.update(60);

    // 60s at 10m/s would be 600m; the clamp keeps it to a tenth of a second's worth.
    expect(node.position.x).toBeLessThanOrEqual(1);
  });

  it('delivers events to behaviours and to listeners', () => {
    const seen: Array<[string, unknown]> = [];
    const listener: Behavior = {
      onEvent: (_object: GameObject, event: string, payload: unknown) =>
        seen.push([event, payload]),
    };
    const registry = new BehaviorRegistry().register({
      type: 'listener',
      label: 'Listener',
      description: 'Records events.',
      params: z.object({}),
      create: () => listener,
    });

    const { runtime } = makeRuntime([{ type: 'listener', params: {} }], registry);
    const external: unknown[] = [];
    runtime.on('doorOpened', (payload) => external.push(payload));
    runtime.start();

    runtime.emit('doorOpened', { id: 'door_1' });

    expect(seen).toEqual([['doorOpened', { id: 'door_1' }]]);
    expect(external).toEqual([{ id: 'door_1' }]);
  });

  it('runs onDestroy when stopped', () => {
    let destroyed = false;
    const registry = new BehaviorRegistry().register({
      type: 'tracked',
      label: 'Tracked',
      description: 'Notes its own teardown.',
      params: z.object({}),
      create: () => ({
        onDestroy: () => {
          destroyed = true;
        },
      }),
    });

    const { runtime } = makeRuntime([{ type: 'tracked', params: {} }], registry);
    runtime.start();
    runtime.stop();

    expect(destroyed).toBe(true);
  });

  it('lets a behaviour find a sibling by id', () => {
    let found: GameObject | undefined;
    const registry = new BehaviorRegistry().register({
      type: 'seeker',
      label: 'Seeker',
      description: 'Looks up a sibling.',
      params: z.object({}),
      create: () => ({
        onInit: (object) => {
          found = object.find('obj_0001');
        },
      }),
    });

    const { runtime } = makeRuntime([{ type: 'seeker', params: {} }], registry);
    runtime.start();

    expect(found?.id).toBe('obj_0001');
  });
});
