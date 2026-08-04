import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import {
  InviteRequestSchema,
  LoginRequestSchema,
  RoleSchema,
  SignupRequestSchema,
  type Invite,
  type Membership,
  type Organization,
  type Role,
  type User,
} from '@helaengine/schema';
import {
  createSession,
  INVITE_LIFETIME_MS,
  LocalAuthProvider,
  mintToken,
  hashToken,
  provisionUser,
  verifyPassword,
  type AuthProvider,
} from './auth.js';
import type { Db } from './db.js';
import { Forbidden, NotFound, requireRole, roleIn, Unauthorized } from './roles.js';

/**
 * The platform API.
 *
 * Plain `node:http`, matching the co-op and share services. See the note in `db.ts` for why this is
 * not NestJS: the short version is that this repo's taste is explicit over assembled, and nothing
 * here would be shorter with decorators.
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export interface ApiOptions {
  db: Db;
  auth?: AuthProvider;
  /** Where invite emails would go. Absent means they are logged instead — see `sendInvite`. */
  sendInvite?: (invite: { email: string; token: string; organizationName: string }) => void;
}

export function createApiServer(options: ApiOptions): Server {
  const { db } = options;
  const auth = options.auth ?? new LocalAuthProvider(db);

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const status = (error as { status?: number }).status;
      if (typeof status === 'number') {
        send(response, status, { error: (error as Error).message });
        return;
      }
      if (error instanceof ZodError) {
        const first = error.errors[0];
        send(response, 400, {
          error: first
            ? `${first.path.join('.') || 'request'}: ${first.message}`
            : 'invalid request',
        });
        return;
      }
      if (error instanceof SyntaxError) {
        send(response, 400, { error: 'the request body was not valid JSON' });
        return;
      }
      console.error('[api] request failed', error);
      send(response, 500, { error: 'the API failed to handle this request' });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = request.method ?? 'GET';

    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type, authorization');
    response.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (method === 'OPTIONS') return void response.writeHead(204).end();

    if (path === '/health') return send(response, 200, { ok: true });

    if (path === '/auth/signup' && method === 'POST') {
      const body = SignupRequestSchema.parse(JSON.parse(await readBody(request)));
      const existing = await db.query('select 1 from users where email = $1', [
        body.email.trim().toLowerCase(),
      ]);
      // Refused before the hash rather than after: an existing address is not a secret here — the
      // signup form has to say so anyway — and doing the work first would be a free CPU sink.
      if (existing.rowCount) return send(response, 409, { error: 'that email is already in use' });

      const { user, personalOrganizationId } = await provisionUser(db, body);
      const session = await createSession(db, user.id);
      return send(response, 201, {
        user,
        personalOrganizationId,
        session: { token: session.token, expiresAt: session.expiresAt.toISOString() },
      });
    }

    if (path === '/auth/login' && method === 'POST') {
      const body = LoginRequestSchema.parse(JSON.parse(await readBody(request)));
      const found = await db.query<{ id: string; password_hash: string | null }>(
        'select id, password_hash from users where email = $1',
        [body.email.trim().toLowerCase()],
      );

      const row = found.rows[0];
      // The same answer for "no such user" and "wrong password", and the hash is verified even when
      // there is no user — otherwise the response time says which of the two it was.
      const ok = await verifyPassword(body.password, row?.password_hash ?? null);
      if (!row || !ok) return send(response, 401, { error: 'those credentials are not valid' });

      const session = await createSession(db, row.id);
      return send(response, 200, {
        session: { token: session.token, expiresAt: session.expiresAt.toISOString() },
      });
    }

    // Everything below needs a caller.
    const userId = await identify(request, auth);

    if (path === '/me' && method === 'GET') {
      const me = await loadUser(db, userId);
      const orgs = await db.query<{
        id: string;
        name: string;
        is_personal: boolean;
        created_at: Date;
        role: Role;
      }>(
        `select o.id, o.name, o.is_personal, o.created_at, m.role
           from organizations o
           join memberships m on m.organization_id = o.id
          where m.user_id = $1
          order by o.created_at`,
        [userId],
      );

      return send(response, 200, {
        user: me,
        organizations: orgs.rows.map((row) => ({
          ...toOrganization(row),
          role: row.role,
        })),
      });
    }

    if (path === '/orgs' && method === 'POST') {
      const body = JSON.parse(await readBody(request)) as { name?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return send(response, 400, { error: 'name: an organization needs a name' });

      const client = await db.connect();
      try {
        await client.query('begin');
        const created = await client.query<{
          id: string;
          name: string;
          is_personal: boolean;
          created_at: Date;
        }>(
          'insert into organizations (name) values ($1) returning id, name, is_personal, created_at',
          [name],
        );
        // Whoever creates it owns it. There is no state in which an organisation has no owner.
        await client.query(
          `insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')`,
          [created.rows[0]!.id, userId],
        );
        await client.query('commit');
        return send(response, 201, { organization: toOrganization(created.rows[0]!) });
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    }

    const inviteMatch = new RegExp(`^/orgs/(${UUID})/invites$`).exec(path);
    if (inviteMatch && method === 'POST') {
      const organizationId = inviteMatch[1]!;
      // Admin, not owner: inviting people is day-to-day work, and a model where only the owner can
      // grow a team is a model where the owner becomes a bottleneck and shares their password.
      await requireRole(db, organizationId, userId, 'admin');

      const body = InviteRequestSchema.parse(JSON.parse(await readBody(request)));
      const held = await roleIn(db, organizationId, userId);
      // Nobody may invite somebody more powerful than themselves. Without this, an admin promotes a
      // friend to owner and the privilege ladder has a rung that goes upwards.
      if (!held || RoleSchema.options.indexOf(body.role) < RoleSchema.options.indexOf(held)) {
        throw new Forbidden('you cannot invite somebody at a role above your own');
      }

      const { token, hash } = mintToken();
      const expiresAt = new Date(Date.now() + INVITE_LIFETIME_MS);
      const created = await db.query<{ id: string; created_at: Date }>(
        `insert into invites (organization_id, email, role, token_hash, expires_at, created_by)
         values ($1, $2, $3, $4, $5, $6)
         returning id, created_at`,
        [organizationId, body.email.trim().toLowerCase(), body.role, hash, expiresAt, userId],
      );

      const org = await db.query<{ name: string }>('select name from organizations where id = $1', [
        organizationId,
      ]);
      sendInviteEmail(options, {
        email: body.email,
        token,
        organizationName: org.rows[0]?.name ?? 'a workspace',
      });

      const invite: Invite = {
        id: created.rows[0]!.id,
        organizationId,
        email: body.email.trim().toLowerCase(),
        role: body.role,
        // Returned exactly once, to the person who created it. Never listed afterwards, because the
        // database holds only its hash — which is the point.
        token,
        acceptedAt: null,
        expiresAt: expiresAt.toISOString(),
        createdAt: created.rows[0]!.created_at.toISOString(),
      };
      return send(response, 201, { invite });
    }

    if (path === '/invites/accept' && method === 'POST') {
      const body = JSON.parse(await readBody(request)) as { token?: unknown };
      if (typeof body.token !== 'string') {
        return send(response, 400, { error: 'token: an invite token is required' });
      }

      const found = await db.query<{
        id: string;
        organization_id: string;
        role: Role;
        email: string;
        accepted_at: Date | null;
      }>(
        `select id, organization_id, role, email, accepted_at
           from invites
          where token_hash = $1 and expires_at > now()`,
        [hashToken(body.token)],
      );

      const invite = found.rows[0];
      if (!invite || invite.accepted_at) {
        // One answer for expired, unknown and already-used. Distinguishing them tells somebody
        // holding a guessed token which guesses were close.
        return send(response, 404, { error: 'that invite is not valid' });
      }

      const me = await loadUser(db, userId);
      if (me.email !== invite.email) {
        throw new Forbidden('this invite was sent to a different email address');
      }

      const client = await db.connect();
      try {
        await client.query('begin');
        await client.query(
          `insert into memberships (organization_id, user_id, role) values ($1, $2, $3)
             on conflict (organization_id, user_id) do update set role = excluded.role`,
          [invite.organization_id, userId, invite.role],
        );
        await client.query(
          'update invites set accepted_at = now(), accepted_by = $1 where id = $2',
          [userId, invite.id],
        );
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }

      return send(response, 200, {
        membership: {
          organizationId: invite.organization_id,
          userId,
          role: invite.role,
          createdAt: new Date().toISOString(),
        } satisfies Membership,
      });
    }

    const membersMatch = new RegExp(`^/orgs/(${UUID})/members$`).exec(path);
    if (membersMatch && method === 'GET') {
      const organizationId = membersMatch[1]!;
      // Viewer: seeing who else is here is not a privileged act, and hiding it from the people in
      // the room only makes the product feel evasive.
      await requireRole(db, organizationId, userId, 'viewer');

      const members = await db.query<{
        user_id: string;
        role: Role;
        email: string;
        display_name: string;
        created_at: Date;
      }>(
        `select m.user_id, m.role, u.email, u.display_name, m.created_at
           from memberships m
           join users u on u.id = m.user_id
          where m.organization_id = $1
          order by m.created_at`,
        [organizationId],
      );

      return send(response, 200, {
        members: members.rows.map((row) => ({
          userId: row.user_id,
          role: row.role,
          email: row.email,
          displayName: row.display_name,
          createdAt: row.created_at.toISOString(),
        })),
      });
    }

    const projectsMatch = new RegExp(`^/orgs/(${UUID})/projects$`).exec(path);
    if (projectsMatch && method === 'POST') {
      const organizationId = projectsMatch[1]!;
      // Editor: making things is what an editor is for. A viewer may look and no more.
      await requireRole(db, organizationId, userId, 'editor');

      const body = JSON.parse(await readBody(request)) as { name?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return send(response, 400, { error: 'name: a project needs a name' });

      const created = await db.query<{ id: string; name: string; created_at: Date }>(
        `insert into projects (organization_id, name, created_by) values ($1, $2, $3)
         returning id, name, created_at`,
        [organizationId, name, userId],
      );

      return send(response, 201, {
        project: {
          id: created.rows[0]!.id,
          organizationId,
          name: created.rows[0]!.name,
          createdAt: created.rows[0]!.created_at.toISOString(),
        },
      });
    }

    if (projectsMatch && method === 'GET') {
      const organizationId = projectsMatch[1]!;
      await requireRole(db, organizationId, userId, 'viewer');

      const rows = await db.query<{ id: string; name: string; created_at: Date }>(
        'select id, name, created_at from projects where organization_id = $1 order by created_at',
        [organizationId],
      );
      return send(response, 200, {
        projects: rows.rows.map((row) => ({
          id: row.id,
          organizationId,
          name: row.name,
          createdAt: row.created_at.toISOString(),
        })),
      });
    }

    send(response, 404, { error: 'no such endpoint' });
  }
}

async function identify(request: IncomingMessage, auth: AuthProvider): Promise<string> {
  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
  if (!token) throw new Unauthorized('this endpoint needs a session token');

  const userId = await auth.identify(token);
  if (!userId) throw new Unauthorized('that session is not valid');
  return userId;
}

async function loadUser(db: Db, userId: string): Promise<User> {
  const found = await db.query<{
    id: string;
    email: string;
    display_name: string;
    created_at: Date;
  }>('select id, email, display_name, created_at from users where id = $1', [userId]);

  const row = found.rows[0];
  if (!row) throw new NotFound('no such user');
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at.toISOString(),
  };
}

function toOrganization(row: {
  id: string;
  name: string;
  is_personal: boolean;
  created_at: Date;
}): Organization {
  return {
    id: row.id,
    name: row.name,
    isPersonal: row.is_personal,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Delivers an invite.
 *
 * There is no transactional email service configured, and inventing one would mean pretending
 * mail is being sent. So the default logs the link, which is what a developer needs, and the seam
 * is a function somebody passes in — Resend or Postmark is an implementation of it, not a rewrite.
 */
function sendInviteEmail(
  options: ApiOptions,
  invite: { email: string; token: string; organizationName: string },
): void {
  if (options.sendInvite) {
    options.sendInvite(invite);
    return;
  }
  // `warn`, not `log`: an invite token on stdout is a credential in a log file, and the level
  // should say that out loud. It is here at all because the alternative — silently dropping the
  // invite — would look like the feature working.
  console.warn(
    `[api] no email service configured; invite for ${invite.email} to ` +
      `${invite.organizationName} has token ${invite.token}`,
  );
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    // A JSON body here is a few hundred bytes. Anything approaching a megabyte is not a signup.
    if (total > 1024 * 1024) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8') || '{}';
}
