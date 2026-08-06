import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';
import { SceneSchema, CURRENT_SCENE_VERSION, type Scene } from '@helaengine/schema';
import { applyScene, readScene } from '@helaengine/collab';
import { createCollabServer, type Authorizer } from './server.js';
import type { RoomStore } from './rooms.js';
import { hashToken } from './store.js';

/**
 * Sprint 31 — the room server, over a real websocket.
 *
 * Not a mock of the transport. The sync protocol is the part most likely to be subtly wrong — a
 * missing step-2 reply, an update echoed back to its sender, an awareness state that outlives its
 * socket — and none of those are visible from a test that calls the handler directly. So these
 * connect actual `y-websocket` clients to an actual listening server, which is also what proves the
 * editor's client library can talk to it at all.
 */

function scene(name = 'Shared Level'): Scene {
  return SceneSchema.parse({
    sceneId: 'scene_room',
    version: CURRENT_SCENE_VERSION,
    name,
    objects: [{ id: 'obj_0001', assetId: 'tree_pine_01', transform: { position: [0, 0, 0] } }],
  });
}

/** An in-memory store, so these tests are about the protocol rather than about Postgres. */
class MemoryStore implements RoomStore {
  readonly scenes = new Map<string, Scene>();
  readonly saves: Array<{ projectId: string; scene: Scene }> = [];

  loadScene(projectId: string): Promise<Scene | null> {
    return Promise.resolve(this.scenes.get(projectId) ?? null);
  }

  saveScene(projectId: string, next: Scene): Promise<void> {
    this.scenes.set(projectId, next);
    this.saves.push({ projectId, scene: next });
    return Promise.resolve();
  }
}

class TokenAuthorizer implements Authorizer {
  readonly allowed = new Map<string, string>([['good-token', 'user_ada']]);

  authorize(token: string, _projectId: string): Promise<{ userId: string } | null> {
    const userId = this.allowed.get(token);
    return Promise.resolve(userId ? { userId } : null);
  }
}

let server: Server;
let origin: string;
let store: MemoryStore;
let auth: TokenAuthorizer;
const open: WebsocketProvider[] = [];

beforeAll(async () => {
  store = new MemoryStore();
  auth = new TokenAuthorizer();

  // A short debounce so a test can watch a save happen rather than waiting five seconds for one.
  const created = createCollabServer({ store, auth, saveDebounceMs: 50 });
  server = created.server;

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 30_000);

afterEach(async () => {
  for (const provider of open.splice(0)) provider.destroy();
  // Long enough for the server to see every close and run its debounced save.
  await wait(200);
  store.saves.length = 0;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

function wait(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Connects a client to a room and waits until it has the document. */
async function connect(
  projectId: string,
  token = 'good-token',
): Promise<{ doc: Y.Doc; provider: WebsocketProvider }> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(origin, projectId, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    params: { token, project: projectId },
    connect: true,
  });
  open.push(provider);

  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error('never synced')), 10_000);
    provider.on('sync', (synced: boolean) => {
      if (!synced) return;
      clearTimeout(timer);
      done();
    });
  });

  return { doc, provider };
}

/** Polls until a condition holds, so a test asserts on convergence rather than on a sleep. */
async function until(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await wait(20);
  }
  throw new Error('condition never became true');
}

describe('joining a room that is not in memory yet', () => {
  /**
   * Sprint 36 — the cold-room race, made deterministic.
   *
   * A `y-websocket` client sends sync step 1 the instant the socket opens; the server has to load
   * and seed the room first, which for a room nobody has open is a database round trip. The message
   * listener used to be registered *after* that await, so the opening message arrived at a socket
   * with no listener and was silently dropped — and the client waited forever for a reply to a
   * question nobody heard.
   *
   * It only ever bit the *first* person to open a project, roughly one time in six, and only
   * against a real database: the in-memory store used by every other test here resolves in a
   * microtask, which is too fast for a message to land in the gap. That is why it survived the
   * Sprint 31 suite and turned up in a load run instead. The delay below is the entire test — it
   * makes the window wide enough that the race is not a race.
   */
  it('does not drop the sync message a client sends while the room is loading', async () => {
    const slowStore: RoomStore = {
      loadScene: async (projectId) => {
        await wait(150);
        return projectId === 'project_cold' ? scene('Cold Level') : null;
      },
      saveScene: () => Promise.resolve(),
    };

    const slow = createCollabServer({ store: slowStore, auth, saveDebounceMs: 50 });
    await new Promise<void>((done) => slow.server.listen(0, '127.0.0.1', done));
    const slowOrigin = `ws://127.0.0.1:${(slow.server.address() as { port: number }).port}`;

    const doc = new Y.Doc();
    const provider = new WebsocketProvider(slowOrigin, 'project_cold', doc, {
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      params: { token: 'good-token', project: 'project_cold' },
    });

    try {
      await new Promise<void>((done, fail) => {
        // Comfortably longer than the 150 ms load and far shorter than y-websocket's reconnect
        // backoff, so a pass means the first attempt worked rather than that a retry rescued it.
        const timer = setTimeout(() => fail(new Error('never synced')), 3_000);
        provider.on('sync', (synced: boolean) => {
          if (!synced) return;
          clearTimeout(timer);
          done();
        });
      });

      expect(readSafely(doc)?.name).toBe('Cold Level');
    } finally {
      provider.destroy();
      await new Promise<void>((done) => slow.server.close(() => done()));
    }
  }, 20_000);
});

