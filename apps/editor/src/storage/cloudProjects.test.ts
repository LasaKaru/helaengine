import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseScene, type Scene } from '@helaengine/schema';
import { CloudProjects, ConflictError, NotSignedIn } from './cloudProjects';

/**
 * Sprint 29 — the editor's side of cloud save.
 *
 * `fetch` is stubbed rather than a server being started: what is under test here is the *client's*
 * behaviour at each answer the API can give — particularly the two that are not "it worked". The
 * API's own behaviour is tested against a real Postgres in `apps/api`.
 */

const session = {
  origin: 'http://api.test',
  token: 'tok',
  organizationId: 'org',
  userId: 'user_test',
  displayName: 'Test Person',
};

function scene(name = 'Scene'): Scene {
  return parseScene({ sceneId: 'scene_x', version: 1, name, objects: [] });
}

function answer(status: number, body: unknown): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Promise.resolve(
        // `null`, not `''`: constructing a 204 with any body at all throws, which would make the
        // stub the thing under test.
        new Response(status === 204 ? null : JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('saving', () => {
  it('sends the base version and returns the new one', async () => {
    answer(201, { version: 4 });
    const cloud = new CloudProjects(session);

    expect(await cloud.save('p1', scene(), 3)).toBe(4);

    const call = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(call[0])).toBe('http://api.test/projects/p1/versions');
    expect(JSON.parse((call[1] as { body: string }).body)['baseVersion']).toBe(3);
  });

  it('turns a 409 into a conflict carrying the version to reload', async () => {
    // The number is the point: "someone else saved, reload?" needs something to reload *to*.
    answer(409, {
      error: 'somebody else saved this project since you loaded it (they are on version 7)',
    });

    await expect(new CloudProjects(session).save('p1', scene(), 3)).rejects.toBeInstanceOf(
      ConflictError,
    );

    try {
      await new CloudProjects(session).save('p1', scene(), 3);
    } catch (error) {
      expect((error as ConflictError).latestVersion).toBe(7);
    }
  });

  it('turns a 401 into something the editor can act on rather than a generic failure', async () => {
    answer(401, { error: 'that session is not valid' });
    await expect(new CloudProjects(session).load('p1')).rejects.toBeInstanceOf(NotSignedIn);
  });
});

describe('loading', () => {
  it('migrates and validates what came back', async () => {
    // A document off a wire is untrusted input too. The server validates on the way out; a client
    // that trusts a server it did not write breaks the day somebody stands up their own.
    answer(200, {
      project: {
        id: 'p1',
        organizationId: 'org',
        name: 'Broken',
        thumbnail: null,
        latestVersion: 1,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      scene: { sceneId: 'x', version: 1, objects: 'not an array' },
      version: 1,
    });

    await expect(new CloudProjects(session).load('p1')).rejects.toThrow(/could not be read/);
  });

  it('accepts a project that has never been saved', async () => {
    answer(200, {
      project: {
        id: 'p1',
        organizationId: 'org',
        name: 'Empty',
        thumbnail: null,
        latestVersion: 0,
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
      },
      scene: null,
      version: 0,
    });

    const loaded = await new CloudProjects(session).load('p1');
    expect(loaded.scene).toBeNull();
    expect(loaded.project.version).toBe(0);
  });
});

describe('deleting', () => {
  it('handles a 204 with no body', async () => {
    // A response that is correct must not be the one that throws.
    answer(204, null);
    await expect(new CloudProjects(session).remove('p1')).resolves.toBeUndefined();
  });
});

describe('being unreachable', () => {
  it('says the service may be down or may be blocking us, rather than guessing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject(new TypeError('failed'))),
    );
    await expect(new CloudProjects(session).list()).rejects.toThrow(
      /not be running.*not be allowing/s,
    );
  });
});
