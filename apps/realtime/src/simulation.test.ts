import { beforeAll, describe, expect, it } from 'vitest';
import { parseAssetManifest, parseScene, type AssetManifest, type Scene } from '@helaengine/schema';
import { CoopSimulation, type PlayerInput } from './simulation.js';

const manifest: AssetManifest = parseAssetManifest({
  version: 1,
  assets: [{ id: 'prop_wall_01', name: 'Wall', category: 'props', bounds: [8, 4, 1] }],
});

function scene(overrides: Record<string, unknown> = {}): Scene {
  return parseScene({
    sceneId: 'scene_coop',
    version: 1,
    player: { spawn: [0, 0, 0], moveSpeed: 6, health: 100 },
    terrain: { type: 'flat' },
    ...overrides,
  });
}

function input(overrides: Partial<PlayerInput> = {}): PlayerInput {
  return {
    forward: 0,
    right: 0,
    jump: false,
    sprint: false,
    crouch: false,
    yaw: 0,
    seq: 1,
    ...overrides,
  };
}

/** Runs a second of server time at the real tick rate. */
function run(simulation: CoopSimulation, seconds: number): void {
  const step = 1 / 20;
  for (let elapsed = 0; elapsed < seconds; elapsed += step) simulation.step(step);
}

describe('CoopSimulation', () => {
  let ready: CoopSimulation;

  beforeAll(async () => {
    // Proves the headline claim before any test asserts anything else: the engine's physics builds
    // and steps in Node, with no browser, no renderer and no DOM.
    ready = await CoopSimulation.create(scene(), manifest);
  });

  it('runs the engine in Node with no browser at all', () => {
    expect(ready.playerCount).toBe(0);
    expect(() => ready.step(1 / 20)).not.toThrow();
    expect(ready.tick).toBeGreaterThan(0);
  });

  it('spawns each player at the scene spawn, fanned out so they do not start inside each other', async () => {
    const simulation = await CoopSimulation.create(scene(), manifest);
    const first = simulation.add('a');
    const second = simulation.add('b');

    expect(simulation.playerCount).toBe(2);
    const gap = first.controller.position.distanceTo(second.controller.position);
    expect(gap).toBeGreaterThan(0.5);
    simulation.dispose();
  });

  it('moves a player by their own input, and only theirs', async () => {
    const simulation = await CoopSimulation.create(scene(), manifest);
    const walker = simulation.add('a');
    const stander = simulation.add('b');
    const before = walker.controller.position.clone();
    const stayed = stander.controller.position.clone();

    // yaw 0 faces -Z, the same convention the camera and the character controller share.
    simulation.setInput('a', input({ forward: 1 }));
    run(simulation, 1);

    expect(walker.controller.position.z).toBeLessThan(before.z - 2);
    expect(stander.controller.position.distanceTo(stayed)).toBeLessThan(0.5);
    simulation.dispose();
  });

  it('keeps the last intent when a client stops sending, which is what a dropped packet looks like', async () => {
    const simulation = await CoopSimulation.create(scene(), manifest);
    const player = simulation.add('a');
    simulation.setInput('a', input({ forward: 1 }));

    run(simulation, 0.5);
    const halfway = player.controller.position.z;
    // No further input at all.
    run(simulation, 0.5);

    expect(player.controller.position.z).toBeLessThan(halfway);
    simulation.dispose();
  });

  it('clamps nonsense rather than trusting the wire', async () => {
    // A client sending `forward: 1e9` is not a faster player. Clamping here is the difference
    // between a server that is authoritative and one that merely runs on a server.
    const simulation = await CoopSimulation.create(scene(), manifest);
    const cheat = simulation.add('a');
    const honest = simulation.add('b');
    // Measured from each player's own start: they are fanned out around the spawn, so comparing
    // absolute positions would be comparing the fan-out rather than the distance travelled.
    const cheatFrom = cheat.controller.position.clone();
    const honestFrom = honest.controller.position.clone();

    simulation.setInput('a', { forward: 1e9, right: 0, yaw: 0, seq: 1 });
    simulation.setInput('b', input({ forward: 1 }));
    run(simulation, 1);

    const cheated = cheat.controller.position.distanceTo(cheatFrom);
    const honestly = honest.controller.position.distanceTo(honestFrom);
    expect(cheated).toBeGreaterThan(3);
    // Both travelled about the same distance: the clamp did its job.
    expect(Math.abs(cheated - honestly)).toBeLessThan(0.5);
    simulation.dispose();
  });

  it('survives an input that is not an input at all', async () => {
    const simulation = await CoopSimulation.create(scene(), manifest);
    simulation.add('a');

    for (const rubbish of [null, undefined, 'forward', 42, { forward: NaN, yaw: Infinity }]) {
      expect(() => simulation.setInput('a', rubbish)).not.toThrow();
    }
    expect(() => run(simulation, 0.2)).not.toThrow();
    simulation.dispose();
  });

  it('ignores an input that arrived out of order', async () => {
    const simulation = await CoopSimulation.create(scene(), manifest);
    simulation.add('a');

    simulation.setInput('a', input({ forward: 1, seq: 10 }));
    simulation.setInput('a', input({ forward: -1, seq: 3 }));

    expect(simulation.player('a')!.input.forward).toBe(1);
    simulation.dispose();
  });

  it('stops a player at a wall, because the server has the colliders too', async () => {
    // The point of running the real engine server-side: geometry the client can see is geometry
    // the server enforces, so walking through a wall is not something a modified client can do.
    const walled = await CoopSimulation.create(
      scene({
        objects: [
          {
            id: 'obj_0001',
            assetId: 'prop_wall_01',
            transform: { position: [0, 0, -4] },
            physics: { body: 'static', collider: 'box' },
          },
        ],
      }),
      manifest,
    );
    const player = walled.add('a');
    walled.setInput('a', input({ forward: 1 }));
    run(walled, 2);

    // The wall is at z = -4 and half a metre thick; the player should be stopped short of it
    // rather than twelve metres beyond where they started.
    expect(player.controller.position.z).toBeGreaterThan(-4);
    walled.dispose();
  });

  it('removes a player and frees their body', async () => {
    const simulation = await CoopSimulation.create(scene(), manifest);
    simulation.add('a');
    simulation.add('b');

    simulation.remove('a');
    expect(simulation.playerCount).toBe(1);
    expect(simulation.player('a')).toBeUndefined();
    // Still steppable: a departed player must not leave a body the solver walks into.
    expect(() => run(simulation, 0.5)).not.toThrow();
    simulation.dispose();
  });

  it('shares a destruction with everybody, once', async () => {
    const simulation = await CoopSimulation.create(
      scene({
        objects: [{ id: 'obj_0001', assetId: 'prop_wall_01', transform: { position: [0, 0, -4] } }],
      }),
      manifest,
    );

    expect(simulation.destroy('obj_0001')).toBe(true);
    expect(simulation.destroy('obj_0001')).toBe(false);
    expect(simulation.destroyedObjectIds).toEqual(['obj_0001']);
    simulation.dispose();
  });

  it('respawns a player who runs out of health rather than leaving them dead', async () => {
    const simulation = await CoopSimulation.create(scene(), manifest);
    simulation.add('a');
    simulation.setInput('a', input({ forward: 1 }));
    run(simulation, 1);

    expect(simulation.damage('a', 30)).toBe(70);
    expect(simulation.damage('a', 500)).toBe(100);
    // Back at the spawn point, not where they died.
    expect(simulation.player('a')!.controller.position.z).toBeCloseTo(0, 0);
    simulation.dispose();
  });

  it('refuses damage for somebody who is not in the room', async () => {
    const simulation = await CoopSimulation.create(scene(), manifest);
    expect(simulation.damage('nobody', 10)).toBeNull();
    simulation.dispose();
  });
});
