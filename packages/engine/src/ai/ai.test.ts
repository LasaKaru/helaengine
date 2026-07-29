import * as THREE from 'three';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAssetManifest, parseScene, type SceneObject } from '@helaengine/schema';
import { ManifestAssetResolver } from '../assets.js';
import { BehaviorRuntime } from '../BehaviorRuntime.js';
import { BehaviorRegistry } from '../behaviors/BehaviorRegistry.js';
import { patrolDefinition } from '../behaviors/PatrolBehavior.js';
import { GameRuntime } from '../GameRuntime.js';
import { SceneLoader } from '../SceneLoader.js';
import { INERT_WORLD, type WorldHandle } from '../world.js';
import { ChaseOnSightBehavior, chaseOnSightDefinition } from './ChaseOnSightBehavior.js';
import { StateMachine } from './StateMachine.js';
import { SteeringAgent } from './SteeringAgent.js';

const manifest = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'enemy_goblin_01', name: 'Goblin', category: 'enemies', bounds: [1, 2, 1] },
    { id: 'building_hut_01', name: 'Hut', category: 'buildings', bounds: [4, 3, 4] },
  ],
});

function registry(): BehaviorRegistry {
  return new BehaviorRegistry().register(patrolDefinition).register(chaseOnSightDefinition);
}

/**
 * The parts of the world a test cares about.
 *
 * Returned as a partial on purpose: the harness layers it over an inert world *and* over a working
 * `moveTo`, so a test that only wants to say where the player is does not have to re-supply the
 * plumbing that makes movement visible.
 */
function fakeWorld(overrides: Partial<WorldHandle> = {}): Partial<WorldHandle> {
  return overrides;
}

interface Harness {
  runtime: BehaviorRuntime;
  node: THREE.Object3D;
  enemy: ChaseOnSightBehavior;
}

function harness(objects: Partial<SceneObject>[], world: Partial<WorldHandle>): Harness {
  const scene = parseScene({
    sceneId: 'scene_test',
    version: 1,
    objects: objects.map((object, index) => ({
      id: `obj_${String(index + 1).padStart(4, '0')}`,
      assetId: 'enemy_goblin_01',
      ...object,
    })),
  });

  const loader = new SceneLoader({ resolver: new ManifestAssetResolver(manifest), warn: () => {} });
  const loaded = loader.load(scene);
  const runtime = new BehaviorRuntime({
    loaded,
    scene,
    registry: registry(),
    // `moveTo` is the one world method these tests must really implement: steering asks the world
    // to move its body, and a world that ignores it makes every chase look like a failure to see.
    world: {
      ...INERT_WORLD,
      // `moveTo` is the one world method these tests must really implement: steering asks the
      // world to move its body, and a world that ignores it makes every chase look like a failure
      // to see.
      moveTo: (objectId, position) => {
        loaded.objects.get(objectId)?.position.copy(position);
      },
      ...world,
    },
    warn: () => {},
  });

  return {
    runtime,
    node: loaded.objects.get('obj_0001')!,
    enemy: runtime
      .behaviorsFor('obj_0001')
      .find((behavior) => behavior instanceof ChaseOnSightBehavior) as ChaseOnSightBehavior,
  };
}

/** Advances the runtime in 1/60s steps, which is what the sight throttle is tuned against. */
function run(runtime: BehaviorRuntime, seconds: number): void {
  for (let frame = 0; frame < Math.round(seconds * 60); frame += 1) runtime.update(1 / 60);
}

describe('StateMachine', () => {
  it('runs enter, update and exit in order', () => {
    const log: string[] = [];
    const machine = new StateMachine({})
      .add('a', {
        onEnter: () => log.push('enter a'),
        onUpdate: () => {
          log.push('update a');
          return 'b';
        },
        onExit: () => log.push('exit a'),
      })
      .add('b', { onEnter: () => log.push('enter b') });

    machine.changeTo('a');
    machine.update(0.1);

    expect(log).toEqual(['enter a', 'update a', 'exit a', 'enter b']);
  });

  it('follows a chain of transitions within one update', () => {
    const machine = new StateMachine({})
      .add('a', { onUpdate: () => 'b' })
      .add('b', { onUpdate: () => 'c' })
      .add('c', {});

    machine.changeTo('a');
    machine.update(0.1);

    expect(machine.current).toBe('c');
  });

  it('will not hang on two states that point at each other', () => {
    const machine = new StateMachine({})
      .add('ping', { onUpdate: () => 'pong' })
      .add('pong', { onUpdate: () => 'ping' });

    machine.changeTo('ping');
    machine.update(0.1);

    // The point is that it returns at all; which of the two it lands on does not matter.
    expect(['ping', 'pong']).toContain(machine.current);
  });

  it('refuses a duplicate id and an unknown transition', () => {
    const machine = new StateMachine({}).add('a', {});
    expect(() => machine.add('a', {})).toThrow(/already registered/);
    expect(() => machine.changeTo('nowhere')).toThrow(/unknown state/);
  });
});

