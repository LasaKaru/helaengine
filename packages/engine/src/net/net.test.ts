import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { MultiplayerConfigSchema, PlayerSchema } from '@helaengine/schema';
import { CoopClient, type CoopInput, type CoopTransport } from './CoopClient.js';
import { RemotePlayers, interpolateAngle, type RemotePlayerSnapshot } from './RemotePlayers.js';

function snapshot(overrides: Partial<RemotePlayerSnapshot> = {}): RemotePlayerSnapshot {
  return {
    sessionId: 'other',
    name: 'Other',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    health: 100,
    crouched: false,
    speed: 0,
    ...overrides,
  };
}

const INPUT: CoopInput = {
  forward: 1,
  right: 0,
  jump: false,
  sprint: false,
  crouch: false,
  yaw: 0,
};

/** A transport that records rather than connects. */
function fakeTransport(options: { fail?: string } = {}): CoopTransport & {
  sent: Array<{ type: string; payload: unknown }>;
  push(players: RemotePlayerSnapshot[]): void;
} {
  const sent: Array<{ type: string; payload: unknown }> = [];
  let onPlayers: ((players: RemotePlayerSnapshot[]) => void) | null = null;

  return {
    sent,
    push(players) {
      onPlayers?.(players);
    },
    connect: async () => {
      if (options.fail) throw new Error(options.fail);
      return { sessionId: 'me' };
    },
    send: (type, payload) => {
      sent.push({ type, payload });
    },
    onPlayers: (listener) => {
      onPlayers = listener;
    },
    onMessage: () => {},
    leave: async () => {},
  };
}

function client(
  config: Record<string, unknown> = {},
  transport = fakeTransport(),
): { client: CoopClient; transport: ReturnType<typeof fakeTransport> } {
  return {
    client: new CoopClient({
      config: MultiplayerConfigSchema.parse({
        enabled: true,
        mode: 'coop',
        serverUrl: 'ws://localhost:2567',
        inputHz: 20,
        ...config,
      }),
      transport,
      sceneId: 'scene_demo',
      scene: { sceneId: 'scene_demo' },
      warn: () => {},
    }),
    transport,
  };
}

