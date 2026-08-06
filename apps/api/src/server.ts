import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { trace } from '@opentelemetry/api';
import { ZodError } from 'zod';
import {
  CORRELATION_HEADER,
  createLogger,
  currentCorrelationId,
  inSpan,
  PROMETHEUS_CONTENT_TYPE,
  serviceMetrics,
  traceCarrier,
} from '@helaengine/telemetry';
import { audit, listAudit } from './audit.js';
import {
  applySubscription,
  claimEvent,
  LimitReached,
  loadSubscription,
  organizationForCustomer,
  requireCustomAssets,
  requireSeat,
  requireStorage,
  usageOf,
} from './billing.js';
import {
  createBillingProvider,
  InvalidSignature,
  LocalBilling,
  type BillingProvider,
} from './billingProvider.js';
import { clientAddress, Throttle } from './throttle.js';
import { createObserver, type ApiTelemetry } from './observability.js';
import {
  AssetCategorySchema,
  entitledTier,
  EXPORTS_PER_PERIOD,
  PLAN_LIMITS,
  PlanTierSchema,
  type BillingSummary,
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
  /**
   * Where finished exports live.
   *
   * Separate from the asset store, and it has to be: the worker writes builds somewhere of its own,
   * and reading them out of the asset directory finds nothing. Different lifetimes too — an asset
   * is permanent and cached forever, an export expires in a day.
   */
  exportStorage?: AssetStorage;
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
  /**
   * Traces, metrics and logs.
   *
   * Optional, and absent means a real tracer with no exporter plus a private registry — see
   * `createApiServer`. The service is instrumented either way; only the destination changes.
   */
  telemetry?: ApiTelemetry;
  /**
   * Who takes the money.
   *
   * Absent means `NoBilling` — enforcement still real, payment simply impossible, which is what a
   * self-hosted install wants. See `billingProvider.ts`.
   */
  billing?: BillingProvider;
  /**
   * Rate limiters, overridable so tests can drive the *boundary* rather than sit through a minute.
   *
   * Injected rather than configured by numbers, because what a test needs is a clock it controls,
   * and `Throttle` already takes one.
   */
  throttles?: {
    loginByAddress?: Throttle;
    loginByAccount?: Throttle;
    signupByAddress?: Throttle;
    inviteByAddress?: Throttle;
  };
  /** Where invite emails would go. Absent means they are logged instead — see `sendInvite`. */
  sendInvite?: (invite: { email: string; token: string; organizationName: string }) => void;
}