describe('SteeringAgent', () => {
  it('moves towards its target and stops short of overshooting it', () => {
    const agent = new SteeringAgent({ maxSpeed: 4 });
    agent.reset(new THREE.Vector3(0, 0, 0));
    agent.setMode('seek');
    agent.setTarget(new THREE.Vector3(10, 0, 0));

    let position = new THREE.Vector3(0, 0, 0);
    for (let frame = 0; frame < 120; frame += 1) position = agent.step(position, 1 / 60).clone();

    expect(position.x).toBeGreaterThan(4);
    expect(position.x).toBeLessThanOrEqual(10.5);
  });

  it('stands still in "none" mode', () => {
    const agent = new SteeringAgent({ maxSpeed: 4 });
    agent.setMode('none');
    const position = agent.step(new THREE.Vector3(3, 0, 3), 1 / 60);
    expect(position.toArray()).toEqual([3, 0, 3]);
  });

  it('respects its speed limit', () => {
    const agent = new SteeringAgent({ maxSpeed: 2 });
    agent.reset(new THREE.Vector3());
    agent.setMode('seek');
    agent.setTarget(new THREE.Vector3(1000, 0, 0));

    for (let frame = 0; frame < 60; frame += 1) agent.step(new THREE.Vector3(0, 0, 0), 1 / 60);

    expect(agent.speed).toBeLessThanOrEqual(2.001);
  });
});

describe('movement claims', () => {
  it('lets a chase take the object off its patrol route', () => {
    const player = new THREE.Vector3(4, 0, 0);
    const world = fakeWorld({ playerPosition: () => player });

    const { runtime, node } = harness(
      [
        {
          behaviors: [
            {
              type: 'patrol',
              params: {
                waypoints: [
                  [0, 0, 0],
                  [0, 0, 40],
                ],
                speed: 4,
                faceDirection: false,
              },
            },
            { type: 'chaseOnSight', params: { fieldOfView: 360, chaseSpeed: 4 } },
          ],
        },
      ],
      world,
    );
    runtime.start();
    run(runtime, 2);

    // Patrol would have marched it up +Z; the chase pulls it towards the player on +X instead.
    expect(node.position.x).toBeGreaterThan(1);
    expect(node.position.z).toBeLessThan(4);
  });

  it('hands the object back to patrol once the player is gone', () => {
    let player: THREE.Vector3 | null = new THREE.Vector3(4, 0, 0);
    const { runtime, node, enemy } = harness(
      [
        {
          behaviors: [
            {
              type: 'patrol',
              params: {
                waypoints: [
                  [0, 0, 0],
                  [0, 0, 40],
                ],
                speed: 4,
                faceDirection: false,
              },
            },
            { type: 'chaseOnSight', params: { fieldOfView: 360, loseInterestAfter: 0.5 } },
          ],
        },
      ],
      fakeWorld({ playerPosition: () => player }),
    );

    runtime.start();
    run(runtime, 1);
    expect(enemy.state).toBe('chase');

    player = null;
    run(runtime, 1);
    expect(enemy.state).toBe('patrol');

    const before = node.position.z;
    run(runtime, 1);
    expect(node.position.z).toBeGreaterThan(before);
  });

  it('a behaviour that never claims cannot move anything', () => {
    // Patrol alone still moves: it claims at the lowest priority and nothing outranks it.
    const { runtime, node } = harness(
      [
        {
          behaviors: [
            {
              type: 'patrol',
              params: {
                waypoints: [
                  [0, 0, 0],
                  [0, 0, 20],
                ],
                speed: 5,
                faceDirection: false,
              },
            },
          ],
        },
      ],
      fakeWorld(),
    );
    runtime.start();
    run(runtime, 1);

    expect(node.position.z).toBeGreaterThan(3);
  });
});

