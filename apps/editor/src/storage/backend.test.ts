import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseScene, type Scene } from '@helaengine/schema';
import * as backend from './backend';

/**
 * Sprint 29 — the switch between local and cloud storage.
 *
 * What is worth testing here is the *dispatch* and the version bookkeeping, not the two stores
 * themselves: IndexedDB's is Sprint 8's, the API's is tested against real Postgres. The bug this
 * guards against is the one the facade exists to prevent — a save that goes to the wrong place, or
 * one that sends the wrong base version and quietly wins a race it should have lost.
 */

function scene(name = 'Scene'): Scene {
  return parseScene({ sceneId: 'scene_x', version: 1, name, objects: [] });
}

function api(
  handler: (path: string, init: RequestInit) => { status: number; body: unknown },
): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const { status, body } = handler(new URL(url).pathname, init);
      return Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
}

afterEach(() => {
  backend.signOut();
  vi.unstubAllGlobals();
});

describe('which store is used', () => {
  it('is local until somebody signs in, and local again after they leave', () => {
    expect(backend.isCloud()).toBe(false);
    backend.signIn({ origin: 'http://api.test', token: 't', organizationId: 'o' });
    expect(backend.isCloud()).toBe(true);
    backend.signOut();
    expect(backend.isCloud()).toBe(false);
  });
});

describe('version bookkeeping', () => {
  it('sends the version the last save returned, not a guess', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let version = 0;

    api((path, init) => {
      if (path.endsWith('/projects') && init.method === 'POST') {
        version = 1;
        return {
          status: 201,
          body: {
            project: {
              id: 'p1',
              organizationId: 'o',
              name: 'X',
              latestVersion: 1,
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            },
          },
        };
      }
      if (path.endsWith('/versions')) {
        bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        version += 1;
        return { status: 201, body: { version } };
      }
      return { status: 200, body: {} };
    });

    backend.signIn({ origin: 'http://api.test', token: 't', organizationId: 'o' });
    const id = await backend.createProject('X', scene());

    await backend.saveProject({ id, scene: scene('a') });
    await backend.saveProject({ id, scene: scene('b') });

    // Created at 1, so the saves are based on 1 then 2. Sending 0 twice would make the second save
    // a conflict the server is right to refuse — and the first one silently win any race.
    expect(bodies.map((body) => body['baseVersion'])).toEqual([1, 2]);
    expect(backend.baseVersion(id)).toBe(3);
  });

  it('does not move the base version when a save conflicts', async () => {
    api((path) => {
      if (path.endsWith('/versions')) {
        return {
          status: 409,
          body: {
            error: 'somebody else saved this project since you loaded it (they are on version 9)',
          },
        };
      }
      return { status: 200, body: {} };
    });

    backend.signIn({ origin: 'http://api.test', token: 't', organizationId: 'o' });
    await expect(backend.saveProject({ id: 'p1', scene: scene() })).rejects.toBeInstanceOf(
      backend.ConflictError,
    );
    // Still on the version it thought it was: a client that advanced on a refusal would then send
    // a base the server has never seen.
    expect(backend.baseVersion('p1')).toBe(0);
  });
});

describe('history without an account', () => {
  it('answers with an empty list rather than throwing', async () => {
    // A local project genuinely has no history, and a panel saying so beats an exception.
    expect(await backend.projectHistory('anything')).toEqual([]);
  });

  it('refuses to restore, and says why', async () => {
    await expect(backend.restoreVersion('anything', 1)).rejects.toThrow(/signed-in/);
  });
});