describe('joining a room', () => {
  it('seeds the room from the project’s saved scene', async () => {
    store.scenes.set('project_seed', scene('Saved Level'));

    const { doc } = await connect('project_seed');
    await until(() => readSafely(doc)?.name === 'Saved Level');

    expect(readScene(doc).objects.map((object) => object.id)).toEqual(['obj_0001']);
  });

  it('starts empty for a project that has never been saved, rather than inventing a scene', async () => {
    const { doc } = await connect('project_never_saved');
    await wait(200);

    expect(doc.getMap('document').size).toBe(0);
    expect(doc.getMap('objects').size).toBe(0);
  });

  it('gives a second arrival the state the first one built', async () => {
    store.scenes.set('project_two', scene());

    const first = await connect('project_two');
    await until(() => readSafely(first.doc) !== null);

    const base = readScene(first.doc);
    const edited = structuredClone(base);
    edited.name = 'Renamed by the first person';
    applyScene(first.doc, edited, base);

    // Joining after the edit: the newcomer must get the *current* document, not the seed.
    const second = await connect('project_two');
    await until(() => readSafely(second.doc)?.name === 'Renamed by the first person');

    expect(readScene(second.doc).name).toBe('Renamed by the first person');
  });
});

describe('refusing a room', () => {
  it('refuses a socket with no token', async () => {
    await expect(connectRaw('project_private', '')).rejects.toThrow();
  });

  it('refuses a socket whose token is not valid', async () => {
    // Refused during the upgrade, so the client never holds a socket that could have received
    // document bytes before being told to go away.
    await expect(connectRaw('project_private', 'not-a-real-token')).rejects.toThrow();
  });

  it('answers the same way for a project that does not exist as for one you cannot see', async () => {
    // Both are "no", by construction: `authorize` returns null without saying which. A socket that
    // could tell the two apart would be a project-existence oracle.
    await expect(connectRaw('project_missing', 'not-a-real-token')).rejects.toThrow();
    await expect(connectRaw('project_private', 'not-a-real-token')).rejects.toThrow();
  });
});

/** A bare socket, so an upgrade rejection is observable rather than retried forever. */
function connectRaw(projectId: string, token: string): Promise<void> {
  return new Promise((done, fail) => {
    const socket = new WebSocket(`${origin}/${projectId}?token=${token}&project=${projectId}`);
    socket.on('open', () => {
      socket.close();
      done();
    });
    socket.on('error', (error) => fail(error));
    socket.on('unexpected-response', (_request, response) =>
      fail(new Error(`upgrade refused with ${response.statusCode}`)),
    );
  });
}

