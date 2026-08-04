import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SMOKE_CHECK_ORDER, type PublishRequest, type SmokeReport } from '@helaengine/schema';
import { createShareServer } from './server.js';
import { ShareStore } from './store.js';

/**
 * Sprint 27 — the share service.
 *
 * Driven over real HTTP against a real listening server, because most of what is being tested is
 * about *requests*: what a caller may publish, what a caller may read, and what the difference
 * between "does not exist" and "you may not see it" looks like from outside.
 */

const ORG_TOKEN = 'a-shared-secret-for-now';

let server: Server;
let origin: string;
let store: ShareStore;

beforeAll(async () => {
  store = new ShareStore({ root: mkdtempSync(join(tmpdir(), 'hela-share-')), orgToken: ORG_TOKEN });
  server = createShareServer({ store });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
});

function report(overrides: Partial<SmokeReport> = {}): SmokeReport {
  return {
    buildId: 'b',
    sceneName: 'Scene',
    passed: true,
    checks: SMOKE_CHECK_ORDER.map((id) => ({
      id,
      status: 'passed' as const,
      detail: 'fine',
      evidence: {},
      durationMs: 1,
    })),
    errors: [],
    startedAt: new Date(0).toISOString(),
    durationMs: 1,
    ...overrides,
  };
}

function build(overrides: Partial<PublishRequest> = {}): PublishRequest {
  return {
    sceneName: 'Test Scene',
    visibility: 'unlisted',
    report: report(),
    files: [
      { path: 'index.html', text: '<!doctype html><title>Game</title><canvas></canvas>' },
      { path: 'scene.json', text: '{"sceneId":"s"}' },
    ],
    ...overrides,
  };
}

async function publish(
  body: PublishRequest,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${origin}/api/builds`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

describe('publishing', () => {
  it('accepts a validated build and hands back a link', async () => {
    const { status, json } = await publish(build());
    expect(status).toBe(201);

    const url = json['url'] as string;
    expect(url).toContain('/play/');

    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('<canvas>');
  });

  it('refuses a build that did not pass its checks', async () => {
    // The gate reaching one step further. Sprint 26 stopped an unvalidated build being downloaded;
    // this stops one being *hosted*, which is worse — a bad download is one person's afternoon.
    const failing = report({
      passed: false,
      checks: SMOKE_CHECK_ORDER.map((id) => ({
        id,
        status: id === 'player-moves' ? ('failed' as const) : ('passed' as const),
        detail: 'the player did not move',
        evidence: {},
        durationMs: 1,
      })),
    });

    const { status, json } = await publish(build({ report: failing }));
    expect(status).toBe(400);
    expect(json['error']).toContain('pre-delivery checks');
  });

  it('refuses a build whose report claims a pass it did not earn', async () => {
    // `passed: true` with a skipped check. A client that lies has to be caught by the rule rather
    // than by the flag, which is exactly why `isReleasable` looks at the checks and not the boolean.
    const lying = report({
      checks: SMOKE_CHECK_ORDER.map((id) => ({
        id,
        status: id === 'player-moves' ? ('skipped' as const) : ('passed' as const),
        detail: 'not run',
        evidence: {},
        durationMs: 1,
      })),
    });

    expect((await publish(build({ report: lying }))).status).toBe(400);
  });

  it('refuses a file that would be written outside the build', async () => {
    const escaping = build({ files: [{ path: '../../etc/passwd', text: 'nope' }] });
    const { status, json } = await publish(escaping);

    // 400, not 500: a request that does not match the schema is the caller's mistake, and telling
    // them the server broke invites them to retry something that will never work.
    expect(status).toBe(400);
    expect(json['error']).toContain('files.0.path');
  });

  it('answers malformed JSON with a sentence rather than a stack trace', async () => {
    const response = await fetch(`${origin}/api/builds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain('valid JSON');
  });

  it('refuses org sharing when the server has no token configured', async () => {
    const open = new ShareStore({ root: mkdtempSync(join(tmpdir(), 'hela-share-open-')) });
    expect(() => open.publish(build({ visibility: 'org' }))).toThrow(/not configured/);
  });
});