export function createApiServer(options: ApiOptions): Server {
  const { db } = options;
  const auth = options.auth ?? new LocalAuthProvider(db);
  const storage =
    options.storage ?? new LocalAssetStorage(process.env['ASSET_ROOT'] ?? '.hela-assets');
  const uploadSecret = options.uploadSecret ?? newUploadSecret();
  const exportStorage =
    options.exportStorage ?? new LocalAssetStorage(process.env['EXPORT_ROOT'] ?? '.hela-exports');
  const queue = options.queue ?? null;

  /**
   * Telemetry, with defaults that do nothing visible.
   *
   * A server built without one still counts, still spans and still logs — to a tracer with no
   * exporter and a registry nobody scrapes. That is deliberate: the instrumented code path is then
   * the *only* code path, so the tests exercise what production runs. What it must not do is
   * chatter, hence `warn` — a test suite that starts forty servers should not print forty thousand
   * request lines.
   */
  const telemetry: ApiTelemetry = options.telemetry ?? {
    tracer: trace.getTracer('helaengine-api'),
    metrics: serviceMetrics(),
    log: createLogger({ service: 'api', level: 'warn' }),
  };
  const observer = createObserver(telemetry, db);
  const billing = options.billing ?? createBillingProvider();

  /**
   * Guessing costs something now (Sprint 34).
   *
   * Two limiters on login, because they answer different questions. The per-account one is the
   * real defence: it stops an attempt on *one* person's password no matter how many addresses it
   * comes from, which is what credential stuffing looks like. The per-address one is a blunter
   * instrument aimed at a single source hammering the endpoint.
   *
   * **The per-address numbers are generous on purpose, and the first version was not.** Five
   * sign-ups an hour per address sounds strict-but-fair until you remember that an office, a
   * school and a co-working space are each *one* address — and the end-to-end suite, which signs
   * up a browser per test, is a fair imitation of exactly that. It locked the suite out, which is
   * the cheapest possible version of the same lesson. An address limit should catch a script, not
   * a building.
   *
   * Every number is overridable, because "generous" depends on who is in front of the server: a
   * public instance and one behind a corporate proxy want different answers.
   */
  const limit = (name: string, fallback: number): number => {
    const configured = Number(process.env[name]);
    return Number.isFinite(configured) && configured > 0 ? configured : fallback;
  };

  const loginByAddress =
    options.throttles?.loginByAddress ??
    new Throttle({ limit: limit('AUTH_LOGINS_PER_MINUTE', 60), windowMs: 60_000 });
  const loginByAccount =
    options.throttles?.loginByAccount ??
    new Throttle({ limit: limit('AUTH_LOGINS_PER_ACCOUNT', 10), windowMs: 15 * 60_000 });
  const signupByAddress =
    options.throttles?.signupByAddress ??
    new Throttle({ limit: limit('AUTH_SIGNUPS_PER_HOUR', 60), windowMs: 60 * 60_000 });
  const inviteByAddress =
    options.throttles?.inviteByAddress ??
    new Throttle({ limit: limit('AUTH_INVITE_ATTEMPTS_PER_HOUR', 30), windowMs: 60 * 60_000 });

  function refuseIfThrottled(
    response: ServerResponse,
    ...results: Array<{ allowed: boolean; retryAfterSeconds: number }>
  ): boolean {
    const blocked = results.find((result) => !result.allowed);
    if (!blocked) return false;
    response.setHeader('retry-after', String(blocked.retryAfterSeconds));
    // A count is deliberately not given back. "You have three attempts left" is a gift to a script
    // and means nothing to a person who mistyped their password.
    send(response, 429, {
      error: 'too many attempts — wait a moment and try again',
    });
    return true;
  }

  return createServer((request, response) => {
    void observer
      .observe(request, response, () => handle(request, response))
      .catch((error: unknown) => {
        /**
         * The richest handler first.
         *
         * This ordering is load-bearing and was wrong once: the generic "does it carry a status"
         * branch below matched `LimitReached` — which does carry one — and answered 402 with only
         * a sentence, throwing away the machine-readable part the editor needs to show an upgrade.
         * The status was right and the body was useless, which is the sort of bug that passes a
         * casual test.
         */
        if (error instanceof LimitReached) {
          send(response, error.status, error.detail);
          return;
        }

        const status = (error as { status?: number }).status;
        if (typeof status === 'number') {
          send(response, status, { error: (error as Error).message });
          return;
        }
        /**
         * A limit is 402, not 403, and carries what was hit.
         *
         * 403 means "you may not", which is a wall. 402 Payment Required means "not on this plan",
         * which is a door — and the body says which limit, what the allowance is, and the cheapest
         * plan that lifts it, so the editor can show an upgrade rather than a toast.
         */
        if (error instanceof InvalidSignature) {
          // 400 rather than 401: there is no session to be unauthorised for, and a provider reading
          // this is a machine that needs to know the request was malformed, not to log in.
          send(response, error.status, { error: error.message });
          return;
        }
        if (error instanceof LimitReached) {
          send(response, error.status, error.detail);
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

    /**
     * CORS: a wildcard by default, an allowlist when one is configured (Sprint 34).
     *
     * The wildcard is not as alarming as it looks, and it is worth writing down why rather than
     * leaving the next reader to work it out. This API authenticates with a bearer token held in
     * `localStorage`, not a cookie — so a hostile page cannot make an authenticated request on a
     * user's behalf the way it could with ambient credentials. `Access-Control-Allow-Credentials`
     * is never sent, and with it absent a browser will not attach cookies to a cross-origin call
     * even if some future change adds them.
     *
     * What the wildcard does cost is that any origin may *attempt* a call, which is a nuisance in
     * logs and a slightly wider surface than necessary. `ALLOWED_ORIGINS` narrows it for a
     * deployment that knows where its editor is served from — which a hosted deployment does and a
     * self-hosted one usually does not, hence the default.
     */
    const allowed = (process.env['ALLOWED_ORIGINS'] ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    const origin = request.headers.origin;

    if (allowed.length === 0) {
      response.setHeader('access-control-allow-origin', '*');
    } else if (origin !== undefined && allowed.includes(origin)) {
      // Echoed rather than listed: the header takes one origin, so a server with an allowlist has
      // to answer per request — and `Vary` keeps a cache from serving one origin's answer to
      // another, which is the mistake that makes an allowlist worse than a wildcard.
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'origin');
    }

    response.setHeader(
      'access-control-allow-headers',
      'content-type, authorization, x-correlation-id',
    );
    response.setHeader('access-control-expose-headers', CORRELATION_HEADER);
    // PUT is here for the upload route, and it is not optional: `model/gltf-binary` is not a
    // CORS-safelisted content type, so a browser preflights the upload — and a preflight that does
    // not name PUT fails as "Failed to fetch", with the row left saying "Processing…" forever.
    response.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    // A preflight per upload is a round trip nobody needs; the answer does not change.
    response.setHeader('access-control-max-age', '86400');
    if (method === 'OPTIONS') return void response.writeHead(204).end();

    if (path === '/health') return send(response, 200, { ok: true });

    /**
     * The scrape endpoint.
     *
     * Before `identify`, because Prometheus has no session and no interest in getting one. That
     * makes the exposure worth being explicit about: these numbers are counts and latencies, never
     * user data, but they do describe the shape of the business — how many exports, how many
     * organisations are active. `METRICS_TOKEN` closes it when the port is reachable from
     * somewhere it should not be; the usual deployment keeps it on a private network instead.
     */
    if (path === '/metrics' && method === 'GET') {
      const expected = telemetry.metricsToken ?? process.env['METRICS_TOKEN'];
      if (expected !== undefined && expected !== '' && !bearerMatches(request, expected)) {
        return send(response, 401, { error: 'this endpoint needs the metrics token' });
      }
      response.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE });
      response.end(observer.scrape());
      return;
    }

    if (path === '/auth/signup' && method === 'POST') {
      if (refuseIfThrottled(response, signupByAddress.check(clientAddress(request)))) return;

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
      const email = body.email.trim().toLowerCase();
      // Checked before the password is verified, so a throttled attempt costs no scrypt — the point
      // of the limit is that guessing is expensive for the attacker and cheap for the server.
      if (
        refuseIfThrottled(
          response,
          loginByAddress.check(clientAddress(request)),
          loginByAccount.check(email),
        )
      ) {
        return;
      }
      const found = await db.query<{ id: string; password_hash: string | null }>(
        'select id, password_hash from users where email = $1',
        [email],
      );

      const row = found.rows[0];
      // The same answer for "no such user" and "wrong password", and the hash is verified even when
      // there is no user — otherwise the response time says which of the two it was.
      const ok = await verifyPassword(body.password, row?.password_hash ?? null);
      if (!row || !ok) return send(response, 401, { error: 'those credentials are not valid' });

      // Forgotten on success: somebody who mistypes twice and then gets it right should not be
      // one attempt from a lockout for the next quarter of an hour.
      loginByAccount.clear(email);

      const session = await createSession(db, row.id);
      return send(response, 200, {
        session: { token: session.token, expiresAt: session.expiresAt.toISOString() },
      });
    }

    /**
     * Signing out, on the server as well as in the tab.
     *
     * Until now "sign out" only dropped the token from the browser, which means a token copied from
     * a shared machine stayed valid for its full fourteen days. Revoking the row is the difference
     * between a session ending and a session being forgotten about.
     *
     * Only the presented token is revoked, not every session the user has: signing out of a library
     * computer should not log somebody out of their phone.
     */
    if (path === '/auth/session' && method === 'DELETE') {
      const header = request.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
      if (token) await db.query('delete from sessions where token_hash = $1', [hashToken(token)]);
      // 204 whether or not the token was real: an endpoint that says "no such session" is an
      // oracle for testing stolen tokens, and there is nothing useful for a caller to do with it.
      response.writeHead(204).end();
      return;
    }

    /**
     * The webhook, where money becomes entitlement.
     *
     * Before `identify`, and it has to be: a payment provider holds no session. What authorises it
     * is the signature over the raw body, which is why the body is read as text and verified before
     * anything is parsed — verifying a *re-serialised* object is the classic way to make a
     * signature check that passes for payloads it should not.
     *
     * Every event is claimed by id first. Providers deliver at least once and mean it, so a
     * redelivered `invoice.paid` is a second upgrade and a redelivered deletion arriving after an
     * upgrade would undo it.
     */
    /**
     * The local provider's checkout page.
     *
     * A real page a browser lands on, with a button that completes the purchase — served by this
     * API because `LocalBilling` has no hosted one. It exists so the *whole* flow can be walked and
     * tested: press upgrade in the editor, land here, pay, get a webhook, watch the entitlement
     * change. A mock that returned a canned session would skip every part where this goes wrong.
     *
     * Only reachable when `BILLING_LOCAL_SECRET` is set, which is opt-in precisely because a
     * deployment that accepted pretend payments by accident would be a very bad surprise.
     */
    if (path === '/billing/checkout' && method === 'GET') {
      if (!(billing instanceof LocalBilling)) return void response.writeHead(404).end();

      const organizationId = url.searchParams.get('organizationId') ?? '';
      const tier = PlanTierSchema.safeParse(url.searchParams.get('tier'));
      const back = url.searchParams.get('successUrl') ?? '/';
      if (!organizationId || !tier.success) {
        return send(response, 400, { error: 'that checkout link is not valid' });
      }

      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(localCheckoutPage(organizationId, tier.data, back));
      return;
    }

    if (path === '/billing/checkout' && method === 'POST') {
      if (!(billing instanceof LocalBilling)) return void response.writeHead(404).end();

      const body = JSON.parse(await readBody(request)) as {
        organizationId?: unknown;
        tier?: unknown;
      };
      const organizationId = typeof body.organizationId === 'string' ? body.organizationId : '';
      const tier = PlanTierSchema.safeParse(body.tier);
      if (!organizationId || !tier.success) {
        return send(response, 400, { error: 'that checkout is not valid' });
      }

      /**
       * The payment "succeeds", and then this posts itself a webhook.
       *
       * Deliberately the long way round rather than writing the subscription directly: the webhook
       * is how entitlement changes in production, so making the local flow take the same path means
       * the signature check, the idempotency claim and the audit entry are all exercised by an
       * ordinary upgrade rather than only by a test that targets them.
       */
      const payload = JSON.stringify({
        id: `evt_local_${randomUUID()}`,
        type: 'checkout.session.completed',
        organizationId,
        customer: organizationId,
        subscription: `sub_local_${organizationId.slice(0, 8)}`,
        tier: tier.data,
        status: 'active',
        currentPeriodEnd: Date.now() + 30 * 24 * 60 * 60 * 1000,
      });

      const delivered = await fetch(`${selfOrigin(request)}/billing/webhook`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-billing-signature': billing.sign(payload),
        },
        body: payload,
      });

      return send(response, delivered.ok ? 200 : 502, { ok: delivered.ok });
    }

    if (path === '/billing/webhook' && method === 'POST') {
      const raw = await readBody(request);
      const event = billing.interpret(
        raw,
        headerValue(request, 'stripe-signature') ?? headerValue(request, 'x-billing-signature'),
      );

      if (!(await claimEvent(db, event.id, event.type))) {
        // Already handled. 200, because a provider that gets anything else retries for hours.
        return send(response, 200, { ok: true, duplicate: true });
      }

      if (!event.change) return send(response, 200, { ok: true, ignored: event.type });

      const organizationId =
        event.change.organizationId ??
        (await organizationForCustomer(db, event.change.externalCustomer));

      if (!organizationId) {
        // A paid subscription this system cannot attribute. 200 so the provider stops retrying,
        // and loud in the log because it means somebody is paying for nothing.
        telemetry.log.error('billing event names no organisation this system knows', {
          event: event.id,
          type: event.type,
          customer: event.change.externalCustomer,
        });
        return send(response, 200, { ok: true, unattributed: true });
      }

      const before = await loadSubscription(db, organizationId);
      const after = await applySubscription(db, {
        organizationId,
        tier: event.change.tier,
        status: event.change.status,
        externalId: event.change.externalId,
        externalCustomer: event.change.externalCustomer || organizationId,
        currentPeriodEnd: event.change.currentPeriodEnd,
        cancelAt: event.change.cancelAt,
      });

      await audit(
        db,
        {
          organizationId,
          // No actor: this is the provider talking, not a person. A user id here would be a lie
          // about who did it.
          actorUserId: null,
          action: 'billing.changed',
          subject: event.change.externalId,
          detail: {
            from: `${before.tier}/${before.status}`,
            to: `${after.tier}/${after.status}`,
            event: event.type,
          },
        },
        telemetry.log,
      );

      return send(response, 200, { ok: true });
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
      // Checked once the size is known, which is the only moment it can be: a ticket is issued
      // before anybody knows how big the file is. Refusing here costs the upload, which is why the
      // *feature* gate above happens at ticket time — a free-tier user never gets this far.
      await requireStorage(db, ticket.organizationId, bytes.byteLength);

      const asset = await completeUpload(db, storage, {
        organizationId: ticket.organizationId,
        assetId: ticket.assetId,
        bytes,
      });
      return send(response, asset.status === 'ready' ? 200 : 422, { asset });
    }

    /**
     * Downloading a finished build.
     *
     * Placed before `identify` for one reason: a browser's own download manager cannot send an
     * `Authorization` header, and pulling a 200 MB zip through `fetch` into a Blob first is exactly
     * the tab-memory problem this whole feature exists to avoid — reintroduced at the last step.
     *
     * So the token may arrive in the query here, and **only** here. A credential in a URL can end
     * up in a history entry or a referrer, which is why it is not a global convenience: every other
     * route still requires the header. The link is not the permission either — membership of the
     * job's organisation is checked exactly as it would be anywhere else.
     */
    const downloadMatch = new RegExp(`^/export-jobs/(${UUID})/download$`).exec(path);
    if (downloadMatch && method === 'GET') {
      const header = request.headers.authorization;
      const token = header?.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : (url.searchParams.get('token') ?? '');
      if (!token) throw new Unauthorized('this endpoint needs a session token');

      const downloader = await auth.identify(token);
      if (!downloader) throw new Unauthorized('that session is not valid');

      const job = await loadExportJob(db, downloadMatch[1]!);
      await requireRole(db, job.organizationId, downloader, 'viewer');
      requireDownloadable(job);

      const bytes = exportStorage.read(job.artifactPath!);
      if (!bytes) {
        // The row says there is an artifact and storage disagrees. Reported as gone rather than as
        // a 500: from the user's side it *is* gone, and telling them to export again is the fix.
        return send(response, 404, {
          error: 'that build is no longer available — export the project again',
        });
      }

      // A build is the thing that leaves the building — the one artefact a customer can hand to
      // somebody outside their organisation — so who took a copy, and when, is worth keeping.
      await audit(
        db,
        {
          organizationId: job.organizationId,
          actorUserId: downloader,
          action: 'export.downloaded',
          subject: job.id,
          detail: { projectId: job.projectId, bytes: bytes.byteLength },
        },
        telemetry.log,
      );

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

    const fileMatch = /^\/assets\/(.+)$/.exec(path);
    // HEAD as well as GET, because this is the CDN-facing path and HEAD is how a cache asks
    // whether it still has the right bytes. Matching GET alone sent HEAD down to the authenticated
    // routes below, where it became a 401 — a CDN or a `curl -I` being told this public,
    // content-addressed URL required a login.
    if (fileMatch && (method === 'GET' || method === 'HEAD')) {
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
      // Before the invite is written, not after: a limit enforced afterwards is a limit that has
      // already been exceeded. Outstanding invitations count as seats — see `requireSeat`.
      await requireSeat(db, organizationId);
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

      await audit(
        db,
        {
          organizationId,
          actorUserId: userId,
          action: 'member.invited',
          subject: body.email.trim().toLowerCase(),
          // The role is the part somebody reviewing wants: an invite to `viewer` and an invite to
          // `owner` are very different events with the same name.
          detail: { role: body.role },
        },
        telemetry.log,
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
      // An invite token is 256 bits of randomness, so this is not what stops it being guessed —
      // it stops somebody trying to, which is also what makes the attempt visible in the metrics.
      if (refuseIfThrottled(response, inviteByAddress.check(clientAddress(request)))) return;

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

      await audit(
        db,
        {
          organizationId: invite.organization_id,
          actorUserId: userId,
          action: 'member.joined',
          subject: userId,
          detail: { role: invite.role, email: invite.email },
        },
        telemetry.log,
      );

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

    /**
     * The trail, for the people who own it.
     *
     * Admin, not viewer: an audit log names who did what, which is exactly the sort of thing a
     * disgruntled member should not be able to read on their way out. And it is per organisation,
     * because there is no such thing as a global view of it in a multi-tenant product.
     */
    /**
     * The billing screen, in one response.
     *
     * Viewer rather than admin: everybody in an organisation benefits from knowing that four of
     * five exports are spent, and a meter only the owner can see is a meter nobody looks at until
     * it is empty. Changing the plan is a different matter — see the checkout route.
     */
    const billingMatch = new RegExp(`^/orgs/(${UUID})/billing$`).exec(path);
    if (billingMatch && method === 'GET') {
      const organizationId = billingMatch[1]!;
      await requireRole(db, organizationId, userId, 'viewer');

      const subscription = await loadSubscription(db, organizationId);
      return send(response, 200, {
        subscription,
        limits: PLAN_LIMITS[entitledTier(subscription)],
        usage: await usageOf(db, organizationId),
        // False on a self-hosted install, and the editor shows the plan without an upgrade button
        // rather than a button that fails.
        checkoutAvailable: billing.available,
      } satisfies BillingSummary);
    }

    const checkoutMatch = new RegExp(`^/orgs/(${UUID})/billing/checkout$`).exec(path);
    if (checkoutMatch && method === 'POST') {
      const organizationId = checkoutMatch[1]!;
      // Owner. Changing what an organisation pays is not day-to-day work, and an admin who can
      // invite people should not also be able to commit the owner to a larger monthly bill.
      await requireRole(db, organizationId, userId, 'owner');

      const body = JSON.parse(await readBody(request)) as { tier?: unknown; returnUrl?: unknown };
      const tier = PlanTierSchema.safeParse(body.tier);
      if (!tier.success) {
        return send(response, 400, {
          error: `tier: must be one of ${PlanTierSchema.options.join(', ')}`,
        });
      }
      if (tier.data === 'free') {
        return send(response, 400, {
          error: 'To move down to Free, cancel from the billing portal.',
        });
      }

      const returnUrl = typeof body.returnUrl === 'string' ? body.returnUrl : '/';
      const subscription = await loadSubscription(db, organizationId);
      const session = await billing.checkout({
        organizationId,
        tier: tier.data,
        successUrl: returnUrl,
        cancelUrl: returnUrl,
        externalCustomer: subscription.externalId === null ? null : organizationId,
      });

      return send(response, 200, { url: session.url });
    }

    const portalMatch = new RegExp(`^/orgs/(${UUID})/billing/portal$`).exec(path);
    if (portalMatch && method === 'POST') {
      const organizationId = portalMatch[1]!;
      await requireRole(db, organizationId, userId, 'owner');

      const body = JSON.parse(await readBody(request)) as { returnUrl?: unknown };
      const portal = await billing.portal(
        organizationId,
        typeof body.returnUrl === 'string' ? body.returnUrl : '/',
      );
      if (!portal) {
        return send(response, 409, { error: 'there is no subscription to manage yet' });
      }
      return send(response, 200, { url: portal.url });
    }

    const auditMatch = new RegExp(`^/orgs/(${UUID})/audit$`).exec(path);
    if (auditMatch && method === 'GET') {
      const organizationId = auditMatch[1]!;
      await requireRole(db, organizationId, userId, 'admin');
      const limit = Number(url.searchParams.get('limit') ?? 100);
      return send(response, 200, {
        entries: await listAudit(db, organizationId, Number.isFinite(limit) ? limit : 100),
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
      await audit(
        db,
        {
          organizationId,
          actorUserId: userId,
          action: 'project.created',
          subject: project.id,
          detail: { name: project.name },
        },
        telemetry.log,
      );

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
        // Written after the delete rather than before: an entry for something that did not happen
        // is worse than a missing one, because it is indistinguishable from one that did.
        await audit(
          db,
          {
            organizationId,
            actorUserId: userId,
            action: 'project.deleted',
            subject: projectId,
            detail: { name: loaded.project.name },
          },
          telemetry.log,
        );
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
        await audit(
          db,
          {
            organizationId,
            actorUserId: userId,
            action: 'project.restored',
            subject: projectId,
            detail: { version: Number(restoreMatch[1]) },
          },
          telemetry.log,
        );
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
        const job = await inSpan(
          telemetry.tracer,
          'export.record',
          { 'hela.project_id': projectId },
          () =>
            createExportJob(db, {
              projectId,
              organizationId,
              sceneVersion: loaded.version,
              userId,
              // Stored on the row so a build somebody complains about can be turned back into the
              // request that made it, months later, without a tracing backend.
              correlationId: currentCorrelationId(),
            }),
        );

        if (queue) {
          // Its own span because "the queue accepted it" is a distinct claim from "the row
          // exists", and the gap between the two is exactly where a job that never starts lives.
          await inSpan(telemetry.tracer, 'export.enqueue', { 'hela.job_id': job.id }, async () => {
            await queue.add(
              'export',
              {
                jobId: job.id,
                projectId,
                organizationId,
                sceneVersion: loaded.version,
                correlationId: currentCorrelationId(),
                // The W3C `traceparent`, carried by hand because a queue has no headers. This is
                // what makes the worker's spans children of this request rather than an unrelated
                // trace that happens to be about the same job.
                carrier: traceCarrier(),
              },
              JOB_OPTIONS,
            );
          });
        }

        await audit(
          db,
          {
            organizationId,
            actorUserId: userId,
            action: 'export.requested',
            subject: job.id,
            // An export is the expensive operation and the one that produces something shareable,
            // so both the project and the version it built are worth keeping.
            detail: { projectId, sceneVersion: loaded.version },
          },
          telemetry.log,
        );

        return send(response, 202, { job });
      }

      if (suffix === '/exports' && method === 'GET') {
        await requireRole(db, organizationId, userId, 'viewer');
        return send(response, 200, { jobs: await listExportJobs(db, projectId) });
      }
    }

    const exportJobMatch = new RegExp(`^/export-jobs/(${UUID})$`).exec(path);
    if (exportJobMatch && method === 'GET') {
      const job = await loadExportJob(db, exportJobMatch[1]!);
      // Membership in the job's organisation, checked before anything about the job is revealed —
      // including whether it exists.
      await requireRole(db, job.organizationId, userId, 'viewer');

      return send(response, 200, { job, downloadable: artifactIsDownloadable(job) });
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
      // The one hard feature gate. Refused here, before a ticket is issued, so a free-tier user is
      // told why at the moment they press the button rather than after uploading 20 MB.
      await requireCustomAssets(db, organizationId);

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
      await audit(
        db,
        {
          organizationId: assetMatch[1]!,
          actorUserId: userId,
          action: 'asset.deleted',
          subject: assetMatch[2]!,
        },
        telemetry.log,
      );
      response.writeHead(204).end();
      return;
    }

    send(response, 404, { error: 'no such endpoint' });
  }
}

/**
 * A shared-secret check for `/metrics`, in constant time.
 *
 * `===` on a secret leaks its length and its matching prefix through timing. That is a thin attack
 * against a scrape token and a real one against anything else, and the habit is worth more than the
 * argument about whether this particular token is worth defending.
 */
/**
 * The local checkout page.
 *
 * Plain HTML with no framework and no styling to speak of, because it is a stand-in for a hosted
 * page that a payment provider would render — making it pretty would be effort spent on the part
 * that gets deleted the day a Stripe key appears.
 */
function localCheckoutPage(organizationId: string, tier: string, back: string): string {
  const escaped = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Upgrade to ${escaped(tier)}</title></head>
<body style="font-family: system-ui; max-width: 32rem; margin: 4rem auto; line-height: 1.5">
  <h1>Upgrade to ${escaped(tier)}</h1>
  <p><strong>This deployment is not connected to a payment provider.</strong> No card is taken and
  no money moves. Pressing the button below does exactly what a completed payment would do: it
  delivers a signed webhook, and your plan changes.</p>
  <button id="pay" style="font-size: 1rem; padding: 0.6rem 1.2rem">Complete the upgrade</button>
  <p id="state" role="status"></p>
  <script>
    document.getElementById('pay').addEventListener('click', async () => {
      document.getElementById('state').textContent = 'Working…';
      const response = await fetch('/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: ${JSON.stringify(organizationId)}, tier: ${JSON.stringify(tier)} }),
      });
      document.getElementById('state').textContent = response.ok ? 'Done. Returning…' : 'That failed.';
      if (response.ok) setTimeout(() => { window.location.href = ${JSON.stringify(back)}; }, 600);
    });
  </script>
</body>
</html>`;
}

/** Where this server is reachable from, for the local provider posting itself a webhook. */
function selfOrigin(request: IncomingMessage): string {
  return `http://${request.headers.host ?? 'localhost'}`;
}

/** One header value, since Node hands back `string | string[]`. */
function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearerMatches(request: IncomingMessage, expected: string): boolean {
  const header = request.headers.authorization ?? '';
  const offered = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = Buffer.from(offered);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
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
