import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import {
  AssetCategorySchema,
  EXPORTS_PER_PERIOD,
  InviteRequestSchema,
  remainingExports,
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
import { Forbidden, NotFound, requireRole, roleIn, TooLarge, Unauthorized } from './roles.js';
import {
  artifactIsDownloadable,
  createExportJob,
  exportsUsed,
  listExportJobs,
  loadExportJob,
  planTier,
  requireDownloadable,
} from './exportJobs.js';
import { JOB_OPTIONS, type ExportQueue } from './queue.js';
import {
  createProject,
  deleteProject,
  listProjects,
  listVersions,
  loadProject,
  restoreVersion,
  saveVersion,
  updateProject,
} from './projects.js';
import {
  beginUpload,
  completeUpload,
  deleteAsset,
  listAssets,
  LocalAssetStorage,
  MAX_ASSET_BYTES,
  newUploadSecret,
  signTicket,
  TICKET_LIFETIME_MS,
  uploadUrl,
  verifyTicket,
  type AssetStorage,
} from './assets.js';

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
  /** Where uploaded assets live. Local files stand in for object storage — see `assets.ts`. */
  storage?: AssetStorage;
  /** Signs upload tickets. Generated per process when absent, which invalidates tickets on restart. */
  uploadSecret?: string;
  /**
   * Where export jobs are handed to the worker.
   *
   * Optional, and absent is a working configuration rather than a broken one: the API still records
   * the job and still enforces quota, the work simply waits until a queue exists. That is what lets
   * the account tests run without Redis.
   */
  queue?: ExportQueue;
  auth?: AuthProvider;
  /** Where invite emails would go. Absent means they are logged instead — see `sendInvite`. */
  sendInvite?: (invite: { email: string; token: string; organizationName: string }) => void;
}

