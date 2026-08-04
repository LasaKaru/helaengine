import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import colyseus from 'colyseus';
import { Client, type Room } from 'colyseus.js';
import { parseAssetManifest, parseScene } from '@helaengine/schema';
import { CoopRoom } from './CoopRoom.js';
import type { RoomState } from './state.js';

const manifest = parseAssetManifest({ version: 1, assets: [] });
const scene = parseScene({
  sceneId: 'scene_coop',
  version: 1,
  player: { spawn: [0, 0, 0], moveSpeed: 6, health: 100 },
  gameConfig: { multiplayer: { enabled: true, mode: 'coop', maxPlayers: 4 } },
});

/** Waits for a condition the server has to reach on its own clock. */
async function until(predicate: () => boolean, message: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/**
 * Two real clients over a real socket, against a real server.
 *
 * The point of running the whole stack rather than calling the room's methods: the definition of
 * done is about two clients *seeing each other*, and everything between the simulation and that —
 * schema encoding, patch broadcast, session lifecycle — is exactly where a co-op bug lives.
 */
describe('CoopRoom over a real socket', () => {
  let server: InstanceType<typeof colyseus.Server>;
  let port: number;

  beforeAll(async () => {
    server = new colyseus.Server({ server: http.createServer() });
    server.define('coop', CoopRoom);
    // Port 0 asks the OS for a free one, so a test run never collides with a dev server.
    await server.listen(0);
    port = (server as unknown as { transport: { server: http.Server } }).transport.server.address()
      ? (
          (
            server as unknown as { transport: { server: http.Server } }
          ).transport.server.address() as { port: number }
        ).port
      : 0;
  });

  afterAll(async () => {
    await server?.gracefullyShutdown(false);
  });

  function connect(): Client {
    return new Client(`ws://127.0.0.1:${port}`);
  }

  it('lets two clients join one session and see each other', async () => {
    const alice = await connect().joinOrCreate<RoomState>('coop', {
      scene,
      manifest,
      name: 'Alice',
    });
    const bob = await connect().joinById<RoomState>(alice.roomId, { name: 'Bob' });

    await until(() => alice.state.players.size === 2, 'both players in the room');
    await until(() => bob.state.players.size === 2, "Bob's view of the room");

    const names = [...alice.state.players.values()].map((player) => player.name).sort();
    expect(names).toEqual(['Alice', 'Bob']);
    expect(alice.state.sceneId).toBe('scene_coop');

    await alice.leave();
    await bob.leave();
  });

  it('moves one player and the other sees it, server-authoritative', async () => {
    // The definition of done, in one test.
    const alice = await connect().joinOrCreate<RoomState>('coop', { scene, manifest, name: 'A' });
    const bob = await connect().joinById<RoomState>(alice.roomId, { name: 'B' });
    await until(() => bob.state.players.size === 2, 'both players');

    const aliceId = alice.sessionId;
    const startZ = bob.state.players.get(aliceId)!.z;

    // Alice walks. Note she sends *intent* — the position she ends up at is the server's answer.
    const ticker = setInterval(() => {
      alice.send('input', { forward: 1, right: 0, jump: false, yaw: 0, seq: Date.now() });
    }, 50);

    await until(
      () => (bob.state.players.get(aliceId)?.z ?? 0) < startZ - 2,
      'Bob seeing Alice move',
    );
    clearInterval(ticker);

    // And Bob, who sent nothing, has not moved.
    const bobState = alice.state.players.get(bob.sessionId)!;
    expect(Math.abs(bobState.z)).toBeLessThan(2);

    await alice.leave();
    await bob.leave();
  });

  it('ignores a client trying to move somebody else', async () => {
    // There is no "set position" message at all — a client can only send its own intent, and the
    // server applies it to the session it arrived on. That is the whole authority model.
    const alice = await connect().joinOrCreate<RoomState>('coop', { scene, manifest });
    const bob = await connect().joinById<RoomState>(alice.roomId, {});
    await until(() => alice.state.players.size === 2, 'both players');

    const bobStart = alice.state.players.get(bob.sessionId)!.z;
    for (let index = 0; index < 10; index += 1) {
      alice.send('input', { forward: 1, yaw: 0, seq: index, sessionId: bob.sessionId });
    }
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(Math.abs(alice.state.players.get(bob.sessionId)!.z - bobStart)).toBeLessThan(0.5);
    await alice.leave();
    await bob.leave();
  });

  it('shares a destroyed object with everybody', async () => {
    const alice = await connect().joinOrCreate<RoomState>('coop', { scene, manifest });
    const bob = await connect().joinById<RoomState>(alice.roomId, {});
    await until(() => bob.state.players.size === 2, 'both players');

    let announced = '';
    bob.onMessage('objectDestroyed', (message: { objectId: string }) => {
      announced = message.objectId;
    });

    alice.send('destroy', { objectId: 'obj_0004' });
    await until(() => announced === 'obj_0004', 'Bob hearing about the destruction');
    await until(
      () => bob.state.destroyedObjectIds.includes('obj_0004'),
      'the shared destroyed list',
    );

    await alice.leave();
    await bob.leave();
  });

  it('takes a player out of the state when they leave', async () => {
    const alice = await connect().joinOrCreate<RoomState>('coop', { scene, manifest });
    const bob = await connect().joinById<RoomState>(alice.roomId, {});
    await until(() => alice.state.players.size === 2, 'both players');

    await bob.leave();
    await until(() => alice.state.players.size === 1, "Bob leaving Alice's view");

    await alice.leave();
  });

  it('refuses a client whose document is a different scene', async () => {
    // Otherwise they wander through geometry nobody else has, which reads as everyone else
    // teleporting rather than as a mismatch.
    const alice = await connect().joinOrCreate<RoomState>('coop', { scene, manifest });

    await expect(
      connect().joinById<RoomState>(alice.roomId, { sceneId: 'scene_something_else' }),
    ).rejects.toThrow();

    await alice.leave();
  });

  it('refuses to open a room on a document that does not validate', async () => {
    // A room built on a scene the server cannot read would desync every client in a way nobody
    // could diagnose. Refusing to open is the loud failure.
    await expect(
      connect().joinOrCreate<RoomState>('coop', { scene: { nonsense: true }, manifest }),
    ).rejects.toThrow();
  });

  it('is authoritative about health: a client asks, the server decides', async () => {
    const alice = await connect().joinOrCreate<RoomState>('coop', { scene, manifest });
    await until(() => alice.state.players.size === 1, 'the player');

    alice.send('damage', { amount: 25 });
    await until(
      () => alice.state.players.get(alice.sessionId)?.health === 75,
      'health dropping to 75',
    );

    // Asking for negative damage is not a heal.
    alice.send('damage', { amount: -1000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alice.state.players.get(alice.sessionId)!.health).toBe(75);

    await alice.leave();
  });

  it('advances its own clock rather than a client clock', async () => {
    const alice = await connect().joinOrCreate<RoomState>('coop', { scene, manifest });
    await until(() => alice.state.tick > 0, 'the first tick');
    const first = alice.state.tick;

    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(alice.state.tick).toBeGreaterThan(first);

    await alice.leave();
  });
});

/** Kept out of the describe so a typo in the room name fails loudly rather than hanging. */
export type { Room };