describe('ChaseOnSightBehavior', () => {
  it('stays on patrol while the player is out of range', () => {
    const { runtime, enemy } = harness(
      [
        {
          behaviors: [{ type: 'chaseOnSight', params: { sightRange: 5, fieldOfView: 360 } }],
        },
      ],
      fakeWorld({ playerPosition: () => new THREE.Vector3(50, 0, 0) }),
    );
    runtime.start();
    run(runtime, 1);

    expect(enemy.state).toBe('patrol');
  });

  it('does not see the player standing behind it', () => {
    const { runtime, node, enemy } = harness(
      [{ behaviors: [{ type: 'chaseOnSight', params: { fieldOfView: 90 } }] }],
      fakeWorld({ playerPosition: () => new THREE.Vector3(0, 0, -6) }),
    );
    // Facing +Z; the player is at -Z, squarely behind.
    node.rotation.y = 0;
    runtime.start();
    run(runtime, 1);

    expect(enemy.state).toBe('patrol');
  });

  it('does not see the player through a wall', () => {
    const seen = vi.fn(() => false);
    const { runtime, enemy } = harness(
      [{ behaviors: [{ type: 'chaseOnSight', params: { fieldOfView: 360 } }] }],
      fakeWorld({ playerPosition: () => new THREE.Vector3(0, 0, 6), lineOfSight: seen }),
    );
    runtime.start();
    run(runtime, 1);

    expect(seen).toHaveBeenCalled();
    expect(enemy.state).toBe('patrol');
  });

  it('chases, closes the distance and starts attacking', () => {
    const player = new THREE.Vector3(0, 0, 12);
    const damage = vi.fn();
    const { runtime, enemy } = harness(
      [
        {
          behaviors: [
            {
              type: 'chaseOnSight',
              params: { fieldOfView: 360, chaseSpeed: 8, attackRange: 2, attackDamage: 7 },
            },
          ],
        },
      ],
      fakeWorld({ playerPosition: () => player, damagePlayer: damage }),
    );

    runtime.start();
    run(runtime, 0.5);
    expect(enemy.state).toBe('chase');

    run(runtime, 5);
    expect(enemy.state).toBe('attack');
    expect(damage).toHaveBeenCalledWith(7);
  });

  it('throttles line-of-sight checks rather than tracing every frame', () => {
    const seen = vi.fn(() => true);
    const { runtime } = harness(
      [{ behaviors: [{ type: 'chaseOnSight', params: { fieldOfView: 360 } }] }],
      fakeWorld({ playerPosition: () => new THREE.Vector3(0, 0, 6), lineOfSight: seen }),
    );
    runtime.start();
    run(runtime, 1);

    // 60 frames at one check every 0.15s is about seven, not sixty.
    expect(seen.mock.calls.length).toBeLessThan(12);
    expect(seen.mock.calls.length).toBeGreaterThan(3);
  });

  it('dies when damaged past its health and reports it', () => {
    const died = vi.fn();
    const { runtime, enemy } = harness(
      [{ behaviors: [{ type: 'chaseOnSight', params: { health: 20, despawnOnDeath: false } }] }],
      fakeWorld(),
    );
    runtime.on('enemyDied', died);
    runtime.start();

    runtime.emit('damage', { targetId: 'obj_0001', amount: 12 });
    expect(enemy.state).not.toBe('dead');
    expect(enemy.health).toBe(8);

    runtime.emit('damage', { targetId: 'obj_0001', amount: 12 });

    expect(enemy.state).toBe('dead');
    expect(died).toHaveBeenCalled();
  });

  it('ignores damage aimed at somebody else', () => {
    const { runtime, enemy } = harness(
      [{ behaviors: [{ type: 'chaseOnSight', params: { health: 20 } }] }],
      fakeWorld(),
    );
    runtime.start();
    runtime.emit('damage', { targetId: 'obj_9999', amount: 999 });

    expect(enemy.health).toBe(20);
  });

  it('turns on whoever hit it, even from behind', () => {
    const { runtime, enemy } = harness(
      [{ behaviors: [{ type: 'chaseOnSight', params: { fieldOfView: 60, health: 100 } }] }],
      fakeWorld({ playerPosition: () => new THREE.Vector3(0, 0, -6) }),
    );
    runtime.start();
    run(runtime, 0.5);
    expect(enemy.state).toBe('patrol');

    runtime.emit('damage', { targetId: 'obj_0001', amount: 5 });

    expect(enemy.state).toBe('chase');
  });

  it('stops thinking once dead', () => {
    const damage = vi.fn();
    const { runtime, enemy } = harness(
      [
        {
          behaviors: [
            {
              type: 'chaseOnSight',
              params: { health: 1, despawnOnDeath: false, attackRange: 15, fieldOfView: 360 },
            },
          ],
        },
      ],
      fakeWorld({ playerPosition: () => new THREE.Vector3(0, 0, 2), damagePlayer: damage }),
    );
    runtime.start();
    runtime.emit('damage', { targetId: 'obj_0001', amount: 5 });
    damage.mockClear();

    run(runtime, 2);

    expect(enemy.state).toBe('dead');
    expect(damage).not.toHaveBeenCalled();
  });
});