export function createApiServer(options: ApiOptions): Server {
  const { db } = options;
  const auth = options.auth ?? new LocalAuthProvider(db);
  const storage =
    options.storage ?? new LocalAssetStorage(process.env['ASSET_ROOT'] ?? '.hela-assets');
  const uploadSecret = options.uploadSecret ?? newUploadSecret();
  const queue = options.queue ?? null;

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
    // PUT is here for the upload route, and it is not optional: `model/gltf-binary` is not a
    // CORS-safelisted content type, so a browser preflights the upload — and a preflight that does
    // not name PUT fails as "Failed to fetch", with the row left saying "Processing…" forever.
    response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    // A preflight per upload is a round trip nobody needs; the answer does not change.
    response.setHeader('access-control-max-age', '86400');
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

    const uploadMatch = new RegExp(`^/uploads/(${UUID})/([a-z0-9_]+)$`).exec(path);
    if (uploadMatch && method === 'PUT') {
      // Deliberately before `identify`. The ticket *is* the authorisation — that is what makes a
      // direct browser-to-storage upload possible at all, and it is why the ticket is short-lived
      // and signed rather than merely unguessable.
      const ticket = {
        organizationId: uploadMatch[1]!,
        assetId: uploadMatch[2]!,
        expiresAt: Number(url.searchParams.get('expires') ?? 0),
        signature: url.searchParams.get('signature') ?? '',
      };
      verifyTicket(uploadSecret, ticket);

      const bytes = await readBytes(request);
      const asset = await completeUpload(db, storage, {
        organizationId: ticket.organizationId,
        assetId: ticket.assetId,
        bytes,
      });
      return send(response, asset.status === 'ready' ? 200 : 422, { asset });
    }

    const fileMatch = /^\/assets\/(.+)$/.exec(path);
    if (fileMatch && method === 'GET') {
      // Also unauthenticated, and also on purpose: this is the path a CDN sits in front of, and a
      // CDN holds no session. The protection is that the path contains a content hash nobody can
      // guess — the same bargain the share service makes for an unlisted build.
      const bytes = storage.read(decodeURIComponent(fileMatch[1]!));
      if (!bytes) return send(response, 404, { error: 'no such asset' });

      response.writeHead(200, {
        'content-type': fileMatch[1]!.endsWith('.glb') ? 'model/gltf-binary' : 'image/png',
        // Forever. The path is content-addressed, so these bytes can never change — different
        // bytes get a different URL, which is what makes a CDN need no invalidation strategy.
        'cache-control': 'public, max-age=31536000, immutable',
        'content-length': bytes.byteLength,
      });
      response.end(Buffer.from(bytes));
      return;
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

      const body = JSON.parse(await readBody(request)) as { name?: unknown; scene?: unknown };
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) return send(response, 400, { error: 'name: a project needs a name' });

      const project = await createProject(db, {
        organizationId,
        name,
        userId,
        ...(body.scene === undefined ? {} : { scene: body.scene }),
      });
      return send(response, 201, { project });
    }

    if (projectsMatch && method === 'GET') {
      const organizationId = projectsMatch[1]!;
      await requireRole(db, organizationId, userId, 'viewer');
      return send(response, 200, { projects: await listProjects(db, organizationId) });
    }

    // Everything below is about one project. The organisation it belongs to decides who may touch
    // it, so it is looked up once and the role checked against that — a project id in a URL is not
    // an authorisation, and treating it as one is how tenants leak into each other.
    const projectMatch = new RegExp(
      `^/projects/(${UUID})(/versions|/versions/[0-9]+/restore|/exports)?$`,
    ).exec(path);
    if (projectMatch) {
      const projectId = projectMatch[1]!;
      const suffix = projectMatch[2] ?? '';
      const loaded = await loadProject(db, projectId);
      if (!loaded) throw new NotFound('no such project');

      const organizationId = loaded.project.organizationId;

      if (suffix === '' && method === 'GET') {
        await requireRole(db, organizationId, userId, 'viewer');
        return send(response, 200, {
          project: loaded.project,
          scene: loaded.scene,
          version: loaded.version,
        });
      }

      if (suffix === '' && method === 'PATCH') {
        await requireRole(db, organizationId, userId, 'editor');
        const body = JSON.parse(await readBody(request)) as {
          name?: unknown;
          thumbnail?: unknown;
        };
        await updateProject(db, {
          projectId,
          ...(typeof body.name === 'string' ? { name: body.name.trim() } : {}),
          ...(typeof body.thumbnail === 'string' ? { thumbnail: body.thumbnail } : {}),
        });
        return send(response, 200, { project: (await loadProject(db, projectId))!.project });
      }

      if (suffix === '' && method === 'DELETE') {
        // Admin, not editor. Deleting is the one action in this API that removes somebody else's
        // work from view, and it should take more than the role that creates things.
        await requireRole(db, organizationId, userId, 'admin');
        await deleteProject(db, projectId);
        // 204 means "no content", and a body attached to one is invalid HTTP that clients are
        // entitled to choke on — `response.json()` certainly does.
        response.writeHead(204).end();
        return;
      }

      if (suffix === '/versions' && method === 'GET') {
        await requireRole(db, organizationId, userId, 'viewer');
        return send(response, 200, { versions: await listVersions(db, projectId) });
      }

      if (suffix === '/versions' && method === 'POST') {
        await requireRole(db, organizationId, userId, 'editor');
        const body = JSON.parse(await readBody(request)) as {
          scene?: unknown;
          baseVersion?: unknown;
        };
        if (typeof body.baseVersion !== 'number') {
          // Required rather than defaulted. A save with no idea what it is based on is a save that
          // silently wins every race, which is the opposite of what this field is for.
          return send(response, 400, {
            error: 'baseVersion: a save must say which version it was based on',
          });
        }
        const saved = await saveVersion(db, {
          projectId,
          userId,
          scene: body.scene,
          baseVersion: body.baseVersion,
        });
        return send(response, 201, saved);
      }

      const restoreMatch = /^\/versions\/([0-9]+)\/restore$/.exec(suffix);
      if (restoreMatch && method === 'POST') {
        await requireRole(db, organizationId, userId, 'editor');
        const restored = await restoreVersion(db, {
          projectId,
          userId,
          version: Number(restoreMatch[1]),
        });
        return send(response, 201, restored);
      }

      if (suffix === '/exports' && method === 'POST') {
        // Editor, not viewer: an export is a build somebody can hand out, and it costs minutes of
        // CPU. Somebody with read access to a project has not been given the right to spend that.
        await requireRole(db, organizationId, userId, 'editor');

        if (loaded.version === 0) {
          return send(response, 400, {
            error: 'Save the project before exporting it — there is no version to build from.',
          });
        }

        // The row first, then the message. If enqueueing fails the user sees a job that never
        // starts, which is recoverable; if the message went first, a crash between the two would
        // hand the worker a job id that does not exist.
        const job = await createExportJob(db, {
          projectId,
          organizationId,
          sceneVersion: loaded.version,
          userId,
        });

        if (queue) {
          await queue.add(
            'export',
            {
              jobId: job.id,
              projectId,
              organizationId,
              sceneVersion: loaded.version,
            },
            JOB_OPTIONS,
          );
        }

        return send(response, 202, { job });
      }

      if (suffix === '/exports' && method === 'GET') {
        await requireRole(db, organizationId, userId, 'viewer');
        return send(response, 200, { jobs: await listExportJobs(db, projectId) });
      }
    }

    const exportJobMatch = new RegExp(`^/export-jobs/(${UUID})(/download)?$`).exec(path);
    if (exportJobMatch && method === 'GET') {
      const job = await loadExportJob(db, exportJobMatch[1]!);
      // Membership in the job's organisation, checked before anything about the job is revealed —
      // including whether it exists.
      await requireRole(db, job.organizationId, userId, 'viewer');

      if (exportJobMatch[2] !== '/download') {
        return send(response, 200, { job, downloadable: artifactIsDownloadable(job) });
      }

      requireDownloadable(job);
      const bytes = storage.read(job.artifactPath!);
      if (!bytes) {
        // The row says there is an artifact and storage disagrees. Reported as gone rather than as
        // a 500: from the user's side it *is* gone, and telling them to export again is the fix.
        return send(response, 404, {
          error: 'that build is no longer available — export the project again',
        });
      }

      response.writeHead(200, {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${exportFilename(job.projectId)}"`,
        'content-length': bytes.byteLength,
        // Never cached: the URL is stable but what it serves expires, and a cached copy would
        // outlive the expiry the whole design rests on.
        'cache-control': 'no-store',
      });
      response.end(Buffer.from(bytes));
      return;
    }

    const quotaMatch = new RegExp(`^/orgs/(${UUID})/export-quota$`).exec(path);
    if (quotaMatch && method === 'GET') {
      const organizationId = quotaMatch[1]!;
      await requireRole(db, organizationId, userId, 'viewer');

      const tier = await planTier(db, organizationId);
      const used = await exportsUsed(db, organizationId);
      // Shown *before* somebody presses Export, so running out is something they saw coming rather
      // than something that happened to them.
      return send(response, 200, {
        tier,
        used,
        limit: EXPORTS_PER_PERIOD[tier],
        remaining: remainingExports(tier, used),
      });
    }

    const assetsMatch = new RegExp(`^/orgs/(${UUID})/assets$`).exec(path);
    if (assetsMatch && method === 'GET') {
      const organizationId = assetsMatch[1]!;
      await requireRole(db, organizationId, userId, 'viewer');
      return send(response, 200, {
        assets: await listAssets(db, organizationId, {
          ...(url.searchParams.get('category')
            ? { category: url.searchParams.get('category')! }
            : {}),
          // Pending and failed rows are the upload UI's whole point, so they are included for the
          // organisation asking — and never for anybody else.
          includePending: true,
        }),
      });
    }

    if (assetsMatch && method === 'POST') {
      const organizationId = assetsMatch[1]!;
      // Editor: uploading an asset is making something, which is what the role is for.
      await requireRole(db, organizationId, userId, 'editor');

      const body = JSON.parse(await readBody(request)) as {
        assetId?: unknown;
        name?: unknown;
        category?: unknown;
      };
      const assetId = typeof body.assetId === 'string' ? body.assetId.trim() : '';
      // The id becomes part of a storage key and of every scene that places it, so it is held to
      // the same shape the curated library uses rather than to whatever was typed.
      if (!/^[a-z0-9_]{3,60}$/.test(assetId)) {
        return send(response, 400, {
          error: 'assetId: lower-case letters, digits and underscores, 3 to 60 characters',
        });
      }

      // The same closed vocabulary the curated library uses, parsed rather than trusted. An
      // uploaded asset that landed in a category the schema does not know would be a card the
      // library panel could render and no filter could ever reach.
      const category = AssetCategorySchema.safeParse(body.category ?? 'props');
      if (!category.success) {
        return send(response, 400, {
          error: `category: must be one of ${AssetCategorySchema.options.join(', ')}`,
        });
      }

      const asset = await beginUpload(db, {
        organizationId,
        assetId,
        name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : assetId,
        category: category.data,
        userId,
      });

      // The ticket, not the bytes. Issuing a short-lived signed permit and letting the upload go
      // straight to storage is what keeps a 25 MB file from travelling through the API's request
      // path twice — and it is the same shape a presigned S3 URL has.
      const ticket = signTicket(uploadSecret, {
        assetId,
        organizationId,
        expiresAt: Date.now() + TICKET_LIFETIME_MS,
      });

      return send(response, 201, {
        asset,
        // The URL carries the signature, so the client PUTs to it and needs to know nothing about
        // how a ticket is put together. That is what makes swapping in a real presigned S3 URL a
        // change to this line rather than to the uploader.
        upload: { url: uploadUrl(ticket), ticket, maxBytes: MAX_ASSET_BYTES },
      });
    }

    const assetMatch = new RegExp(`^/orgs/(${UUID})/assets/([a-z0-9_]+)$`).exec(path);
    if (assetMatch && method === 'DELETE') {
      await requireRole(db, assetMatch[1]!, userId, 'editor');
      await deleteAsset(db, assetMatch[1]!, assetMatch[2]!);
      response.writeHead(204).end();
      return;
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

/** A filename somebody can find in their downloads folder. */
function exportFilename(projectId: string): string {
  return `helaengine-export-${projectId.slice(0, 8)}.zip`;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/** Raw bytes, for an upload. Limited as it arrives rather than after it is all in memory. */
async function readBytes(request: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    // Thrown as soon as the limit is passed rather than after the whole body arrives: the point of
    // a limit is to stop holding the bytes, and a 25 MB cap enforced at byte 26 million is not one.
    if (total > MAX_ASSET_BYTES) throw new TooLarge('that file is larger than 25 MB');
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
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
