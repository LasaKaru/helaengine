import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { roleAtLeast, type Role } from '@helaengine/schema';
import { createPool, migrate, reset, type Db } from './db.js';
import { LocalAssetStorage } from './assets.js';
import { createApiServer } from './server.js';

/**
 * Sprint 28 — accounts, organisations and role gating.
 *
 * Against a **real Postgres**, over **real HTTP**. Both matter: the constraints, the cascades and
 * the transaction boundaries are half the design here, and a mocked database would test the half
 * that is only code. The definition of done says "verified via integration test suite, not just
 * manual clicking", and this is what that has to mean.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ?? 'postgres://hela@localhost:5433/helaengine_test';

let db: Db;
let server: Server;
let origin: string;
let assetRoot: string;
const invites: Array<{ email: string; token: string }> = [];

/**
 * A fixed upload secret, so a test can forge a ticket and watch it be refused.
 *
 * The server generates one per process when none is given, which is the right default — a restart
 * invalidating every outstanding ticket is cheap and safe. It just makes "here is a signature you
 * did not issue" impossible to write from the outside.
 */
const UPLOAD_SECRET = 'a-test-upload-secret';

beforeAll(async () => {
  db = createPool(DATABASE_URL);
  await reset(db);
  await migrate(db);

  assetRoot = mkdtempSync(join(tmpdir(), 'hela-assets-test-'));

  server = createApiServer({
    db,
    storage: new LocalAssetStorage(assetRoot),
    uploadSecret: UPLOAD_SECRET,
    // Captured rather than logged, so a test can read the token the way a person would read their
    // inbox — without the test knowing anything about how invites are stored.
    sendInvite: (invite) => invites.push({ email: invite.email, token: invite.token }),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await db.end();
  rmSync(assetRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Truncated rather than dropped: each test starts from nothing, and rebuilding the schema per
  // test would make the suite slow enough that somebody stops running it.
  await db.query(
    'truncate sessions, invites, scene_versions, projects, memberships, organizations, users, assets cascade',
  );
  invites.length = 0;
});

interface Response<T> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<Response<T>> {
  const response = await fetch(`${origin}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  // 204 has no body by definition, and parsing one would fail on a response that is correct.
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
}

async function signup(
  email: string,
  displayName = 'Someone',
): Promise<{
  userId: string;
  token: string;
  personalOrganizationId: string;
}> {
  const created = await call<{
    user: { id: string };
    personalOrganizationId: string;
    session: { token: string };
  }>('POST', '/auth/signup', {
    body: { email, password: 'a-long-enough-password', displayName },
  });

  expect(created.status).toBe(201);
  return {
    userId: created.body.user.id,
    token: created.body.session.token,
    personalOrganizationId: created.body.personalOrganizationId,
  };
}

describe('signing up', () => {
  it('creates a personal workspace, owned by the new user', async () => {
    const { token, personalOrganizationId } = await signup('ada@example.com', 'Ada');

    const me = await call<{
      user: { email: string };
      organizations: Array<{ id: string; isPersonal: boolean; role: Role; name: string }>;
    }>('GET', '/me', { token });

    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('ada@example.com');
    expect(me.body.organizations).toHaveLength(1);

    const personal = me.body.organizations[0]!;
    expect(personal.id).toBe(personalOrganizationId);
    expect(personal.isPersonal).toBe(true);
    expect(personal.role).toBe('owner');
    expect(personal.name).toContain('Ada');
  });

  it('lower-cases the address, so one person cannot become two', async () => {
    await signup('Grace@Example.com');
    const again = await call('POST', '/auth/signup', {
      body: { email: 'grace@example.com', password: 'a-long-enough-password', displayName: 'G' },
    });
    expect(again.status).toBe(409);
  });

  it('refuses a password too short to be worth hashing', async () => {
    const weak = await call<{ error: string }>('POST', '/auth/signup', {
      body: { email: 'short@example.com', password: 'hunter2', displayName: 'S' },
    });
    expect(weak.status).toBe(400);
    expect(weak.body.error).toContain('password');
  });
});

describe('logging in', () => {
  it('exchanges credentials for a session', async () => {
    await signup('linus@example.com');
    const login = await call<{ session: { token: string } }>('POST', '/auth/login', {
      body: { email: 'linus@example.com', password: 'a-long-enough-password' },
    });

    expect(login.status).toBe(200);
    const me = await call('GET', '/me', { token: login.body.session.token });
    expect(me.status).toBe(200);
  });

  it('answers the same way for a wrong password and an unknown address', async () => {
    await signup('known@example.com');

    const wrongPassword = await call<{ error: string }>('POST', '/auth/login', {
      body: { email: 'known@example.com', password: 'not-the-password' },
    });
    const unknownUser = await call<{ error: string }>('POST', '/auth/login', {
      body: { email: 'nobody@example.com', password: 'not-the-password' },
    });

    // Identical status and identical message: anything else is an account-existence oracle.
    expect(wrongPassword.status).toBe(401);
    expect(unknownUser.status).toBe(401);
    expect(wrongPassword.body.error).toBe(unknownUser.body.error);
  });

  it('refuses a request with no session, and one with a made-up token', async () => {
    expect((await call('GET', '/me')).status).toBe(401);
    expect((await call('GET', '/me', { token: 'not-a-real-token' })).status).toBe(401);
  });
});

describe('organisations and invites', () => {
  it('invites a teammate by email and gives them the role they were offered', async () => {
    const owner = await signup('owner@example.com', 'Owner');
    const teammate = await signup('editor@example.com', 'Editor');

    const org = await call<{ organization: { id: string } }>('POST', '/orgs', {
      token: owner.token,
      body: { name: 'Goblin Valley Studios' },
    });
    expect(org.status).toBe(201);
    const organizationId = org.body.organization.id;

    const invited = await call('POST', `/orgs/${organizationId}/invites`, {
      token: owner.token,
      body: { email: 'editor@example.com', role: 'editor' },
    });
    expect(invited.status).toBe(201);

    // Read the way the recipient would: from what was sent to them.
    expect(invites).toHaveLength(1);
    const accepted = await call<{ membership: { role: Role } }>('POST', '/invites/accept', {
      token: teammate.token,
      body: { token: invites[0]!.token },
    });

    expect(accepted.status).toBe(200);
    expect(accepted.body.membership.role).toBe('editor');

    const members = await call<{ members: Array<{ email: string; role: Role }> }>(
      'GET',
      `/orgs/${organizationId}/members`,
      { token: owner.token },
    );
    expect(members.body.members.map((member) => member.role).sort()).toEqual(['editor', 'owner']);
  });

  it('refuses an invite accepted by the wrong person', async () => {
    const owner = await signup('boss@example.com');
    const intended = 'wanted@example.com';
    const someoneElse = await signup('gatecrasher@example.com');

    const org = await call<{ organization: { id: string } }>('POST', '/orgs', {
      token: owner.token,
      body: { name: 'Private' },
    });
    await call('POST', `/orgs/${org.body.organization.id}/invites`, {
      token: owner.token,
      body: { email: intended, role: 'editor' },
    });

    // An invite is addressed. Anyone who intercepts the link is still not the person it was for.
    const stolen = await call('POST', '/invites/accept', {
      token: someoneElse.token,
      body: { token: invites[0]!.token },
    });
    expect(stolen.status).toBe(403);
  });

  it('refuses a token that was already used, and one that never existed', async () => {
    const owner = await signup('reuse@example.com');
    const teammate = await signup('twice@example.com');
    const org = await call<{ organization: { id: string } }>('POST', '/orgs', {
      token: owner.token,
      body: { name: 'Once' },
    });
    await call('POST', `/orgs/${org.body.organization.id}/invites`, {
      token: owner.token,
      body: { email: 'twice@example.com', role: 'viewer' },
    });

    expect(
      (
        await call('POST', '/invites/accept', {
          token: teammate.token,
          body: { token: invites[0]!.token },
        })
      ).status,
    ).toBe(200);
    // Same answer as an unknown token: telling somebody "that one was already used" confirms it
    // was real.
    expect(
      (
        await call('POST', '/invites/accept', {
          token: teammate.token,
          body: { token: invites[0]!.token },
        })
      ).status,
    ).toBe(404);
    expect(
      (await call('POST', '/invites/accept', { token: teammate.token, body: { token: 'made-up' } }))
        .status,
    ).toBe(404);
  });

  it('will not let anyone invite somebody above their own rank', async () => {
    const owner = await signup('chief@example.com');
    const admin = await signup('admin@example.com');

    const org = await call<{ organization: { id: string } }>('POST', '/orgs', {
      token: owner.token,
      body: { name: 'Ladder' },
    });
    const organizationId = org.body.organization.id;

    await call('POST', `/orgs/${organizationId}/invites`, {
      token: owner.token,
      body: { email: 'admin@example.com', role: 'admin' },
    });
    await call('POST', '/invites/accept', {
      token: admin.token,
      body: { token: invites[0]!.token },
    });

    // Without this rule, an admin promotes a friend to owner and the ladder has a rung going up.
    const overreach = await call<{ error: string }>('POST', `/orgs/${organizationId}/invites`, {
      token: admin.token,
      body: { email: 'friend@example.com', role: 'owner' },
    });
    expect(overreach.status).toBe(403);
    expect(overreach.body.error).toContain('above your own');
  });
});

describe('role gating', () => {
  async function orgWith(role: Role): Promise<{ organizationId: string; token: string }> {
    const owner = await signup(`owner-${role}@example.com`);
    const member = await signup(`member-${role}@example.com`);

    const org = await call<{ organization: { id: string } }>('POST', '/orgs', {
      token: owner.token,
      body: { name: `Org for ${role}` },
    });
    const organizationId = org.body.organization.id;

    if (role !== 'owner') {
      await call('POST', `/orgs/${organizationId}/invites`, {
        token: owner.token,
        body: { email: `member-${role}@example.com`, role },
      });
      await call('POST', '/invites/accept', {
        token: member.token,
        body: { token: invites.at(-1)!.token },
      });
      return { organizationId, token: member.token };
    }
    return { organizationId, token: owner.token };
  }

  it('lets an editor create a project and refuses a viewer', async () => {
    const editor = await orgWith('editor');
    const created = await call('POST', `/orgs/${editor.organizationId}/projects`, {
      token: editor.token,
      body: { name: 'Goblin Valley' },
    });
    expect(created.status).toBe(201);

    const viewer = await orgWith('viewer');
    const refused = await call<{ error: string }>(
      'POST',
      `/orgs/${viewer.organizationId}/projects`,
      {
        token: viewer.token,
        body: { name: 'Not allowed' },
      },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.error).toContain('editor');
  });

  it('lets a viewer read the member list, because being in a room is not a privilege', async () => {
    const viewer = await orgWith('viewer');
    const members = await call('GET', `/orgs/${viewer.organizationId}/members`, {
      token: viewer.token,
    });
    expect(members.status).toBe(200);
  });

  it('answers 404, not 403, to somebody who is not a member at all', async () => {
    const inside = await orgWith('owner');
    const outsider = await signup('stranger@example.com');

    // 403 would confirm the organisation exists, which is a membership oracle for anyone willing
    // to guess ids.
    const peek = await call('GET', `/orgs/${inside.organizationId}/members`, {
      token: outsider.token,
    });
    expect(peek.status).toBe(404);
  });

  it('refuses an organisation id that is not a uuid without touching the database', async () => {
    const owner = await signup('shape@example.com');
    expect((await call('GET', '/orgs/not-a-uuid/members', { token: owner.token })).status).toBe(
      404,
    );
  });
});

describe('the role ladder itself', () => {
  it('orders roles the way the guard assumes', () => {
    // The guard is a comparison, so the ordering is load-bearing rather than documentation.
    expect(roleAtLeast('owner', 'editor')).toBe(true);
    expect(roleAtLeast('editor', 'owner')).toBe(false);
    expect(roleAtLeast('viewer', 'viewer')).toBe(true);
    // Added before anything uses it, on the plan's advice: an enum value now costs nothing, a
    // migration over live membership rows later costs a maintenance window.
    expect(roleAtLeast('enterprise_admin', 'owner')).toBe(true);
  });
});

describe('projects and cloud save', () => {
  async function workspace(): Promise<{ token: string; organizationId: string }> {
    const owner = await signup(`saver-${Math.random().toString(36).slice(2)}@example.com`);
    return { token: owner.token, organizationId: owner.personalOrganizationId };
  }

  function scene(name = 'Cloud Scene'): Record<string, unknown> {
    return {
      sceneId: 'scene_cloud',
      version: 1,
      name,
      objects: [{ id: 'obj_0001', assetId: 'tree_pine_01', transform: { position: [1, 0, 2] } }],
    };
  }

  it('saves from one session and reads back identically in another', async () => {
    // The definition of done, as a test: Browser A saves, Browser B logs in, sees the same thing.
    const { token, organizationId } = await workspace();
    const created = await call<{ project: { id: string; latestVersion: number } }>(
      'POST',
      `/orgs/${organizationId}/projects`,
      { token, body: { name: 'Goblin Valley', scene: scene() } },
    );
    expect(created.status).toBe(201);
    expect(created.body.project.latestVersion).toBe(1);

    // A different session for the same account — a second browser, not a second user.
    const second = await call<{ session: { token: string } }>('POST', '/auth/login', {
      body: {
        email: (await call<{ user: { email: string } }>('GET', '/me', { token })).body.user.email,
        password: 'a-long-enough-password',
      },
    });

    const loaded = await call<{ scene: { name: string; objects: unknown[] }; version: number }>(
      'GET',
      `/projects/${created.body.project.id}`,
      { token: second.body.session.token },
    );

    expect(loaded.status).toBe(200);
    expect(loaded.body.version).toBe(1);
    expect(loaded.body.scene.name).toBe('Cloud Scene');
    expect(loaded.body.scene.objects).toHaveLength(1);
  });

  it('refuses a document the schema does not accept, before it is stored', async () => {
    const { token, organizationId } = await workspace();
    // Server-side validation with the same package the editor uses. A document only the client
    // checked is a document nobody checked.
    const bad = await call<{ error: string }>('POST', `/orgs/${organizationId}/projects`, {
      token,
      body: { name: 'Broken', scene: { sceneId: 'x', version: 1, objects: 'not an array' } },
    });
    expect(bad.status).toBe(400);
  });

  it('builds history by appending, and never rewrites it', async () => {
    const { token, organizationId } = await workspace();
    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${organizationId}/projects`,
      {
        token,
        body: { name: 'History', scene: scene('v1') },
      },
    );
    const projectId = created.body.project.id;

    for (let version = 2; version <= 12; version += 1) {
      const saved = await call<{ version: number }>('POST', `/projects/${projectId}/versions`, {
        token,
        body: { scene: scene(`v${version}`), baseVersion: version - 1 },
      });
      expect(saved.status).toBe(201);
      expect(saved.body.version).toBe(version);
    }

    const history = await call<{ versions: Array<{ version: number; authorName: string }> }>(
      'GET',
      `/projects/${projectId}/versions`,
      { token },
    );
    expect(history.body.versions).toHaveLength(12);
    expect(history.body.versions[0]!.version).toBe(12);
    expect(history.body.versions[0]!.authorName).toBeTruthy();
  });

  it('restores an old version by adding a new one, leaving the history intact', async () => {
    const { token, organizationId } = await workspace();
    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${organizationId}/projects`,
      {
        token,
        body: { name: 'Restore', scene: scene('the good one') },
      },
    );
    const projectId = created.body.project.id;

    await call('POST', `/projects/${projectId}/versions`, {
      token,
      body: { scene: scene('the mistake'), baseVersion: 1 },
    });

    const restored = await call<{ version: number; scene: { name: string } }>(
      'POST',
      `/projects/${projectId}/versions/1/restore`,
      { token },
    );

    // Version 3, holding version 1's content. Undoing a mistake must not be able to become a
    // second, larger mistake.
    expect(restored.status).toBe(201);
    expect(restored.body.version).toBe(3);
    expect(restored.body.scene.name).toBe('the good one');

    const history = await call<{ versions: Array<{ version: number }> }>(
      'GET',
      `/projects/${projectId}/versions`,
      { token },
    );
    expect(history.body.versions.map((entry) => entry.version)).toEqual([3, 2, 1]);
  });

  it('rejects a save based on a version somebody else has already moved past', async () => {
    const { token, organizationId } = await workspace();
    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${organizationId}/projects`,
      {
        token,
        body: { name: 'Race', scene: scene() },
      },
    );
    const projectId = created.body.project.id;

    // Two editors both loaded version 1. The first save wins.
    const first = await call('POST', `/projects/${projectId}/versions`, {
      token,
      body: { scene: scene('theirs'), baseVersion: 1 },
    });
    expect(first.status).toBe(201);

    const second = await call<{ error: string; latestVersion?: number }>(
      'POST',
      `/projects/${projectId}/versions`,
      { token, body: { scene: scene('mine'), baseVersion: 1 } },
    );

    // 409 with the number the editor needs to say "someone else saved, reload?".
    expect(second.status).toBe(409);
    expect(second.body.error).toContain('version 2');
  });

  it('will not let two simultaneous saves both claim to be next', async () => {
    const { token, organizationId } = await workspace();
    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${organizationId}/projects`,
      {
        token,
        body: { name: 'Simultaneous', scene: scene() },
      },
    );
    const projectId = created.body.project.id;

    // Fired together rather than in sequence: the guard has to be in the insert, not in a read
    // followed by a write, or both requests see the same maximum and both think they are next.
    const [a, b] = await Promise.all([
      call('POST', `/projects/${projectId}/versions`, {
        token,
        body: { scene: scene('a'), baseVersion: 1 },
      }),
      call('POST', `/projects/${projectId}/versions`, {
        token,
        body: { scene: scene('b'), baseVersion: 1 },
      }),
    ]);

    expect([a.status, b.status].sort()).toEqual([201, 409]);
  });

  it('requires a save to say what it was based on', async () => {
    const { token, organizationId } = await workspace();
    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${organizationId}/projects`,
      {
        token,
        body: { name: 'Blind', scene: scene() },
      },
    );

    const blind = await call<{ error: string }>(
      'POST',
      `/projects/${created.body.project.id}/versions`,
      {
        token,
        body: { scene: scene() },
      },
    );
    // A save with no base silently wins every race, which is the opposite of the point.
    expect(blind.status).toBe(400);
    expect(blind.body.error).toContain('baseVersion');
  });

  it('hides a deleted project without destroying it', async () => {
    const { token, organizationId } = await workspace();
    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${organizationId}/projects`,
      {
        token,
        body: { name: 'Doomed', scene: scene() },
      },
    );
    const projectId = created.body.project.id;

    expect((await call('DELETE', `/projects/${projectId}`, { token })).status).toBe(204);
    expect((await call('GET', `/projects/${projectId}`, { token })).status).toBe(404);

    const listed = await call<{ projects: unknown[] }>('GET', `/orgs/${organizationId}/projects`, {
      token,
    });
    expect(listed.body.projects).toHaveLength(0);
  });

  it('keeps one organisation out of another, even with the right project id', async () => {
    const mine = await workspace();
    const stranger = await signup('nosy@example.com');

    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${mine.organizationId}/projects`,
      {
        token: mine.token,
        body: { name: 'Private', scene: scene() },
      },
    );

    // A project id in a URL is not an authorisation. Treating it as one is how tenants leak.
    const peek = await call('GET', `/projects/${created.body.project.id}`, {
      token: stranger.token,
    });
    expect(peek.status).toBe(404);
  });
});