describe('editing together', () => {
  it('propagates an edit from one client to another', async () => {
    store.scenes.set('project_live', scene());

    const a = await connect('project_live');
    const b = await connect('project_live');
    await until(() => readSafely(a.doc) !== null && readSafely(b.doc) !== null);

    const base = readScene(a.doc);
    const edited = structuredClone(base);
    edited.objects[0]!.transform.position = [7, 0, 7];
    applyScene(a.doc, edited, base);

    await until(
      () => readSafely(b.doc)?.objects[0]?.transform.position.join(',') === '7,0,7',
      3_000,
    );
  });

  it('merges simultaneous edits to different objects', async () => {
    const start = SceneSchema.parse({
      sceneId: 'scene_room',
      version: CURRENT_SCENE_VERSION,
      objects: [
        { id: 'obj_a', assetId: 'tree_pine_01' },
        { id: 'obj_b', assetId: 'rock_boulder_01' },
      ],
    });
    store.scenes.set('project_merge', start);

    const a = await connect('project_merge');
    const b = await connect('project_merge');
    await until(() => readSafely(a.doc)?.objects.length === 2);
    await until(() => readSafely(b.doc)?.objects.length === 2);

    // Applied in the same tick on both sides, which is as close to simultaneous as two processes
    // sharing an event loop can be.
    const baseA = readScene(a.doc);
    const mine = structuredClone(baseA);
    mine.objects.find((object) => object.id === 'obj_a')!.transform.position = [9, 0, 0];

    const baseB = readScene(b.doc);
    const theirs = structuredClone(baseB);
    theirs.objects.find((object) => object.id === 'obj_b')!.transform.position = [0, 0, 9];

    applyScene(a.doc, mine, baseA);
    applyScene(b.doc, theirs, baseB);

    for (const doc of [a.doc, b.doc]) {
      await until(() => {
        const read = readSafely(doc);
        return (
          read?.objects.find((object) => object.id === 'obj_a')?.transform.position.join(',') ===
            '9,0,0' &&
          read.objects.find((object) => object.id === 'obj_b')?.transform.position.join(',') ===
            '0,0,9'
        );
      }, 5_000);
    }
  }, 30_000);

  it('survives both clients deleting the same object at once', async () => {
    const start = SceneSchema.parse({
      sceneId: 'scene_room',
      version: CURRENT_SCENE_VERSION,
      objects: [
        { id: 'obj_keep', assetId: 'tree_pine_01' },
        { id: 'obj_doomed', assetId: 'rock_boulder_01' },
      ],
    });
    store.scenes.set('project_delete', start);

    const a = await connect('project_delete');
    const b = await connect('project_delete');
    await until(() => readSafely(a.doc)?.objects.length === 2);
    await until(() => readSafely(b.doc)?.objects.length === 2);

    const baseA = readScene(a.doc);
    const baseB = readScene(b.doc);
    const without = structuredClone(baseA);
    without.objects = without.objects.filter((object) => object.id !== 'obj_doomed');
    applyScene(a.doc, without, baseA);
    applyScene(b.doc, without, baseB);

    for (const doc of [a.doc, b.doc]) {
      await until(() => readSafely(doc)?.objects.length === 1);
      expect(readScene(doc).objects[0]!.id).toBe('obj_keep');
    }
  });
});

describe('presence', () => {
  it('shows each client the other, and forgets one that leaves', async () => {
    store.scenes.set('project_presence', scene());

    const a = await connect('project_presence');
    const b = await connect('project_presence');

    a.provider.awareness.setLocalState({ userId: 'user_ada', displayName: 'Ada' });
    b.provider.awareness.setLocalState({ userId: 'user_lin', displayName: 'Lin' });

    await until(() => a.provider.awareness.getStates().size === 2, 3_000);
    await until(() => b.provider.awareness.getStates().size === 2, 3_000);

    b.provider.destroy();

    // Removed on disconnect rather than left to time out. Without the server tracking which
    // awareness ids a socket speaks for, this would sit at 2 for thirty seconds and every
    // collaborator would watch a ghost cursor.
    await until(() => a.provider.awareness.getStates().size === 1, 5_000);
  });
});

describe('persisting a room', () => {
  it('writes a version after edits settle', async () => {
    store.scenes.set('project_save', scene());

    const a = await connect('project_save');
    await until(() => readSafely(a.doc) !== null);

    const base = readScene(a.doc);
    const edited = structuredClone(base);
    edited.name = 'Edited Together';
    applyScene(a.doc, edited, base);

    await until(() => store.saves.some((save) => save.scene.name === 'Edited Together'), 5_000);
  });

  it('does not write a version for merely opening a room', async () => {
    store.scenes.set('project_quiet', scene());

    await connect('project_quiet');
    await wait(300);

    // The seed is not an edit. Without this, every room anybody opens writes a version identical
    // to the one it just read — and a project's history fills with noise nobody made.
    expect(store.saves).toHaveLength(0);
  });

  it('flushes when the last client leaves', async () => {
    store.scenes.set('project_flush', scene());

    const a = await connect('project_flush');
    await until(() => readSafely(a.doc) !== null);

    const base = readScene(a.doc);
    const edited = structuredClone(base);
    edited.name = 'Saved On The Way Out';
    applyScene(a.doc, edited, base);

    a.provider.destroy();
    await until(() => store.scenes.get('project_flush')?.name === 'Saved On The Way Out', 5_000);
  });
});

/** `readScene` throws on a partially-synced document, which during a race is normal rather than wrong. */
function readSafely(doc: Y.Doc): Scene | null {
  try {
    return readScene(doc);
  } catch {
    return null;
  }
}

describe('agreeing with the API about a session token', () => {
  it('hashes a token to the same digest apps/api stores', () => {
    // `store.ts` restates the API's `hashToken` rather than importing it, so that this service does
    // not pull in the API's module graph — pool, routes and all — to hash sixty-four characters.
    // This is the guard that makes the restatement safe: the same literal is asserted in
    // `apps/api/src/api.test.ts`, so changing either implementation breaks its own suite rather
    // than silently ending every collaborative session's ability to authenticate.
    expect(hashToken('a-known-session-token')).toBe(
      '639a1fbb1598acc02453eff9ca25eaa6972bf8da2b7956cb2d0e8efd7fce9784',
    );
  });
});