describe('GameRuntime', () => {
  const scene = parseScene({
    sceneId: 'scene_test',
    version: 1,
    objects: [
      {
        id: 'trigger_1',
        assetId: 'logic_trigger_box',
        transform: { position: [0, 0, 0], scale: [6, 4, 6] },
        trigger: {
          shape: 'box',
          onEnter: [
            { type: 'emit', event: 'doorOpened', payload: { door: 'north' } },
            { type: 'spawn', assetId: 'enemy_goblin_01', offset: [3, 0, 0] },
          ],
          onExit: [{ type: 'emit', event: 'doorClosed' }],
        },
      },
    ],
  });

  let player: THREE.Vector3;

  function makeRuntime(): GameRuntime {
    const resolver = new ManifestAssetResolver(manifest);
    const loader = new SceneLoader({ resolver, warn: () => {} });
    const loaded = loader.load(scene);
    const runtime = new GameRuntime({ loader, loaded, scene, resolver, warn: () => {} });

    // A stand-in for the character controller: the runtime only ever reads `.position`.
    runtime.setPlayer({ position: player } as never);
    runtime.start();
    return runtime;
  }

  beforeEach(() => {
    player = new THREE.Vector3(100, 0, 100);
  });

  it('fires onEnter when the player walks in, and onExit when they leave', () => {
    const runtime = makeRuntime();
    const opened = vi.fn();
    const closed = vi.fn();
    runtime.behaviors.on('doorOpened', opened);
    runtime.behaviors.on('doorClosed', closed);

    runtime.update(1 / 60);
    expect(opened).not.toHaveBeenCalled();

    player.set(0, 1, 0);
    runtime.update(1 / 60);
    expect(opened).toHaveBeenCalledWith(
      expect.objectContaining({ door: 'north', triggerId: 'trigger_1', subjectId: 'player' }),
    );

    player.set(100, 0, 100);
    runtime.update(1 / 60);
    expect(closed).toHaveBeenCalled();
  });

  it('spawns an enemy into the running world and takes it away again on stop', () => {
    const runtime = makeRuntime();

    player.set(0, 1, 0);
    runtime.update(1 / 60);

    expect(runtime.spawnedIds).toHaveLength(1);
    const spawnedId = runtime.spawnedIds[0]!;
    expect(runtime.behaviors.behaviorsFor(spawnedId)).toBeDefined();

    runtime.stop();

    // Nothing the preview created survives it — a rehearsal must leave the scene as it found it.
    expect(runtime.spawnedIds).toHaveLength(0);
  });

  it('refuses to spawn an asset it has never heard of', () => {
    const runtime = makeRuntime();
    expect(runtime.spawn({ assetId: 'no_such_asset', position: [0, 0, 0] })).toBeNull();
  });

  it('tracks player health and announces death exactly once', () => {
    const runtime = makeRuntime();
    const died = vi.fn();
    runtime.behaviors.on('playerDied', died);

    runtime.damagePlayer(60);
    expect(runtime.playerHealth()).toBe(40);

    runtime.damagePlayer(100);
    expect(runtime.playerHealth()).toBe(0);
    expect(runtime.playerAlive).toBe(false);

    runtime.damagePlayer(10);
    expect(died).toHaveBeenCalledTimes(1);
  });

  it('answers "no walls" for line of sight when there is no physics world', () => {
    const runtime = makeRuntime();
    expect(runtime.lineOfSight(new THREE.Vector3(), new THREE.Vector3(0, 0, 10))).toBe(true);
  });
});