/**
 * Sprint 30 — assets that belong to somebody.
 *
 * Two things are being checked here that a unit test could not reach. The first is the upload
 * *path*: a ticket issued by one route, spent against another that runs before authentication, with
 * the signature as the only thing standing between a stranger and somebody else's storage. The
 * second is the boundary between the curated library and a customer's own — one table, one query,
 * and a `where` clause that is the entire tenant isolation for assets.
 */
describe('assets', () => {
  async function workspace(): Promise<{
    token: string;
    organizationId: string;
    userId: string;
  }> {
    const owner = await signup(`uploader-${Math.random().toString(36).slice(2)}@example.com`);
    return {
      token: owner.token,
      organizationId: owner.personalOrganizationId,
      userId: owner.userId,
    };
  }

  /** Bytes that start the way a binary glTF starts: magic, version 2, and a length. */
  function glb(payload = 'hela'): Uint8Array<ArrayBuffer> {
    const body = Buffer.from(payload, 'utf8');
    const bytes = new Uint8Array(12 + body.byteLength);
    const view = new DataView(bytes.buffer);

    bytes.set(Buffer.from('glTF', 'ascii'), 0);
    view.setUint32(4, 2, true);
    view.setUint32(8, bytes.byteLength, true);
    bytes.set(body, 12);
    return bytes;
  }

  interface UploadGrant {
    asset: { id: string; assetId: string; status: string };
    upload: { url: string; maxBytes: number; ticket: { expiresAt: number; signature: string } };
  }

  async function requestUpload(
    token: string,
    organizationId: string,
    body: Record<string, unknown>,
  ): Promise<Response<UploadGrant & { error?: string }>> {
    return call<UploadGrant & { error?: string }>('POST', `/orgs/${organizationId}/assets`, {
      token,
      body,
    });
  }

  /** Sends raw bytes to a presigned URL. No session header — the ticket is the authorisation. */
  async function put(
    url: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<{ status: number; body: { asset?: { status: string; failure: string | null } } }> {
    const response = await fetch(`${origin}${url}`, {
      method: 'PUT',
      headers: { 'content-type': 'model/gltf-binary' },
      // Wrapped in a Blob because `fetch`'s body type does not include a bare `Uint8Array` — the
      // bytes on the wire are identical either way.
      body: new Blob([bytes]),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }

  it('takes an upload through pending to ready, and serves the bytes back', async () => {
    const { token, organizationId } = await workspace();

    const granted = await requestUpload(token, organizationId, {
      assetId: 'my_statue',
      name: 'Stone Statue',
      category: 'props',
    });
    expect(granted.status).toBe(201);
    // Pending immediately, so the panel has a row to draw a spinner against rather than nothing
    // until the bytes land.
    expect(granted.body.asset.status).toBe('pending');
    expect(granted.body.upload.url).toContain('signature=');

    const bytes = glb('a statue');
    const sent = await put(granted.body.upload.url, bytes);
    expect(sent.status).toBe(200);
    expect(sent.body.asset?.status).toBe('ready');

    const listed = await call<{
      assets: Array<{ assetId: string; status: string; glbPath: string; sizeBytes: number }>;
    }>('GET', `/orgs/${organizationId}/assets`, { token });
    const mine = listed.body.assets.find((asset) => asset.assetId === 'my_statue');
    expect(mine?.status).toBe('ready');
    expect(mine?.sizeBytes).toBe(bytes.byteLength);

    // The path is content-addressed, and the bytes come back byte-for-byte.
    expect(mine?.glbPath).toMatch(new RegExp(`^orgs/${organizationId}/assets/[0-9a-f]{32}\\.glb$`));
    const fetched = await fetch(`${origin}/assets/${mine!.glbPath}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get('content-type')).toBe('model/gltf-binary');
    // Forever, because a different upload can never land on this URL — that is what makes the
    // header safe and what would let a CDN in front of this need no invalidation.
    expect(fetched.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(bytes);
  });

  it('serves the bytes without a session, because a CDN has none', async () => {
    const { token, organizationId } = await workspace();
    const granted = await requestUpload(token, organizationId, { assetId: 'public_rock' });
    await put(granted.body.upload.url, glb('rock'));

    const listed = await call<{ assets: Array<{ assetId: string; glbPath: string }> }>(
      'GET',
      `/orgs/${organizationId}/assets`,
      { token },
    );
    const path = listed.body.assets.find((a) => a.assetId === 'public_rock')!.glbPath;

    // Deliberately no authorization header. The protection is that the hash in the path is not
    // guessable — the same bargain the share service makes for an unlisted build, stated in the
    // route's own comment and worth a test so it stays a decision rather than an accident.
    const anonymous = await fetch(`${origin}/assets/${path}`);
    expect(anonymous.status).toBe(200);
  });

  it('answers the preflight a browser sends before an upload', async () => {
    // Found by driving a browser, not by reading the code. `model/gltf-binary` is not a
    // CORS-safelisted content type, so the upload is preflighted — and an `allow-methods` without
    // PUT turns the whole feature into "Failed to fetch" with the row stuck on "Processing…",
    // while every server-side test passes. The same shape of bug as Sprint 27's missing preflight.
    const preflight = await fetch(`${origin}/uploads/x/y`, {
      method: 'OPTIONS',
      headers: {
        origin: 'http://127.0.0.1:5174',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type',
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('PUT');
    expect(preflight.headers.get('access-control-allow-headers')).toContain('content-type');
  });

  it('refuses a file that is not a binary glTF, and says which file', async () => {
    const { token, organizationId } = await workspace();
    const granted = await requestUpload(token, organizationId, { assetId: 'not_a_model' });

    // A PNG renamed to .glb. The extension is a claim the uploader makes; the magic bytes are a
    // fact about the file.
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const sent = await put(granted.body.upload.url, png);

    expect(sent.status).toBe(422);
    expect(sent.body.asset?.status).toBe('failed');
    expect(sent.body.asset?.failure).toContain('binary glTF');

    // Recorded, not discarded: the panel shows this sentence next to the asset, and a refresh must
    // not turn a failure into a row that is silently missing.
    const listed = await call<{ assets: Array<{ assetId: string; failure: string | null }> }>(
      'GET',
      `/orgs/${organizationId}/assets`,
      { token },
    );
    expect(listed.body.assets.find((a) => a.assetId === 'not_a_model')?.failure).toContain(
      'binary glTF',
    );
  });

  it('refuses an empty file', async () => {
    const { token, organizationId } = await workspace();
    const granted = await requestUpload(token, organizationId, { assetId: 'nothing_at_all' });

    const sent = await put(granted.body.upload.url, new Uint8Array(0));
    expect(sent.status).toBe(422);
    expect(sent.body.asset?.failure).toContain('empty');
  });

  it('refuses a forged signature', async () => {
    const { token, organizationId } = await workspace();
    const granted = await requestUpload(token, organizationId, { assetId: 'stolen_model' });

    const forged = granted.body.upload.url.replace(
      /signature=[0-9a-f]+/,
      `signature=${'f'.repeat(64)}`,
    );
    const sent = await put(forged, glb());
    expect(sent.status).toBe(403);

    // And a signature of the wrong *length*, which is the case that would throw out of
    // `timingSafeEqual` rather than compare false if the length were not checked first.
    const short = granted.body.upload.url.replace(/signature=[0-9a-f]+/, 'signature=ab');
    expect((await put(short, glb())).status).toBe(403);

    const stillPending = await call<{ assets: Array<{ assetId: string; status: string }> }>(
      'GET',
      `/orgs/${organizationId}/assets`,
      { token },
    );
    expect(stillPending.body.assets.find((a) => a.assetId === 'stolen_model')?.status).toBe(
      'pending',
    );
  });

  it('refuses an expired ticket, even a correctly signed one', async () => {
    const { token, organizationId } = await workspace();
    // The row has to exist, or a 404 from `completeUpload` would pass this test for the wrong
    // reason — the point is that the ticket is refused before the row is ever looked at.
    expect((await requestUpload(token, organizationId, { assetId: 'too_late' })).status).toBe(201);

    // Signed with the real secret, for a moment that has passed. Changing `expires` alone would
    // break the signature, so the ticket is re-signed for the earlier time — which is exactly what
    // somebody replaying a ticket they found in a log cannot do.
    const expiresAt = Date.now() - 1000;
    const signature = createHmac('sha256', UPLOAD_SECRET)
      .update(`${organizationId}:too_late:${expiresAt}`)
      .digest('hex');

    const sent = await put(
      `/uploads/${organizationId}/too_late?expires=${expiresAt}&signature=${signature}`,
      glb(),
    );
    expect(sent.status).toBe(403);
  });

  it('will not let a ticket for one organisation write into another', async () => {
    const mine = await workspace();
    const stranger = await workspace();

    const granted = await requestUpload(mine.token, mine.organizationId, { assetId: 'my_model' });

    // The organisation is inside the signature, so swapping it in the path invalidates the ticket.
    // If it were only a path segment, one valid ticket would be a write into every tenant.
    const crossed = granted.body.upload.url.replace(mine.organizationId, stranger.organizationId);
    expect((await put(crossed, glb())).status).toBe(403);
  });

  it('keeps one organisation out of another organisation library', async () => {
    const mine = await workspace();
    const stranger = await workspace();

    const granted = await requestUpload(mine.token, mine.organizationId, {
      assetId: 'secret_boss',
    });
    await put(granted.body.upload.url, glb('a boss'));

    // Reading somebody else's library needs membership in it, and an organisation id in a URL is
    // not membership.
    const peek = await call('GET', `/orgs/${mine.organizationId}/assets`, {
      token: stranger.token,
    });
    expect(peek.status).toBe(404);

    // And their own library does not contain it either — the isolation is in the query, not only
    // in the route guard.
    const theirs = await call<{ assets: Array<{ assetId: string }> }>(
      'GET',
      `/orgs/${stranger.organizationId}/assets`,
      { token: stranger.token },
    );
    expect(theirs.body.assets.map((a) => a.assetId)).not.toContain('secret_boss');
  });

  it('shows the curated library to everyone and pending rows to nobody else', async () => {
    const mine = await workspace();
    const stranger = await workspace();

    // A curated asset: no organisation, so it belongs to the product rather than to a customer.
    await db.query(
      `insert into assets (organization_id, asset_id, name, category, glb_path, status)
       values (null, 'tree_pine_01', 'Pine Tree', 'trees', 'models/tree_pine_01.glb', 'ready')`,
    );

    const granted = await requestUpload(mine.token, mine.organizationId, { assetId: 'wip_model' });
    expect(granted.status).toBe(201);

    const forMe = await call<{ assets: Array<{ assetId: string; organizationId: string | null }> }>(
      'GET',
      `/orgs/${mine.organizationId}/assets`,
      { token: mine.token },
    );
    // Both kinds in one list, which is the point of one table: the library panel gets a single
    // answer to "what can I place" rather than merging two.
    expect(forMe.body.assets.map((a) => a.assetId)).toEqual(['tree_pine_01', 'wip_model']);
    expect(forMe.body.assets[0]!.organizationId).toBeNull();

    const forThem = await call<{ assets: Array<{ assetId: string }> }>(
      'GET',
      `/orgs/${stranger.organizationId}/assets`,
      { token: stranger.token },
    );
    // The curated one, and not a half-uploaded asset belonging to somebody else.
    expect(forThem.body.assets.map((a) => a.assetId)).toEqual(['tree_pine_01']);
  });

  it('filters by category, using the same closed vocabulary the manifest does', async () => {
    const { token, organizationId } = await workspace();

    await put(
      (await requestUpload(token, organizationId, { assetId: 'oak_one', category: 'trees' })).body
        .upload.url,
      glb('oak'),
    );
    await put(
      (await requestUpload(token, organizationId, { assetId: 'crate_one', category: 'props' })).body
        .upload.url,
      glb('crate'),
    );

    const trees = await call<{ assets: Array<{ assetId: string }> }>(
      'GET',
      `/orgs/${organizationId}/assets?category=trees`,
      { token },
    );
    expect(trees.body.assets.map((a) => a.assetId)).toEqual(['oak_one']);

    // A category the schema does not know is refused at the door rather than stored. An asset in
    // an unknown category is a card the panel can draw and no filter can ever reach.
    const invented = await requestUpload(token, organizationId, {
      assetId: 'weird_one',
      category: 'spaceships',
    });
    expect(invented.status).toBe(400);
    expect(invented.body.error).toContain('category');
  });

  it('holds an asset id to the shape the curated library uses', async () => {
    const { token, organizationId } = await workspace();

    // The id becomes a storage key and goes into every scene that places the asset. "My Model.glb"
    // as an id is a path traversal waiting to be discovered.
    for (const assetId of ['My Model', '../escape', 'ab', 'x'.repeat(61), '']) {
      const refused = await requestUpload(token, organizationId, { assetId });
      expect(refused.status, `expected "${assetId}" to be refused`).toBe(400);
    }
  });

  it('lets an upload be retried without leaving the first attempt behind', async () => {
    const { token, organizationId } = await workspace();

    const first = await requestUpload(token, organizationId, { assetId: 'retry_me' });
    expect((await put(first.body.upload.url, new Uint8Array([1, 2, 3]))).status).toBe(422);

    // The same id again. It reuses the row rather than colliding with it — otherwise a failed
    // upload would make that name unusable forever.
    const second = await requestUpload(token, organizationId, {
      assetId: 'retry_me',
      name: 'Second Go',
    });
    expect(second.status).toBe(201);
    expect(second.body.asset.status).toBe('pending');
    expect((await put(second.body.upload.url, glb('this time'))).status).toBe(200);

    const listed = await call<{
      assets: Array<{ assetId: string; status: string; name: string; failure: string | null }>;
    }>('GET', `/orgs/${organizationId}/assets`, { token });
    const rows = listed.body.assets.filter((a) => a.assetId === 'retry_me');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('ready');
    expect(rows[0]!.name).toBe('Second Go');
    // The old reason is cleared, not left to be shown beside a working asset.
    expect(rows[0]!.failure).toBeNull();
  });

  it('needs editor to upload, and viewer to look', async () => {
    const owner = await signup('asset-owner@example.com');
    const viewer = await signup('asset-viewer@example.com');

    const org = await call<{ organization: { id: string } }>('POST', '/orgs', {
      token: owner.token,
      body: { name: 'Studio' },
    });
    const organizationId = org.body.organization.id;

    await call('POST', `/orgs/${organizationId}/invites`, {
      token: owner.token,
      body: { email: 'asset-viewer@example.com', role: 'viewer' },
    });
    await call('POST', '/invites/accept', {
      token: viewer.token,
      body: { token: invites.at(-1)!.token },
    });

    // A viewer can see the library — they have to, to open a scene that places these assets.
    expect(
      (await call('GET', `/orgs/${organizationId}/assets`, { token: viewer.token })).status,
    ).toBe(200);

    // But uploading is making something, which is what editor is for.
    const refused = await requestUpload(viewer.token, organizationId, { assetId: 'sneaky_model' });
    expect(refused.status).toBe(403);
  });

  it('deletes an asset, and refuses to delete somebody else', async () => {
    const mine = await workspace();
    const stranger = await workspace();

    await put(
      (await requestUpload(mine.token, mine.organizationId, { assetId: 'doomed_model' })).body
        .upload.url,
      glb('doomed'),
    );

    // A stranger asking to delete it gets the answer they would get for an organisation that does
    // not exist, which is also the answer that tells them nothing.
    expect(
      (
        await call('DELETE', `/orgs/${mine.organizationId}/assets/doomed_model`, {
          token: stranger.token,
        })
      ).status,
    ).toBe(404);

    expect(
      (
        await call('DELETE', `/orgs/${mine.organizationId}/assets/doomed_model`, {
          token: mine.token,
        })
      ).status,
    ).toBe(204);

    const listed = await call<{ assets: Array<{ assetId: string }> }>(
      'GET',
      `/orgs/${mine.organizationId}/assets`,
      { token: mine.token },
    );
    expect(listed.body.assets.map((a) => a.assetId)).not.toContain('doomed_model');
  });

  it('refuses a file past the size limit while it is still arriving', async () => {
    const { token, organizationId } = await workspace();
    const granted = await requestUpload(token, organizationId, { assetId: 'enormous_model' });

    const tooBig = new Uint8Array(granted.body.upload.maxBytes + 1024);
    tooBig.set(Buffer.from('glTF', 'ascii'));

    // 413 rather than a 500 from an unhandled throw: the client shows this to somebody who picked
    // the wrong file, and "the API failed to handle this request" is not that sentence.
    const sent = await put(granted.body.upload.url, tooBig);
    expect(sent.status).toBe(413);
  });
});
