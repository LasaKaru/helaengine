import type { Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { roleAtLeast, type Role } from '@helaengine/schema';
import {
  createLogger,
  serviceMetrics,
  startTelemetry,
  type ServiceMetrics,
  type SpanRecord,
} from '@helaengine/telemetry';
import { createPool, migrate, reset, type Db } from './db.js';
import { LocalAssetStorage } from './assets.js';
import { hashToken, pruneExpiredCredentials } from './auth.js';
import { expiredArtifacts, forgetArtifact } from './exportJobs.js';
import { createApiServer } from './server.js';
import { Throttle } from './throttle.js';
import { LocalBilling } from './billingProvider.js';
import { routePattern } from './observability.js';

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
let storage: LocalAssetStorage;
let exportStorage: LocalAssetStorage;
const invites: Array<{ email: string; token: string }> = [];

/**
 * A fixed upload secret, so a test can forge a ticket and watch it be refused.
 *
 * The server generates one per process when none is given, which is the right default — a restart
 * invalidating every outstanding ticket is cheap and safe. It just makes "here is a signature you
 * did not issue" impossible to write from the outside.
 */
const UPLOAD_SECRET = 'a-test-upload-secret';

/** The token `/metrics` asks for, so the suite can check both sides of that door. */
const METRICS_TOKEN = 'a-test-metrics-token';

/**
 * Real telemetry, into a real file and a real registry (Sprint 33).
 *
 * The alternative — a spy tracer — would confirm that the server calls a tracer, which is not the
 * claim anybody cares about. The claim is that a request produces a span, carrying a correlation
 * id, that an operator can find later; so the suite reads the same NDJSON file `tools/trace` does.
 */
let metrics: ServiceMetrics;
let telemetry: ReturnType<typeof startTelemetry>;
let tracePath: string;
const logged: string[] = [];

beforeAll(async () => {
  db = createPool(DATABASE_URL);
  await reset(db);
  await migrate(db);

  assetRoot = mkdtempSync(join(tmpdir(), 'hela-assets-test-'));

  storage = new LocalAssetStorage(assetRoot);
  exportStorage = new LocalAssetStorage(join(assetRoot, 'exports-store'));

  tracePath = join(assetRoot, 'spans.ndjson');
  telemetry = startTelemetry({ serviceName: 'helaengine-api', tracePath });
  metrics = serviceMetrics();

  server = createApiServer({
    db,
    storage,
    exportStorage,
    uploadSecret: UPLOAD_SECRET,
    /**
     * Effectively no rate limiting for the suite.
     *
     * The limits are real and tested — see "guessing costs something" below, which stands up its
     * own server with strict ones. This suite signs up dozens of accounts from one address in
     * seconds, which is exactly the shape the production limit exists to refuse, so the harness
     * opts out rather than the product being lenient.
     */
    throttles: {
      loginByAddress: new Throttle({ limit: 100_000, windowMs: 1000 }),
      loginByAccount: new Throttle({ limit: 100_000, windowMs: 1000 }),
      signupByAddress: new Throttle({ limit: 100_000, windowMs: 1000 }),
      inviteByAddress: new Throttle({ limit: 100_000, windowMs: 1000 }),
    },
    telemetry: {
      tracer: telemetry.tracer,
      metrics,
      // Kept rather than printed: the suite asserts on what the API logged, and a hundred request
      // lines on the console would drown the one failure worth reading.
      log: createLogger({ service: 'api', level: 'debug', write: (line) => logged.push(line) }),
      metricsToken: METRICS_TOKEN,
    },
    // Captured rather than logged, so a test can read the token the way a person would read their
    // inbox — without the test knowing anything about how invites are stored.
    sendInvite: (invite) => invites.push({ email: invite.email, token: invite.token }),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await telemetry.shutdown();
  await db.end();
  rmSync(assetRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  // Truncated rather than dropped: each test starts from nothing, and rebuilding the schema per
  // test would make the suite slow enough that somebody stops running it.
  await db.query(
    'truncate audit_log, sessions, invites, export_jobs, scene_versions, projects, memberships, organizations, users, assets cascade',
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

/**
 * Puts an organisation on a paid plan, the way an operator or a completed checkout would.
 *
 * Sprint 35 made several things paid features — custom asset uploads most visibly — so tests that
 * exercise them have to say which plan they are on. That is not test scaffolding around an
 * inconvenience; it is the product being explicit about what a free account can do, and the tests
 * saying so out loud is an improvement on them silently assuming everything was free.
 */
async function upgrade(organizationId: string, tier = 'pro'): Promise<void> {
  await db.query(
    // Three parameters rather than reusing one: Postgres cannot deduce a single parameter used as
    // both a uuid and text, and says so in one of its more cryptic messages.
    `insert into subscriptions (organization_id, tier, status, external_customer)
     values ($1, $2, 'active', $3)
     on conflict (organization_id) do update set tier = excluded.tier, status = 'active'`,
    [organizationId, tier, organizationId],
  );
}

describe('session tokens', () => {
  it('hashes to the digest the collaboration server expects', () => {
    // `apps/collab/src/store.ts` restates this hash rather than importing it, so that the
    // collaboration server does not depend on this package's module graph to authenticate a
    // socket. The same literal is asserted there. If these two ever disagree, every collaborative
    // session silently stops authenticating — so they are pinned from both sides rather than
    // trusted to stay in step.
    expect(hashToken('a-known-session-token')).toBe(
      '639a1fbb1598acc02453eff9ca25eaa6972bf8da2b7956cb2d0e8efd7fce9784',
    );
  });
});

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
    // Three people are involved before the rule under test comes into play, and Free seats two.
    // The rank rule is what this is about, not the seat limit — which has its own tests.
    await upgrade(organizationId);

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
    // Uploading your own models is a Pro feature now. These tests are about what happens *after*
    // that gate, which has its own tests below.
    await upgrade(owner.personalOrganizationId);
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

  it('answers HEAD on an asset the same way it answers GET', async () => {
    const { token, organizationId } = await workspace();
    const granted = await requestUpload(token, organizationId, { assetId: 'head_rock' });
    await put(granted.body.upload.url, glb('rock'));

    const listed = await call<{ assets: Array<{ assetId: string; glbPath: string }> }>(
      'GET',
      `/orgs/${organizationId}/assets`,
      { token },
    );
    const path = listed.body.assets.find((a) => a.assetId === 'head_rock')!.glbPath;

    /**
     * Found by pointing the Sprint 36 header checker at a running server, not by reading the code.
     * The route matched `method === 'GET'`, so HEAD fell through to the authenticated routes below
     * it and came back 401 — a deliberately public, CDN-facing URL telling a cache it needed to log
     * in. HEAD is how a cache revalidates and how most uptime probes ask, so the failure would have
     * shown up as a cold CDN and a monitor that never went green, neither pointing at the cause.
     */
    const head = await fetch(`${origin}/assets/${path}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(head.headers.get('content-type')).toBe('model/gltf-binary');
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

/**
 * Sprint 32 — exporting as a job, and the quota that keeps it affordable.
 *
 * These are about the *API's* half: recording a request, refusing one over quota, and refusing to
 * hand out somebody else's build. The worker's half — that the job actually produces a playable zip
 * — is tested in `apps/export-worker`, against a real BullMQ queue.
 *
 * No queue is passed here on purpose. Enqueueing is one line and Redis is a second service to stand
 * up; what these tests are about is the row and the guard, both of which happen before any message
 * is sent.
 */
describe('export jobs', () => {
  async function workspace(tier = 'pro'): Promise<{
    token: string;
    organizationId: string;
    projectId: string;
  }> {
    const owner = await signup(`exporter-${Math.random().toString(36).slice(2)}@example.com`);
    await db.query('update organizations set plan_tier = $2 where id = $1', [
      owner.personalOrganizationId,
      tier,
    ]);

    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${owner.personalOrganizationId}/projects`,
      {
        token: owner.token,
        body: {
          name: 'Exportable',
          scene: {
            sceneId: 'scene_export',
            version: 1,
            name: 'Exportable',
            objects: [{ id: 'obj_0001', assetId: 'tree_pine_01' }],
          },
        },
      },
    );

    return {
      token: owner.token,
      organizationId: owner.personalOrganizationId,
      projectId: created.body.project.id,
    };
  }

  it('records a requested export against the version it will build', async () => {
    const { token, projectId } = await workspace();

    const requested = await call<{ job: { id: string; status: string; sceneVersion: number } }>(
      'POST',
      `/projects/${projectId}/exports`,
      { token },
    );

    // 202, not 201: the work has been accepted, not done. A 200 here would be the API claiming to
    // have exported something it has not started.
    expect(requested.status).toBe(202);
    expect(requested.body.job.status).toBe('queued');
    // The *version*, so a project edited while the job waits still builds what was asked for.
    expect(requested.body.job.sceneVersion).toBe(1);

    const polled = await call<{ job: { id: string; status: string }; downloadable: boolean }>(
      'GET',
      `/export-jobs/${requested.body.job.id}`,
      { token },
    );
    expect(polled.status).toBe(200);
    expect(polled.body.job.id).toBe(requested.body.job.id);
    expect(polled.body.downloadable).toBe(false);
  });

  it('refuses to export a project that has never been saved', async () => {
    const owner = await signup('unsaved@example.com');
    const created = await db.query<{ id: string }>(
      `insert into projects (organization_id, name, created_by) values ($1, 'Empty', $2) returning id`,
      [owner.personalOrganizationId, owner.userId],
    );

    // There is no version to build. Better to say so than to queue a job that must fail.
    const refused = await call<{ error: string }>(
      'POST',
      `/projects/${created.rows[0]!.id}/exports`,
      { token: owner.token },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/Save the project/);
  });

  it('records a web export as a web export, without being told', async () => {
    /**
     * The default, and the reason it is a default rather than a backfill: there is no such thing as
     * a desktop build made before the column existed, so `web` is the true answer for every row
     * already in this table rather than a value standing in for a missing read.
     */
    const { token, projectId } = await workspace('free');
    const created = await call<{ job: { target: string; desktop: unknown } }>(
      'POST',
      `/projects/${projectId}/exports`,
      { token },
    );

    expect(created.status).toBe(202);
    expect(created.body.job.target).toBe('web');
    expect(created.body.job.desktop).toBeNull();
  });

  it('stops at the plan limit, and says what the limit is', async () => {
    const { token, projectId } = await workspace('free');

    // Five on the free tier, per `EXPORTS_PER_PERIOD`.
    for (let index = 0; index < 5; index += 1) {
      expect((await call('POST', `/projects/${projectId}/exports`, { token })).status).toBe(202);
    }

    const refused = await call<{ error: string }>('POST', `/projects/${projectId}/exports`, {
      token,
    });

    expect(refused.status).toBe(429);
    // The number, not "quota exceeded": a message that says what the limit is can be acted on.
    expect(refused.body.error).toMatch(/all 5 exports/);
    expect(refused.body.error).toMatch(/free plan/);
  });

  it('counts failed exports against the quota, because they cost the same', async () => {
    const { token, organizationId, projectId } = await workspace('free');

    await call('POST', `/projects/${projectId}/exports`, { token });
    await db.query(`update export_jobs set status = 'failed', error = 'nope'`);

    const quota = await call<{ used: number; remaining: number; limit: number }>(
      'GET',
      `/orgs/${organizationId}/export-quota`,
      { token },
    );

    // A build that failed still burned the CPU the quota exists to protect. Giving it back would
    // make a reliably-failing project an unlimited one.
    expect(quota.body.used).toBe(1);
    expect(quota.body.remaining).toBe(4);
    expect(quota.body.limit).toBe(5);
  });

  it('cannot beat the quota by firing everything at once', async () => {
    const { token, projectId } = await workspace('free');

    // Ten simultaneous requests against a limit of five. A read-then-write guard would let most of
    // them through, because they all read the same count before any of them wrote.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => call('POST', `/projects/${projectId}/exports`, { token })),
    );

    expect(results.filter((result) => result.status === 202)).toHaveLength(5);
    expect(results.filter((result) => result.status === 429)).toHaveLength(5);
  });

  it('will not hand somebody else’s build over', async () => {
    const mine = await workspace();
    const stranger = await signup('nosy-exporter@example.com');

    const requested = await call<{ job: { id: string } }>(
      'POST',
      `/projects/${mine.projectId}/exports`,
      { token: mine.token },
    );

    // A job id in a URL is not an authorisation, and the refusal does not reveal that the job
    // exists — the same 404 an invented id gets.
    const peek = await call('GET', `/export-jobs/${requested.body.job.id}`, {
      token: stranger.token,
    });
    expect(peek.status).toBe(404);
  });

  it('refuses to download a build that is not finished, and one that has expired', async () => {
    const { token, projectId } = await workspace();
    const requested = await call<{ job: { id: string } }>(
      'POST',
      `/projects/${projectId}/exports`,
      { token },
    );
    const jobId = requested.body.job.id;

    const early = await call<{ error: string }>('GET', `/export-jobs/${jobId}/download`, { token });
    expect(early.status).toBe(404);
    expect(early.body.error).toMatch(/not finished/);

    // Finished, but its day is up. Expiry is checked when the download is asked for rather than
    // swept on a timer — a sweep that has not run yet would serve a build that is supposed to be
    // gone.
    await db.query(
      `update export_jobs set status = 'done', artifact_path = 'exports/x.zip',
              artifact_bytes = 10, expires_at = now() - interval '1 hour' where id = $1`,
      [jobId],
    );

    const expired = await call<{ error: string }>('GET', `/export-jobs/${jobId}/download`, {
      token,
    });
    expect(expired.status).toBe(403);
    expect(expired.body.error).toMatch(/expired/);
  });

  it('accepts a token in the query for the download only, and still checks membership', async () => {
    const { token, projectId } = await workspace();
    const stranger = await signup('nosy-downloader@example.com');

    const requested = await call<{ job: { id: string } }>(
      'POST',
      `/projects/${projectId}/exports`,
      { token },
    );
    const jobId = requested.body.job.id;

    // Finished, with bytes behind it.
    const artifact = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);
    exportStorage.put('exports/from-a-test.zip', artifact);
    await db.query(
      `update export_jobs set status = 'done', artifact_path = 'exports/from-a-test.zip',
              artifact_bytes = $2, expires_at = now() + interval '1 day' where id = $1`,
      [jobId, artifact.byteLength],
    );

    // A browser's download manager cannot send an Authorization header, so the token may ride in
    // the query — here and nowhere else.
    const downloaded = await fetch(`${origin}/export-jobs/${jobId}/download?token=${token}`);
    expect(downloaded.status).toBe(200);
    expect(downloaded.headers.get('content-type')).toBe('application/zip');
    expect(downloaded.headers.get('content-disposition')).toMatch(/attachment/);
    // Never cached: the URL is stable and what it serves expires.
    expect(downloaded.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(artifact);

    // The link is not the permission. Somebody else's valid token gets nothing.
    const refused = await fetch(`${origin}/export-jobs/${jobId}/download?token=${stranger.token}`);
    expect(refused.status).toBe(404);

    // And no token at all is refused rather than treated as anonymous.
    expect((await fetch(`${origin}/export-jobs/${jobId}/download`)).status).toBe(401);

    // The convenience is confined to downloads: every other route still wants the header.
    const viaQuery = await fetch(`${origin}/export-jobs/${jobId}?token=${token}`);
    expect(viaQuery.status).toBe(401);
  });

  it('lists a project’s builds, newest first', async () => {
    const { token, projectId } = await workspace();

    await call('POST', `/projects/${projectId}/exports`, { token });
    await call('POST', `/projects/${projectId}/exports`, { token });

    const listed = await call<{ jobs: Array<{ id: string; createdAt: string }> }>(
      'GET',
      `/projects/${projectId}/exports`,
      { token },
    );

    expect(listed.body.jobs).toHaveLength(2);
    expect(Date.parse(listed.body.jobs[0]!.createdAt)).toBeGreaterThanOrEqual(
      Date.parse(listed.body.jobs[1]!.createdAt),
    );
  });

  it('needs editor to export, and viewer only to look', async () => {
    const owner = await signup('export-owner@example.com');
    const viewer = await signup('export-viewer@example.com');

    const org = await call<{ organization: { id: string } }>('POST', '/orgs', {
      token: owner.token,
      body: { name: 'Studio' },
    });
    const organizationId = org.body.organization.id;

    await call('POST', `/orgs/${organizationId}/invites`, {
      token: owner.token,
      body: { email: 'export-viewer@example.com', role: 'viewer' },
    });
    await call('POST', '/invites/accept', {
      token: viewer.token,
      body: { token: invites.at(-1)!.token },
    });

    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${organizationId}/projects`,
      {
        token: owner.token,
        body: {
          name: 'Team Level',
          scene: { sceneId: 's', version: 1, name: 'Team Level', objects: [] },
        },
      },
    );
    const projectId = created.body.project.id;

    // Exporting spends minutes of CPU and produces something you can hand out. Read access to a
    // project is not permission to do that.
    expect(
      (await call('POST', `/projects/${projectId}/exports`, { token: viewer.token })).status,
    ).toBe(403);

    expect(
      (await call('GET', `/projects/${projectId}/exports`, { token: viewer.token })).status,
    ).toBe(200);
  });
});

/** Waits for something written after a response was already delivered. */
async function eventually<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = read();
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error('nothing was written within the deadline');
    await new Promise((done) => setTimeout(done, 25));
  }
}

describe('what the API says about itself', () => {
  it('turns a path into a route pattern, and refuses to learn new ones', () => {
    expect(routePattern('/health')).toBe('/health');
    expect(routePattern('/orgs/8f14e45f-ceea-467a-9f3c-4e2c2a1b8d90/projects')).toBe(
      '/orgs/:org/projects',
    );
    expect(routePattern('/projects/8f14e45f-ceea-467a-9f3c-4e2c2a1b8d90/versions/12/restore')).toBe(
      '/projects/:project/versions/:version/restore',
    );
    expect(routePattern('/export-jobs/8f14e45f-ceea-467a-9f3c-4e2c2a1b8d90/download')).toBe(
      '/export-jobs/:job/download',
    );
    expect(routePattern('/assets/models/tree_pine_01.glb')).toBe('/assets/:key');

    // The property that keeps the metrics store alive: a scanner spraying URLs adds one series,
    // not one per URL it invented.
    expect(routePattern('/wp-admin.php')).toBe('unmatched');
    expect(routePattern('/orgs/8f14e45f-ceea-467a-9f3c-4e2c2a1b8d90/nonsense')).toBe('unmatched');
  });

  it('answers with the correlation id the caller sent', async () => {
    const response = await fetch(`${origin}/health`, {
      headers: { 'x-correlation-id': 'hela_0123456789abcdef' },
    });
    expect(response.headers.get('x-correlation-id')).toBe('hela_0123456789abcdef');
  });

  it('mints one when the caller sends nothing, or sends something hostile', async () => {
    const fresh = await fetch(`${origin}/health`);
    expect(fresh.headers.get('x-correlation-id')).toMatch(/^hela_[0-9a-f]{16}$/);

    // A newline in this header would split one JSON log line into two, the second written by the
    // caller. It is replaced rather than escaped.
    const hostile = await fetch(`${origin}/health`, {
      headers: { 'x-correlation-id': 'not a valid id' },
    });
    expect(hostile.headers.get('x-correlation-id')).toMatch(/^hela_[0-9a-f]{16}$/);
  });

  it('writes a span and a log line per request, both naming that request', async () => {
    const correlationId = 'hela_feedfacefeedface';
    await fetch(`${origin}/me`, {
      headers: { 'x-correlation-id': correlationId, authorization: 'Bearer nonsense' },
    });

    /**
     * Polled rather than read once, and the reason is a design decision rather than flakiness:
     * the request line is written when the *response closes*, which is deliberately after the
     * client has its answer. Instrumentation that made `fetch` wait for a log write would be
     * instrumentation that charges every user for the monitoring.
     */
    const line = await eventually(() =>
      logged
        .map((each) => JSON.parse(each) as Record<string, unknown>)
        .find((each) => each['correlationId'] === correlationId),
    );
    expect(line).toMatchObject({ route: '/me', method: 'GET', status: 401 });

    const span = await eventually(() =>
      readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .map((each) => JSON.parse(each) as SpanRecord)
        .find((each) => each.attributes['hela.correlation_id'] === correlationId),
    );
    expect(span.name).toBe('GET /me');
    expect(span.attributes['http.response.status_code']).toBe(401);
  });

  it('serves Prometheus text, counting by route rather than by path', async () => {
    const owner = await signup('metrics-owner@example.com');
    await call('GET', '/me', { token: owner.token });

    const response = await fetch(`${origin}/metrics`, {
      headers: { authorization: `Bearer ${METRICS_TOKEN}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');

    const text = await response.text();
    expect(text).toContain('hela_http_requests_total{route="/me",method="GET",status="2xx"}');
    expect(text).toContain('hela_http_request_duration_seconds_bucket{route="/me",method="GET"');
    // The pool numbers are read when the scrape asks, which is the only way `waiting` is ever
    // anything but zero at the moment somebody looks.
    expect(text).toContain('hela_pg_pool_connections{state="waiting"}');
  });

  it('refuses a scrape without the token, when one is set', async () => {
    expect((await fetch(`${origin}/metrics`)).status).toBe(401);
    expect(
      (await fetch(`${origin}/metrics`, { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
  });

  it('records the correlation id on the export job it creates', async () => {
    const owner = await signup('export-correlation@example.com');
    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${owner.personalOrganizationId}/projects`,
      {
        token: owner.token,
        body: {
          name: 'Traceable',
          scene: { sceneId: 's', version: 1, name: 'Traceable', objects: [] },
        },
      },
    );

    const correlationId = 'hela_abcdef0123456789';
    const response = await fetch(`${origin}/projects/${created.body.project.id}/exports`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner.token}`,
        'x-correlation-id': correlationId,
      },
    });
    expect(response.status).toBe(202);

    // The join between what a user can quote and what the tracing backend holds. Without it, a
    // support thread about a bad export starts with "which one?".
    const body = (await response.json()) as { job: { correlationId: string } };
    expect(body.job.correlationId).toBe(correlationId);
  });
});

/**
 * Sprint 34 — cross-tenant isolation, endpoint by endpoint.
 *
 * The definition of done says this must be *tested*, not inferred from the RBAC design, and the
 * distinction is the point: `requireRole` is called at every call site by hand, so isolation holds
 * exactly as long as nobody forgets one. A route added without a guard is invisible in review and
 * obvious here.
 *
 * The table is the test. Every route that takes an organisation, project, job or asset id appears
 * in it, and each is driven with a *valid session belonging to somebody else* — not an anonymous
 * request, which is a much weaker claim. If a route is added and not listed, the count assertion at
 * the end fails, so the omission is loud rather than silent.
 */
describe('one organisation cannot reach another', () => {
  interface Tenant {
    token: string;
    organizationId: string;
    projectId: string;
    jobId: string;
    assetId: string;
  }

  async function tenant(label: string): Promise<Tenant> {
    const owner = await signup(`${label}-${Math.random().toString(36).slice(2)}@example.com`);
    // On a paid plan so it owns one of everything worth stealing — an upload is a Pro feature, and
    // a tenant with no assets would leave the asset routes untested for isolation.
    await upgrade(owner.personalOrganizationId);

    const created = await call<{ project: { id: string } }>(
      'POST',
      `/orgs/${owner.personalOrganizationId}/projects`,
      {
        token: owner.token,
        body: {
          name: `${label} project`,
          scene: { sceneId: 's', version: 1, name: `${label} project`, objects: [] },
        },
      },
    );
    const projectId = created.body.project.id;

    const job = await call<{ job: { id: string } }>('POST', `/projects/${projectId}/exports`, {
      token: owner.token,
    });

    const assetId = `asset_${Math.random().toString(36).slice(2, 10)}`;
    const asset = await call<{ asset: { id: string } }>(
      'POST',
      `/orgs/${owner.personalOrganizationId}/assets`,
      {
        token: owner.token,
        body: { assetId, name: `${label} model`, category: 'props' },
      },
    );

    return {
      token: owner.token,
      organizationId: owner.personalOrganizationId,
      projectId,
      jobId: job.body.job.id,
      assetId: asset.body.asset.id,
    };
  }

  interface Attempt {
    what: string;
    method: string;
    path: (victim: Tenant) => string;
    body?: unknown;
    /**
     * 404 for anything that would reveal the resource exists, 403 only where the attacker already
     * knows it does. See `requireRole` — telling a stranger "you may not touch organisation X"
     * confirms X exists, which is a membership oracle for anybody willing to guess ids.
     */
    expected: number[];
  }

  const attempts: Attempt[] = [
    {
      what: 'list the members',
      method: 'GET',
      path: (victim) => `/orgs/${victim.organizationId}/members`,
      expected: [404],
    },
    {
      what: 'invite themselves in',
      method: 'POST',
      path: (victim) => `/orgs/${victim.organizationId}/invites`,
      body: { email: 'attacker@example.com', role: 'owner' },
      expected: [404],
    },
    {
      what: 'list the projects',
      method: 'GET',
      path: (victim) => `/orgs/${victim.organizationId}/projects`,
      expected: [404],
    },
    {
      what: 'create a project in it',
      method: 'POST',
      path: (victim) => `/orgs/${victim.organizationId}/projects`,
      body: { name: 'Theirs now', scene: { sceneId: 's', version: 1, name: 'x', objects: [] } },
      expected: [404],
    },
    {
      what: 'read the export allowance',
      method: 'GET',
      path: (victim) => `/orgs/${victim.organizationId}/export-quota`,
      expected: [404],
    },
    {
      what: 'list the uploaded assets',
      method: 'GET',
      path: (victim) => `/orgs/${victim.organizationId}/assets`,
      expected: [404],
    },
    {
      what: 'start an upload into it',
      method: 'POST',
      path: (victim) => `/orgs/${victim.organizationId}/assets`,
      body: { assetId: 'theirs_now', name: 'theirs.glb', category: 'props' },
      expected: [404],
    },
    {
      what: 'delete an asset',
      method: 'DELETE',
      path: (victim) => `/orgs/${victim.organizationId}/assets/${victim.assetId}`,
      expected: [404],
    },
    {
      what: 'read a project',
      method: 'GET',
      path: (victim) => `/projects/${victim.projectId}`,
      expected: [404],
    },
    {
      what: 'rename a project',
      method: 'PATCH',
      path: (victim) => `/projects/${victim.projectId}`,
      body: { name: 'Renamed by a stranger' },
      expected: [404],
    },
    {
      what: 'delete a project',
      method: 'DELETE',
      path: (victim) => `/projects/${victim.projectId}`,
      expected: [404],
    },
    {
      what: 'read the version history',
      method: 'GET',
      path: (victim) => `/projects/${victim.projectId}/versions`,
      expected: [404],
    },
    {
      what: 'save over a project',
      method: 'POST',
      path: (victim) => `/projects/${victim.projectId}/versions`,
      body: {
        baseVersion: 1,
        scene: { sceneId: 's', version: 1, name: 'overwritten', objects: [] },
      },
      expected: [404],
    },
    {
      what: 'roll a project back',
      method: 'POST',
      path: (victim) => `/projects/${victim.projectId}/versions/1/restore`,
      expected: [404],
    },
    {
      what: 'spend the export quota',
      method: 'POST',
      path: (victim) => `/projects/${victim.projectId}/exports`,
      expected: [404],
    },
    {
      what: 'list the builds',
      method: 'GET',
      path: (victim) => `/projects/${victim.projectId}/exports`,
      expected: [404],
    },
    {
      what: 'poll an export job',
      method: 'GET',
      path: (victim) => `/export-jobs/${victim.jobId}`,
      expected: [404],
    },
    {
      what: 'download a finished build',
      method: 'GET',
      path: (victim) => `/export-jobs/${victim.jobId}/download`,
      expected: [403, 404],
    },
  ];

  it.each(attempts)('refuses to let a stranger $what', async (attempt) => {
    const victim = await tenant('victim');
    const attacker = await tenant('attacker');

    const response = await call(attempt.method, attempt.path(victim), {
      token: attacker.token,
      ...(attempt.body === undefined ? {} : { body: attempt.body }),
    });

    expect(attempt.expected).toContain(response.status);
  });

  it('covers every route that takes somebody else’s id', () => {
    /**
     * A tripwire, not a metric.
     *
     * The number is here so that adding a tenant-scoped route without adding a row above fails
     * this test rather than quietly shipping. The other routes in `routePattern`'s list are
     * unauthenticated by design and tested elsewhere: `/health` and `/metrics` carry no tenant
     * data, `/auth/*` and `/invites/accept` are how a session is obtained in the first place,
     * `/uploads/:org/:asset` is authorised by a signed ticket rather than a session (forgery is
     * tested above), and `/assets/:key` is the content-addressed CDN path.
     */
    expect(attempts).toHaveLength(18);
  });

  it('does not let one organisation’s export be downloaded with the other’s token in the URL', async () => {
    const victim = await tenant('victim');
    const attacker = await tenant('attacker');

    // The download route accepts a token in the query, because a browser's download manager cannot
    // send a header. That concession must not become a way in: membership is still checked.
    const response = await fetch(
      `${origin}/export-jobs/${victim.jobId}/download?token=${encodeURIComponent(attacker.token)}`,
    );
    expect([403, 404]).toContain(response.status);
  });

  it('refuses a session token that has been tampered with', async () => {
    const victim = await tenant('victim');
    const forged = `${victim.token.slice(0, -1)}${victim.token.endsWith('a') ? 'b' : 'a'}`;

    const response = await call('GET', `/orgs/${victim.organizationId}/members`, { token: forged });
    expect(response.status).toBe(401);
  });
});

/**
 * Sprint 34 — the audit trail.
 *
 * The plan's task says "implement/verify audit logging is actually being written", and *verify* is
 * the operative word: a table that exists and is never written to is worse than none, because it
 * looks like coverage in a security questionnaire. So each action is driven through the API and
 * then read back through the same endpoint an admin would use.
 */
describe('the audit trail', () => {
  async function entries(
    token: string,
    organizationId: string,
  ): Promise<Array<{ action: string; subject: string | null; detail: Record<string, unknown> }>> {
    const response = await call<{
      entries: Array<{ action: string; subject: string | null; detail: Record<string, unknown> }>;
    }>('GET', `/orgs/${organizationId}/audit`, { token });
    expect(response.status).toBe(200);
    return response.body.entries;
  }

  it('records a project being created, exported and deleted', async () => {
    const owner = await signup('audit-owner@example.com');
    const org = owner.personalOrganizationId;

    const created = await call<{ project: { id: string } }>('POST', `/orgs/${org}/projects`, {
      token: owner.token,
      body: {
        name: 'Audited',
        scene: { sceneId: 's', version: 1, name: 'Audited', objects: [] },
      },
    });
    const projectId = created.body.project.id;

    await call('POST', `/projects/${projectId}/exports`, { token: owner.token });
    await call('DELETE', `/projects/${projectId}`, { token: owner.token });

    const trail = await entries(owner.token, org);
    expect(trail.map((entry) => entry.action)).toEqual([
      // Newest first, which is the order somebody reviewing an incident reads in.
      'project.deleted',
      'export.requested',
      'project.created',
    ]);
    expect(trail.every((entry) => entry.subject !== null)).toBe(true);
  });

  it('survives the thing it describes being deleted', async () => {
    const owner = await signup('audit-cascade@example.com');
    const org = owner.personalOrganizationId;

    const created = await call<{ project: { id: string } }>('POST', `/orgs/${org}/projects`, {
      token: owner.token,
      body: { name: 'Gone', scene: { sceneId: 's', version: 1, name: 'Gone', objects: [] } },
    });
    await call('DELETE', `/projects/${created.body.project.id}`, { token: owner.token });

    // The whole point of `subject` being text rather than a foreign key: the row that says a
    // project was deleted must outlive the project, which is exactly the case under review.
    const trail = await entries(owner.token, org);
    expect(trail.find((entry) => entry.action === 'project.deleted')?.subject).toBe(
      created.body.project.id,
    );
  });

  it('records an invitation and the joining, with the role on both', async () => {
    const owner = await signup('audit-inviter@example.com');
    const org = owner.personalOrganizationId;
    const joiner = await signup('audit-joiner@example.com');

    await call('POST', `/orgs/${org}/invites`, {
      token: owner.token,
      body: { email: 'audit-joiner@example.com', role: 'editor' },
    });
    await call('POST', '/invites/accept', {
      token: joiner.token,
      body: { token: invites.at(-1)!.token },
    });

    const trail = await entries(owner.token, org);
    const invited = trail.find((entry) => entry.action === 'member.invited')!;
    const joined = trail.find((entry) => entry.action === 'member.joined')!;

    // The role is the reviewable part: an invite to `viewer` and an invite to `owner` are very
    // different events that would otherwise share a name.
    expect(invited.detail['role']).toBe('editor');
    expect(invited.subject).toBe('audit-joiner@example.com');
    expect(joined.detail['role']).toBe('editor');
  });

  it('records an asset deletion', async () => {
    const owner = await signup('audit-assets@example.com');
    const org = owner.personalOrganizationId;
    await upgrade(org);

    await call('POST', `/orgs/${org}/assets`, {
      token: owner.token,
      body: { assetId: 'doomed_prop', name: 'Doomed', category: 'props' },
    });
    await call('DELETE', `/orgs/${org}/assets/doomed_prop`, { token: owner.token });

    const trail = await entries(owner.token, org);
    expect(trail.find((entry) => entry.action === 'asset.deleted')?.subject).toBe('doomed_prop');
  });

  it('carries the correlation id, so an entry leads back to the request', async () => {
    const owner = await signup('audit-correlated@example.com');
    const org = owner.personalOrganizationId;

    const correlationId = 'hela_5555666677778888';
    await fetch(`${origin}/orgs/${org}/projects`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${owner.token}`,
        'content-type': 'application/json',
        'x-correlation-id': correlationId,
      },
      body: JSON.stringify({
        name: 'Traceable',
        scene: { sceneId: 's', version: 1, name: 'Traceable', objects: [] },
      }),
    });

    const response = await call<{ entries: Array<{ correlationId: string }> }>(
      'GET',
      `/orgs/${org}/audit`,
      { token: owner.token },
    );
    // The join between "somebody did this" and every log line and span from the request that did
    // it. Without it, an audit entry is a fact with no explanation attached.
    expect(response.body.entries[0]!.correlationId).toBe(correlationId);
  });

  it('is admin-only, and invisible to another organisation', async () => {
    const owner = await signup('audit-private@example.com');
    const org = owner.personalOrganizationId;
    const stranger = await signup('audit-stranger@example.com');

    // A viewer inside the organisation is refused too: a trail naming who did what is exactly what
    // a departing member should not be able to read on the way out.
    await call('POST', `/orgs/${org}/invites`, {
      token: owner.token,
      body: { email: 'audit-stranger@example.com', role: 'viewer' },
    });
    await call('POST', '/invites/accept', {
      token: stranger.token,
      body: { token: invites.at(-1)!.token },
    });

    expect((await call('GET', `/orgs/${org}/audit`, { token: stranger.token })).status).toBe(403);

    const outsider = await signup('audit-outsider@example.com');
    expect((await call('GET', `/orgs/${org}/audit`, { token: outsider.token })).status).toBe(404);
  });

  it('does not fail the action it is recording', async () => {
    const owner = await signup('audit-resilient@example.com');
    const org = owner.personalOrganizationId;

    // The table is gone; the product must keep working. A database hiccup in the audit table
    // turning a deletion into a 500 *after* the deletion committed is a worse outcome than a
    // missing row — see the note on `audit()`.
    await db.query('alter table audit_log rename to audit_log_hidden');
    try {
      const created = await call<{ project: { id: string } }>('POST', `/orgs/${org}/projects`, {
        token: owner.token,
        body: { name: 'Still works', scene: { sceneId: 's', version: 1, name: 'x', objects: [] } },
      });
      expect(created.status).toBe(201);
    } finally {
      await db.query('alter table audit_log_hidden rename to audit_log');
    }
  });
});

/**
 * Sprint 34 — guessing costs something.
 *
 * Its own server, with strict limits, because the shared harness deliberately opts out: a suite
 * that signs up thirty accounts in ten seconds is precisely the traffic the production limit
 * refuses. Driving the real thing over real HTTP is the only way to know the numbers are wired to
 * the routes rather than merely defined.
 */
describe('rate limiting the endpoints where guessing is the attack', () => {
  let strict: Server;
  let strictOrigin: string;

  beforeAll(async () => {
    strict = createApiServer({
      db,
      storage,
      exportStorage,
      throttles: {
        loginByAddress: new Throttle({ limit: 3, windowMs: 60_000 }),
        loginByAccount: new Throttle({ limit: 3, windowMs: 60_000 }),
        signupByAddress: new Throttle({ limit: 2, windowMs: 60_000 }),
        inviteByAddress: new Throttle({ limit: 2, windowMs: 60_000 }),
      },
      telemetry: {
        tracer: telemetry.tracer,
        metrics,
        log: createLogger({ service: 'api', level: 'error', write: () => {} }),
      },
    });
    await new Promise<void>((done) => strict.listen(0, '127.0.0.1', done));
    strictOrigin = `http://127.0.0.1:${(strict.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => strict.close(() => done()));
  });

  // `globalThis.Response`, because this file declares its own `Response<T>` for the `call` helper
  // and the shadow is invisible until it is a type error.
  async function post(path: string, body: unknown): Promise<globalThis.Response> {
    return fetch(`${strictOrigin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('refuses a burst of password guesses, with a Retry-After', async () => {
    const credentials = { email: 'victim@example.com', password: 'not-the-right-one' };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await post('/auth/login', credentials)).status).toBe(401);
    }

    const refused = await post('/auth/login', credentials);
    expect(refused.status).toBe(429);
    // A client that is told to wait can obey; one that is merely refused retries immediately.
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('says the same thing whether or not the account exists', async () => {
    // The limiter must not become the account-enumeration oracle that the login response itself
    // carefully avoids being.
    const unknown = await post('/auth/login', {
      email: 'nobody-here@example.com',
      password: 'wrong-password-here',
    });
    expect([401, 429]).toContain(unknown.status);
  });

  it('caps sign-ups from one address', async () => {
    expect(
      (
        await post('/auth/signup', {
          email: `burst-1-${Date.now()}@example.com`,
          password: 'a-long-enough-password',
          displayName: 'One',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await post('/auth/signup', {
          email: `burst-2-${Date.now()}@example.com`,
          password: 'a-long-enough-password',
          displayName: 'Two',
        })
      ).status,
    ).toBe(201);

    const third = await post('/auth/signup', {
      email: `burst-3-${Date.now()}@example.com`,
      password: 'a-long-enough-password',
      displayName: 'Three',
    });
    expect(third.status).toBe(429);
  });

  it('refuses a burst of invite-token guesses', async () => {
    // Signed in, because accepting an invite requires an account — so the threat here is a member
    // of the system fishing for other organisations' invite tokens, not an anonymous stranger.
    const guesser = await signup('invite-guesser@example.com');
    const guess = async (): Promise<number> =>
      (
        await fetch(`${strictOrigin}/invites/accept`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${guesser.token}`,
          },
          body: JSON.stringify({ token: 'a-guessed-token' }),
        })
      ).status;

    for (let attempt = 0; attempt < 2; attempt += 1) expect(await guess()).toBe(404);
    expect(await guess()).toBe(429);
  });
});

describe('signing out', () => {
  it('revokes the token on the server, not just in the tab', async () => {
    const person = await signup('sign-out@example.com');

    expect((await call('GET', '/me', { token: person.token })).status).toBe(200);

    const revoked = await fetch(`${origin}/auth/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${person.token}` },
    });
    expect(revoked.status).toBe(204);

    // The reason this exists: until now "sign out" only dropped the token from the browser, so a
    // token copied off a shared machine stayed good for its full fourteen days.
    expect((await call('GET', '/me', { token: person.token })).status).toBe(401);
  });

  it('leaves the user’s other sessions alone', async () => {
    const person = await signup('two-devices@example.com');
    const second = await call<{ session: { token: string } }>('POST', '/auth/login', {
      body: { email: 'two-devices@example.com', password: 'a-long-enough-password' },
    });
    const phone = second.body.session.token;

    await fetch(`${origin}/auth/session`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${person.token}` },
    });

    // Signing out of a library computer must not sign somebody out of their phone.
    expect((await call('GET', '/me', { token: phone })).status).toBe(200);
  });

  it('answers the same for a token it has never seen', async () => {
    // An endpoint that distinguishes them is an oracle for testing stolen tokens.
    const response = await fetch(`${origin}/auth/session`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(response.status).toBe(204);
  });
});

/**
 * Sprint 34 — the expiry audit, as tests.
 *
 * Two findings came out of reading every lifetime in the system, and neither was a way in. Both
 * were retention claims that were not true: expired credentials were left in the table for ever,
 * and an expired build's bytes stayed on disk after the link stopped working. "We keep sessions for
 * fourteen days" and "builds expire after a day" are only true if something deletes them.
 */
describe('expiry is enforced, not merely checked', () => {
  it('deletes sessions and unaccepted invites once they are past their time', async () => {
    const person = await signup('expiry-sweep@example.com');
    const org = person.personalOrganizationId;

    await call('POST', `/orgs/${org}/invites`, {
      token: person.token,
      body: { email: 'never-accepts@example.com', role: 'viewer' },
    });

    // Aged rather than waited for: a test that sits out fourteen days is a test nobody runs.
    await db.query("update sessions set expires_at = now() - interval '1 day'");
    await db.query("update invites set expires_at = now() - interval '1 day'");

    const pruned = await pruneExpiredCredentials(db);
    expect(pruned.sessions).toBeGreaterThan(0);
    expect(pruned.invites).toBeGreaterThan(0);

    expect((await db.query('select count(*)::int as count from sessions')).rows[0]).toMatchObject({
      count: 0,
    });
  });

  it('keeps a session that has not expired, which is the part that must not break', async () => {
    const person = await signup('expiry-keeps@example.com');
    await pruneExpiredCredentials(db);
    expect((await call('GET', '/me', { token: person.token })).status).toBe(200);
  });

  it('keeps an accepted invite, because it is a record rather than a credential', async () => {
    const owner = await signup('expiry-inviter@example.com');
    const joiner = await signup('expiry-joiner@example.com');
    const org = owner.personalOrganizationId;

    await call('POST', `/orgs/${org}/invites`, {
      token: owner.token,
      body: { email: 'expiry-joiner@example.com', role: 'editor' },
    });
    await call('POST', '/invites/accept', {
      token: joiner.token,
      body: { token: invites.at(-1)!.token },
    });

    await db.query("update invites set expires_at = now() - interval '1 day'");
    await pruneExpiredCredentials(db);

    // The audit trail refers to it, and its token hash is already spent.
    expect((await db.query('select count(*)::int as count from invites')).rows[0]).toMatchObject({
      count: 1,
    });
  });

  it('lists the builds whose bytes should be gone, without touching the history', async () => {
    const owner = await signup('expiry-builds@example.com');
    const org = owner.personalOrganizationId;
    const created = await call<{ project: { id: string } }>('POST', `/orgs/${org}/projects`, {
      token: owner.token,
      body: { name: 'Expiring', scene: { sceneId: 's', version: 1, name: 'x', objects: [] } },
    });
    const requested = await call<{ job: { id: string } }>(
      'POST',
      `/projects/${created.body.project.id}/exports`,
      { token: owner.token },
    );
    const jobId = requested.body.job.id;

    // As the worker leaves it when a build finishes, then aged past its day.
    await db.query(
      `update export_jobs
          set status = 'done', artifact_path = $2, artifact_bytes = 1024,
              expires_at = now() - interval '1 hour'
        where id = $1`,
      [jobId, `exports/${jobId}.zip`],
    );

    const expired = await expiredArtifacts(db);
    expect(expired.map((each) => each.id)).toContain(jobId);

    await forgetArtifact(db, jobId);

    // The row survives with its history: "you exported this on Tuesday" is worth keeping, "and
    // here it is" is not.
    const after = await call<{ job: { artifactPath: string | null; status: string } }>(
      'GET',
      `/export-jobs/${jobId}`,
      { token: owner.token },
    );
    expect(after.body.job.status).toBe('done');
    expect(after.body.job.artifactPath).toBeNull();
    expect((await expiredArtifacts(db)).map((each) => each.id)).not.toContain(jobId);
  });
});

describe('CORS', () => {
  it('answers a preflight with the methods and headers the editor needs', async () => {
    const response = await fetch(`${origin}/projects/00000000-0000-0000-0000-000000000000`, {
      method: 'OPTIONS',
      headers: { origin: 'https://editor.example.com' },
    });

    expect(response.status).toBe(204);
    // PUT is not optional: `model/gltf-binary` is not a safelisted content type, so an upload is
    // preflighted, and a preflight that omits PUT fails as "Failed to fetch".
    expect(response.headers.get('access-control-allow-methods')).toContain('PUT');
    // The editor sends its own correlation id and reads the one it gets back.
    expect(response.headers.get('access-control-allow-headers')).toContain('x-correlation-id');
    expect(response.headers.get('access-control-expose-headers')).toContain('x-correlation-id');
  });

  it('never claims to allow credentials, which is what makes a wildcard safe here', async () => {
    const response = await fetch(`${origin}/health`, {
      headers: { origin: 'https://anywhere.example.com' },
    });
    // A wildcard origin plus credentials is the combination browsers refuse and servers should
    // never offer. Auth here is a bearer token, so nothing ambient is ever attached.
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });
});

/**
 * Sprint 35 — the business model, enforced.
 *
 * Driven through the local provider, which is a real implementation of the billing port with the
 * network removed rather than a mock: pressing "upgrade" produces a checkout URL, the checkout
 * posts a *signed webhook* to this API, and the webhook is what changes the entitlement. Every part
 * of that path — signature, idempotency, attribution, audit — is the same code a Stripe deployment
 * runs. What is not exercised is Stripe itself, and no test here pretends otherwise.
 */
describe('plans, limits and money', () => {
  let paid: Server;
  let paidOrigin: string;
  let provider: LocalBilling;

  beforeAll(async () => {
    provider = new LocalBilling({ secret: 'test-billing-secret', origin: 'http://127.0.0.1:0' });
    paid = createApiServer({
      db,
      storage,
      exportStorage,
      billing: provider,
      // This server needs the same invite capture as the main one — without it an invitation goes
      // to the logger and a test reaching for `invites.at(-1)` finds nothing.
      sendInvite: (invite) => invites.push({ email: invite.email, token: invite.token }),
      throttles: {
        signupByAddress: new Throttle({ limit: 100_000, windowMs: 1000 }),
        loginByAddress: new Throttle({ limit: 100_000, windowMs: 1000 }),
        loginByAccount: new Throttle({ limit: 100_000, windowMs: 1000 }),
        inviteByAddress: new Throttle({ limit: 100_000, windowMs: 1000 }),
      },
      telemetry: {
        tracer: telemetry.tracer,
        metrics,
        log: createLogger({ service: 'api', level: 'error', write: () => {} }),
      },
    });
    await new Promise<void>((done) => paid.listen(0, '127.0.0.1', done));
    paidOrigin = `http://127.0.0.1:${(paid.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => paid.close(() => done()));
  });

  async function on<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${paidOrigin}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  /** Delivers a signed webhook the way the provider would. */
  async function webhook(event: Record<string, unknown>): Promise<number> {
    const payload = JSON.stringify(event);
    const response = await fetch(`${paidOrigin}/billing/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-billing-signature': provider.sign(payload),
      },
      body: payload,
    });
    return response.status;
  }

  it('refuses a custom asset upload on the free plan, with the way out attached', async () => {
    const owner = await signup('free-uploader@example.com');

    const refused = await on<{ error: string; kind: string; upgradeTo: string }>(
      'POST',
      `/orgs/${owner.personalOrganizationId}/assets`,
      { token: owner.token, body: { assetId: 'my_prop', name: 'Mine', category: 'props' } },
    );

    // 402, not 403. "You may not" is a wall; "not on this plan" is a door, and the body carries
    // enough for the editor to show the door rather than parse a sentence.
    expect(refused.status).toBe(402);
    expect(refused.body.kind).toBe('customAssets');
    expect(refused.body.upgradeTo).toBe('pro');
    expect(refused.body.error).toContain('Pro');
  });

  it('unlocks it after a checkout, with no manual step in between', async () => {
    const owner = await signup('upgrader@example.com');
    const org = owner.personalOrganizationId;

    const checkout = await on<{ url: string }>('POST', `/orgs/${org}/billing/checkout`, {
      token: owner.token,
      body: { tier: 'pro', returnUrl: '/' },
    });
    expect(checkout.status).toBe(200);
    expect(checkout.body.url).toContain('/billing/checkout?');

    // What the checkout page's button does when the payment clears.
    expect(
      await webhook({
        id: `evt_${Math.random().toString(36).slice(2)}`,
        type: 'checkout.session.completed',
        organizationId: org,
        customer: org,
        subscription: 'sub_test_1',
        tier: 'pro',
        status: 'active',
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      }),
    ).toBe(200);

    // The definition of done: the feature is available immediately, with nobody touching a database.
    const allowed = await on('POST', `/orgs/${org}/assets`, {
      token: owner.token,
      body: { assetId: 'my_prop', name: 'Mine', category: 'props' },
    });
    expect(allowed.status).toBe(201);
  });

  it('acts on a redelivered webhook exactly once', async () => {
    const owner = await signup('redelivered@example.com');
    const org = owner.personalOrganizationId;
    const event = {
      id: 'evt_redelivered_once',
      type: 'checkout.session.completed',
      organizationId: org,
      customer: org,
      subscription: 'sub_test_2',
      tier: 'pro',
      status: 'active',
    };

    expect(await webhook(event)).toBe(200);
    // Providers deliver at least once and mean it. Without the claim, this second delivery is a
    // second upgrade — and a redelivered *deletion* would undo an upgrade that happened between.
    expect(await webhook(event)).toBe(200);

    const trail = await on<{ entries: Array<{ action: string }> }>('GET', `/orgs/${org}/audit`, {
      token: owner.token,
    });
    expect(trail.body.entries.filter((entry) => entry.action === 'billing.changed')).toHaveLength(
      1,
    );
  });

  it('refuses a webhook nobody signed', async () => {
    const forged = await fetch(`${paidOrigin}/billing/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-billing-signature': 'nonsense' },
      body: JSON.stringify({
        id: 'evt_forged',
        type: 'checkout.session.completed',
        tier: 'enterprise',
      }),
    });
    // The one place where getting it wrong lets anybody on the internet upgrade themselves free.
    expect(forged.status).toBe(400);
  });

  it('keeps entitlement while a payment is being retried, and drops it when it is over', async () => {
    const owner = await signup('past-due@example.com');
    const org = owner.personalOrganizationId;

    await webhook({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      type: 'checkout.session.completed',
      organizationId: org,
      customer: org,
      subscription: 'sub_test_3',
      tier: 'pro',
      status: 'active',
    });

    await webhook({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      type: 'customer.subscription.updated',
      organizationId: org,
      customer: org,
      subscription: 'sub_test_3',
      tier: 'pro',
      status: 'past_due',
    });

    // A customer whose card expired is a customer, not an intruder: they keep working while the
    // provider retries, which it does for days.
    expect(
      (
        await on('POST', `/orgs/${org}/assets`, {
          token: owner.token,
          body: { assetId: 'still_works', name: 'Still works', category: 'props' },
        })
      ).status,
    ).toBe(201);

    await webhook({
      id: `evt_${Math.random().toString(36).slice(2)}`,
      type: 'customer.subscription.deleted',
      organizationId: org,
      customer: org,
      subscription: 'sub_test_3',
      tier: 'free',
      status: 'none',
    });

    expect(
      (
        await on('POST', `/orgs/${org}/assets`, {
          token: owner.token,
          body: { assetId: 'no_longer', name: 'No longer', category: 'props' },
        })
      ).status,
    ).toBe(402);
  });

  it('counts a seat before it is taken, invitations included', async () => {
    const owner = await signup('seat-counter@example.com');
    const org = owner.personalOrganizationId;

    // Free seats two: the owner, and one more.
    const first = await on('POST', `/orgs/${org}/invites`, {
      token: owner.token,
      body: { email: 'friend@example.com', role: 'editor' },
    });
    expect(first.status).toBe(201);

    const second = await on<{ kind: string; used: number; limit: number }>(
      'POST',
      `/orgs/${org}/invites`,
      { token: owner.token, body: { email: 'another@example.com', role: 'editor' } },
    );

    // The invitation counts even though nobody has accepted it. Otherwise fifty invitations to a
    // one-seat plan are fifty members, each individually within the limit when it was checked.
    expect(second.status).toBe(402);
    expect(second.body.kind).toBe('seats');
    expect(second.body.limit).toBe(2);
  });

  it('reports usage the server itself counts', async () => {
    const owner = await signup('meter-reader@example.com');
    const org = owner.personalOrganizationId;

    const created = await on<{ project: { id: string } }>('POST', `/orgs/${org}/projects`, {
      token: owner.token,
      body: { name: 'Metered', scene: { sceneId: 's', version: 1, name: 'Metered', objects: [] } },
    });
    await on('POST', `/projects/${created.body.project.id}/exports`, { token: owner.token });

    const summary = await on<{
      usage: { exports: number; seats: number; storageBytes: number };
      limits: { exportsPerPeriod: number };
      subscription: { tier: string };
      checkoutAvailable: boolean;
    }>('GET', `/orgs/${org}/billing`, { token: owner.token });

    expect(summary.status).toBe(200);
    // Derived from `export_jobs`, not from a counter this code maintains — which is why it cannot
    // disagree with what the quota enforces.
    expect(summary.body.usage.exports).toBe(1);
    expect(summary.body.usage.seats).toBe(1);
    expect(summary.body.subscription.tier).toBe('free');
    expect(summary.body.limits.exportsPerPeriod).toBe(5);
    expect(summary.body.checkoutAvailable).toBe(true);
  });

  it('lets only an owner change what the organisation pays', async () => {
    const owner = await signup('billing-owner@example.com');
    const member = await signup('billing-member@example.com');
    const org = owner.personalOrganizationId;

    await on('POST', `/orgs/${org}/invites`, {
      token: owner.token,
      body: { email: 'billing-member@example.com', role: 'admin' },
    });
    await on('POST', '/invites/accept', {
      token: member.token,
      body: { token: invites.at(-1)!.token },
    });

    // An admin can invite people; committing the owner to a larger monthly bill is a different
    // kind of act.
    expect(
      (
        await on('POST', `/orgs/${org}/billing/checkout`, {
          token: member.token,
          body: { tier: 'pro' },
        })
      ).status,
    ).toBe(403);

    // But they can see the meters — a usage bar only the owner can read is one nobody looks at
    // until it is empty.
    expect((await on('GET', `/orgs/${org}/billing`, { token: member.token })).status).toBe(200);
  });

  it('sends somebody moving down to Free through the portal rather than checkout', async () => {
    const owner = await signup('downgrader@example.com');
    const refused = await on<{ error: string }>(
      'POST',
      `/orgs/${owner.personalOrganizationId}/billing/checkout`,
      { token: owner.token, body: { tier: 'free' } },
    );
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/cancel/i);
  });
});