describe('CoopClient', () => {
  it('does not connect at all for a single-player document', async () => {
    const { client: solo, transport } = client({ enabled: false });
    expect(await solo.connect()).toBe(false);
    expect(transport.sent).toEqual([]);
  });

  it('does not connect for a mode the runtime does not implement', async () => {
    // `deathmatch` is in the schema so a document can express the intent. It is not co-op, and
    // silently treating it as co-op would be worse than refusing.
    const { client: dm } = client({ mode: 'deathmatch' });
    expect(await dm.connect()).toBe(false);
  });

  it('says so rather than quietly playing solo when no server URL is set', async () => {
    const { client: nowhere } = client({ serverUrl: '' });

    expect(await nowhere.connect()).toBe(false);
    expect(nowhere.status).toBe('failed');
    expect(nowhere.error).toMatch(/no server URL/);
  });

  it('drops to single player when the server cannot be reached', async () => {
    // Somebody who wanted to play should be playing, even alone.
    const { client: offline } = client({}, fakeTransport({ fail: 'ECONNREFUSED' }));

    expect(await offline.connect()).toBe(false);
    expect(offline.status).toBe('failed');
    expect(offline.error).toBe('ECONNREFUSED');
  });

  it('throttles input to the configured rate rather than sending per frame', async () => {
    const { client: net, transport } = client({ inputHz: 20 });
    await net.connect();

    // A second of 60 fps frames.
    for (let frame = 0; frame < 60; frame += 1) net.update(1 / 60, INPUT);

    const inputs = transport.sent.filter((message) => message.type === 'input');
    expect(inputs.length).toBeGreaterThanOrEqual(19);
    expect(inputs.length).toBeLessThanOrEqual(21);
  });

  it('numbers its inputs, so a future prediction layer can reconcile', async () => {
    const { client: net, transport } = client();
    await net.connect();

    for (let frame = 0; frame < 10; frame += 1) net.update(0.1, INPUT);
    const seqs = transport.sent.map((message) => (message.payload as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('sends nothing at all before connecting or after leaving', async () => {
    const { client: net, transport } = client();

    net.update(1, INPUT);
    expect(transport.sent).toEqual([]);

    await net.connect();
    net.update(1, INPUT);
    expect(transport.sent).toHaveLength(1);

    await net.disconnect();
    net.update(1, INPUT);
    expect(transport.sent).toHaveLength(1);
  });

  it('asks the server about damage rather than announcing it', async () => {
    const { client: net, transport } = client();
    await net.connect();

    net.reportDamage(40);
    net.reportDestroyed('obj_0004');

    expect(transport.sent).toEqual([
      { type: 'damage', payload: { amount: 40 } },
      { type: 'destroy', payload: { objectId: 'obj_0004' } },
    ]);
  });

  it('reports whoever the server says is in the session', async () => {
    const { client: net, transport } = client();
    await net.connect();

    transport.push([snapshot({ sessionId: 'me' }), snapshot({ sessionId: 'them' })]);
    expect(net.players.map((player) => player.sessionId)).toEqual(['me', 'them']);
  });
});

describe('RemotePlayers', () => {
  const player = PlayerSchema.parse({});

  function rig(): { remotes: RemotePlayers; root: THREE.Object3D } {
    const root = new THREE.Group();
    return { remotes: new RemotePlayers(root, player), root };
  }

  it('draws everyone except this client', () => {
    // A second avatar standing inside its own eye is the first thing anybody would report.
    const { remotes, root } = rig();
    remotes.sync([snapshot({ sessionId: 'me' }), snapshot({ sessionId: 'them' })], 'me');

    expect(remotes.ids()).toEqual(['them']);
    expect(root.children).toHaveLength(1);
  });

  it('adds and removes avatars as people join and leave', () => {
    const { remotes, root } = rig();
    remotes.sync([snapshot({ sessionId: 'a' }), snapshot({ sessionId: 'b' })], 'me');
    expect(remotes.count).toBe(2);

    remotes.sync([snapshot({ sessionId: 'a' })], 'me');
    expect(remotes.count).toBe(1);
    expect(root.children).toHaveLength(1);
  });

  it('glides towards the server position rather than snapping to every packet', () => {
    // The server broadcasts twenty times a second and the client draws sixty; snapping means every
    // remote player visibly stutters.
    const { remotes } = rig();
    remotes.sync([snapshot({ sessionId: 'them', z: 0 })], 'me');
    remotes.sync([snapshot({ sessionId: 'them', z: 4 })], 'me');

    remotes.update(1 / 60);
    const partway = remotes.positionOf('them')!.z;
    expect(partway).toBeGreaterThan(0);
    expect(partway).toBeLessThan(4);

    for (let frame = 0; frame < 60; frame += 1) remotes.update(1 / 60);
    expect(remotes.positionOf('them')!.z).toBeCloseTo(4, 1);
  });

  it('teleports rather than gliding across the level after a respawn', () => {
    const { remotes } = rig();
    remotes.sync([snapshot({ sessionId: 'them', z: 0 })], 'me');
    remotes.sync([snapshot({ sessionId: 'them', z: 60 })], 'me');

    remotes.update(1 / 60);
    expect(remotes.positionOf('them')!.z).toBe(60);
  });

  it('cleans up when disposed', () => {
    const { remotes, root } = rig();
    remotes.sync([snapshot({ sessionId: 'a' }), snapshot({ sessionId: 'b' })], 'me');

    remotes.dispose();
    expect(remotes.count).toBe(0);
    expect(root.children).toHaveLength(0);
  });
});

describe('interpolateAngle', () => {
  it('turns the short way round', () => {
    // A plain lerp from 3.1 to -3.1 spins the avatar the whole way around rather than the few
    // degrees it actually turned.
    const halfway = interpolateAngle(3.1, -3.1, 0.5);
    expect(Math.abs(halfway)).toBeGreaterThan(3.1);
  });

  it('is a plain blend when there is no wrap', () => {
    expect(interpolateAngle(0, 1, 0.5)).toBeCloseTo(0.5, 5);
  });

  it('stays put when there is nowhere to go', () => {
    expect(interpolateAngle(1.2, 1.2, 0.5)).toBeCloseTo(1.2, 6);
  });
});

describe('scope', () => {
  it('has no prediction, and that is deliberate', () => {
    // A guard against somebody quietly adding client-side simulation: a remote position is a fact
    // received, never a guess. If this ever needs relaxing, it is a competitive-netcode project,
    // not a tweak.
    const { remotes } = rig2();
    remotes.sync([snapshot({ sessionId: 'them', z: 0, speed: 6 })], 'me');

    // Twenty frames with no new packet at all. A predicting client would have carried them
    // forward at 6 m/s; this one holds still.
    for (let frame = 0; frame < 20; frame += 1) remotes.update(1 / 60);
    expect(remotes.positionOf('them')!.z).toBeCloseTo(0, 3);
  });

  function rig2(): { remotes: RemotePlayers } {
    return { remotes: new RemotePlayers(new THREE.Group(), PlayerSchema.parse({})) };
  }
});

describe('transport isolation', () => {
  it('never imports a networking library into the engine', async () => {
    // `packages/engine` ships inside every export. A hard dependency on colyseus.js would put a
    // socket client in the bundle of every single-player game anybody ever makes.
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('./CoopClient.ts', import.meta.url), 'utf8'),
    );
    expect(source).not.toMatch(/from ['"]colyseus/);
    expect(vi.isMockFunction(() => {})).toBe(false);
  });
});