describe('who can see what', () => {
  it('lists public builds and does not list unlisted ones', async () => {
    const shared = await publish(build({ sceneName: 'Listed', visibility: 'public' }));
    const hidden = await publish(build({ sceneName: 'Hidden', visibility: 'unlisted' }));
    expect(shared.status).toBe(201);

    const listing = (await (await fetch(`${origin}/api/builds`)).json()) as {
      builds: Array<{ id: string; sceneName: string }>;
    };

    expect(listing.builds.some((entry) => entry.sceneName === 'Listed')).toBe(true);
    // A listing that returns unlisted builds is a listing that makes "unlisted" a lie.
    expect(listing.builds.some((entry) => entry.sceneName === 'Hidden')).toBe(false);

    // And the unlisted one is still reachable by its id, which is the whole point of it.
    const url = hidden.json['url'] as string;
    expect((await fetch(url)).status).toBe(200);
  });

  it('hides an org build from anyone without the token, and does not admit it exists', async () => {
    const { json } = await publish(build({ visibility: 'org' }));
    const id = (json['build'] as { id: string }).id;

    const anonymous = await fetch(`${origin}/api/builds/${id}`);
    expect(anonymous.status).toBe(404);

    const withToken = await fetch(`${origin}/api/builds/${id}`, {
      headers: { 'x-hela-org-token': ORG_TOKEN },
    });
    expect(withToken.status).toBe(200);

    // 404 rather than 403 for the wrong token too: distinguishing them turns this into an oracle
    // for which builds are real.
    const wrongToken = await fetch(`${origin}/api/builds/${id}`, {
      headers: { 'x-hela-org-token': 'not-it' },
    });
    expect(wrongToken.status).toBe(404);
  });

  it('never serves its own metadata as part of a build', async () => {
    const { json } = await publish(build());
    const id = (json['build'] as { id: string }).id;

    for (const path of ['.hela-meta.json', '.hela-report.json']) {
      expect((await fetch(`${origin}/play/${id}/${path}`)).status).toBe(404);
    }
  });

  it('serves a build from a store whose own directory starts with a dot', () => {
    // The default storage directory is `.hela-shared`, and a guard written as
    // `path.includes('/.hela-')` is true of *every* file underneath it. The service served nothing
    // at all, and every test here missed it by using a temp directory without the leading dot.
    const dotted = new ShareStore({
      root: join(mkdtempSync(join(tmpdir(), 'x-')), '.hela-shared'),
    });
    const published = dotted.publish(build());

    expect(dotted.fileFor(published.id, '/')).not.toBeNull();
    expect(dotted.fileFor(published.id, '/index.html')).not.toBeNull();
    // And the metadata is still not served, which is what the guard was for.
    expect(dotted.fileFor(published.id, '/.hela-meta.json')).toBeNull();
  });

  it('refuses an id that is not the shape this service mints', async () => {
    // Ids are used as path segments, so anything not matching is not looked up at all.
    expect((await fetch(`${origin}/play/..%2f..%2fetc/index.html`)).status).toBe(404);
    expect((await fetch(`${origin}/api/builds/not-an-id`)).status).toBe(404);
  });
});

describe('being reachable from the editor at all', () => {
  it('answers a preflight, and says who may call it', async () => {
    // The editor runs on a different port, so every publish is cross-origin and preflighted. The
    // first version of this service answered neither, and the editor reported it as unreachable
    // while it was running perfectly.
    const preflight = await fetch(`${origin}/api/builds`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:5174',
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');
  });
});

describe('play counts', () => {
  it('counts the page being opened, not every file it asks for', async () => {
    const { json } = await publish(build());
    const id = (json['build'] as { id: string }).id;

    await fetch(`${origin}/play/${id}/`);
    await fetch(`${origin}/play/${id}/scene.json`);
    await fetch(`${origin}/play/${id}/scene.json`);

    const meta = (await (await fetch(`${origin}/api/builds/${id}`)).json()) as {
      build: { plays: number; lastPlayedAt: string | null };
    };

    // Otherwise "plays" is really "requests", and a build with more models looks more popular.
    expect(meta.build.plays).toBe(1);
    expect(meta.build.lastPlayedAt).not.toBeNull();
  });
});

describe('caching', () => {
  it('lets a shared cache keep a public build and never an unlisted one', async () => {
    const open = await publish(build({ visibility: 'public' }));
    const secret = await publish(build({ visibility: 'unlisted' }));

    const openHeaders = (await fetch(open.json['url'] as string)).headers.get('cache-control');
    const secretHeaders = (await fetch(secret.json['url'] as string)).headers.get('cache-control');

    expect(openHeaders).toContain('public');
    // An unlisted build's URL is its only protection, and a proxy holding a copy is a copy nobody
    // can withdraw.
    expect(secretHeaders).toContain('no-store');
  });
});