/**
 * Sprint 35 — what happens when somebody drops to a plan they are already over.
 *
 * The sprint plan says to decide this rather than leave it undefined, and offers "read-only lockout
 * of excess projects vs. grace period" as the choice. Neither, in the end:
 *
 * **Nothing is taken away. Only growth is refused.**
 *
 * A lockout means choosing *which* of somebody's projects to freeze, and every rule for choosing is
 * arbitrary and feels punitive — the newest? the largest? A grace period only moves the same
 * decision a fortnight into the future. What this does instead is keep every existing asset
 * readable, listable and downloadable for ever, and refuse *new* uploads until the organisation is
 * back inside its plan. Deleting is always available, so the way out is in the user's hands rather
 * than in a support queue.
 *
 * The cost, stated plainly: a downgraded organisation can sit over the storage limit indefinitely,
 * which is real money. The alternative is deleting a customer's work because their card changed,
 * and that is not a trade this product should make.
 */
describe('downgrading below what is already used', () => {
  let downgradeServer: Server;
  let downgradeOrigin: string;

  beforeAll(async () => {
    downgradeServer = createApiServer({
      db,
      storage,
      exportStorage,
      uploadSecret: UPLOAD_SECRET,
      sendInvite: (invite) => invites.push({ email: invite.email, token: invite.token }),
      throttles: {
        signupByAddress: new Throttle({ limit: 100_000, windowMs: 1000 }),
        loginByAddress: new Throttle({ limit: 100_000, windowMs: 1000 }),
        loginByAccount: new Throttle({ limit: 100_000, windowMs: 1000 }),
        inviteByAddress: new Throttle({ limit: 100_000, windowMs: 1000 }),
      },
      telemetry: {
        tracer: telemetry.tracer,
        metrics,
        log: createLogger({ service: 'api', level: 'error', write: () => {} }),
      },
    });
    await new Promise<void>((done) => downgradeServer.listen(0, '127.0.0.1', done));
    downgradeOrigin = `http://127.0.0.1:${(downgradeServer.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => downgradeServer.close(() => done()));
  });

  async function at<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<{ status: number; body: T }> {
    const response = await fetch(`${downgradeOrigin}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: (text ? JSON.parse(text) : {}) as T };
  }

  /** An asset of a given size, written straight to the row the meter reads. */
  async function existingAsset(organizationId: string, assetId: string, bytes: number) {
    await db.query(
      `insert into assets (organization_id, asset_id, name, category, status, size_bytes, glb_path)
       values ($1, $2, $3, 'props', 'ready', $4, $5)`,
      [organizationId, assetId, assetId, bytes, `orgs/${organizationId}/assets/${assetId}.glb`],
    );
  }

  /**
   * A library that fills a plan, in one statement.
   *
   * Many rows rather than one enormous one, because `size_bytes` is an `integer` and an upload is
   * capped at 25 MB — a single 11 GB asset cannot exist, and writing one to set up a test would be
   * testing a state the product cannot reach. Filling 10 GB the way a real customer would takes
   * four hundred assets.
   */
  async function fillLibrary(organizationId: string, count: number, eachBytes: number) {
    await db.query(
      // `$1::uuid` and `$4::text` for the same value: Postgres will not deduce one parameter used
      // as both a uuid column and a string being concatenated into a path.
      `insert into assets (organization_id, asset_id, name, category, status, size_bytes, glb_path)
       select $1::uuid, 'bulk_' || n, 'Bulk ' || n, 'props', 'ready', $3,
              'orgs/' || $4::text || '/assets/bulk_' || n || '.glb'
         from generate_series(1, $2) as n`,
      [organizationId, count, eachBytes, organizationId],
    );
  }

  it('keeps every asset, and refuses only the next upload', async () => {
    const owner = await signup('downgraded@example.com');
    const org = owner.personalOrganizationId;
    await upgrade(org, 'pro');

    // 600 MB, comfortably inside Pro's 10 GB and past Free's half-gigabyte.
    await existingAsset(org, 'big_one', 300 * 1024 * 1024);
    await existingAsset(org, 'big_two', 300 * 1024 * 1024);

    await db.query(
      `update subscriptions set tier = 'free', status = 'none' where organization_id = $1`,
      [org],
    );

    // Everything they made is still theirs, still listed, still there. This is the assertion that
    // matters most in this file.
    const library = await at<{ assets: Array<{ assetId: string }> }>('GET', `/orgs/${org}/assets`, {
      token: owner.token,
    });
    expect(library.status).toBe(200);
    expect(library.body.assets.filter((asset) => asset.assetId.startsWith('big_'))).toHaveLength(2);

    // Growth is what stops. And the sentence says what happened rather than implying a threat.
    const refused = await at<{ error: string; kind: string }>('POST', `/orgs/${org}/assets`, {
      token: owner.token,
      body: { assetId: 'one_more', name: 'One more', category: 'props' },
    });
    expect(refused.status).toBe(402);
    // Refused at the feature gate first, because Free has no custom uploads at all.
    expect(refused.body.kind).toBe('customAssets');
  });

  it('tells somebody already over the limit that nothing was deleted', async () => {
    const owner = await signup('over-limit@example.com');
    const org = owner.personalOrganizationId;
    await upgrade(org, 'studio');

    // Over Pro's 10 GB, so dropping to Pro leaves them above it — as a real library would be:
    // four hundred and forty assets at the 25 MB upload cap.
    await fillLibrary(org, 440, 25 * 1024 * 1024);
    await db.query(`update subscriptions set tier = 'pro' where organization_id = $1`, [org]);

    const ticket = await at<{ upload: { url: string } }>('POST', `/orgs/${org}/assets`, {
      token: owner.token,
      body: { assetId: 'another_one', name: 'Another', category: 'props' },
    });
    expect(ticket.status).toBe(201);

    // The storage check happens when the bytes arrive, because a ticket is issued before anybody
    // knows how big the file is.
    const upload = await fetch(`${downgradeOrigin}${ticket.body.upload.url}`, {
      method: 'PUT',
      headers: { 'content-type': 'model/gltf-binary' },
      body: Buffer.from('glTF-ish bytes'),
    });
    const refusal = (await upload.json()) as { error: string; kind: string };

    expect(upload.status).toBe(402);
    expect(refusal.kind).toBe('storage');
    // The difference between a downgrade message and a "your file is too big" message.
    expect(refusal.error).toMatch(/nothing has been deleted/i);
    expect(refusal.error).toMatch(/delete some assets/i);
  });

  it('lets somebody delete their way back under, without support', async () => {
    const owner = await signup('deleting-back@example.com');
    const org = owner.personalOrganizationId;
    await upgrade(org, 'pro');

    await fillLibrary(org, 400, 25 * 1024 * 1024);
    await existingAsset(org, 'hefty', 25 * 1024 * 1024);

    // Deleting is never gated: the way out has to be in the user's own hands, or the only route
    // back to a working account is a support queue.
    expect((await at('DELETE', `/orgs/${org}/assets/hefty`, { token: owner.token })).status).toBe(
      204,
    );

    const ticket = await at<{ upload: { url: string } }>('POST', `/orgs/${org}/assets`, {
      token: owner.token,
      body: { assetId: 'small_one', name: 'Small', category: 'props' },
    });
    const upload = await fetch(`${downgradeOrigin}${ticket.body.upload.url}`, {
      method: 'PUT',
      headers: { 'content-type': 'model/gltf-binary' },
      body: Buffer.from([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 12, 0, 0, 0]),
    });
    expect(upload.status).toBe(200);
  });

  it('keeps members who are already in when the seats shrink', async () => {
    const owner = await signup('shrinking-team@example.com');
    const member = await signup('kept-member@example.com');
    const org = owner.personalOrganizationId;
    await upgrade(org, 'pro');

    await at('POST', `/orgs/${org}/invites`, {
      token: owner.token,
      body: { email: 'kept-member@example.com', role: 'editor' },
    });
    await at('POST', '/invites/accept', {
      token: member.token,
      body: { token: invites.at(-1)!.token },
    });

    // Down to a plan with fewer seats than the team already has.
    await db.query(
      `update subscriptions set tier = 'free', status = 'none' where organization_id = $1`,
      [org],
    );

    // Nobody is thrown out. Removing somebody from a team because a card was cancelled would be a
    // product deciding who gets to work today, which is not its place.
    const members = await at<{ members: unknown[] }>('GET', `/orgs/${org}/members`, {
      token: owner.token,
    });
    expect(members.body.members).toHaveLength(2);
    expect((await at('GET', '/me', { token: member.token })).status).toBe(200);

    // But the team cannot grow again until it is back inside the plan.
    const third = await at<{ kind: string }>('POST', `/orgs/${org}/invites`, {
      token: owner.token,
      body: { email: 'third@example.com', role: 'editor' },
    });
    expect(third.status).toBe(402);
    expect(third.body.kind).toBe('seats');
  });
});
