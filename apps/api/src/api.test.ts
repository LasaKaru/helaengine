import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { roleAtLeast, type Role } from '@helaengine/schema';
import { createPool, migrate, reset, type Db } from './db.js';
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
const invites: Array<{ email: string; token: string }> = [];

beforeAll(async () => {
  db = createPool(DATABASE_URL);
  await reset(db);
  await migrate(db);

  server = createApiServer({
    db,
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
});

beforeEach(async () => {
  // Truncated rather than dropped: each test starts from nothing, and rebuilding the schema per
  // test would make the suite slow enough that somebody stops running it.
  await db.query(
    'truncate sessions, invites, scene_versions, projects, memberships, organizations, users cascade',
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
  return { status: response.status, body: (await response.json()) as T };
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
