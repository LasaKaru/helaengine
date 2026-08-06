# Security and compliance

What this system does about security, what it deliberately does not do yet, and where the evidence
for each claim is. Written in Sprint 34, before there is customer data to lose — which is the only
time this document is cheap to write.

It exists mostly to shorten a conversation. An enterprise security questionnaire asks the same
thirty questions every time, and most of them have answers here with a file and a test beside them.
Where the answer is "not yet", it says so plainly: a compliance document that overstates its
coverage is worse than none, because it converts a known gap into a surprise.

## The one guarantee everything rests on

**A scene document is data. It is never code.**

Behaviours, triggers, HUD bindings, unlock methods, weapon definitions and repair patches are all
closed vocabularies, validated by Zod schemas, dispatched through switch statements. There is no
`eval`, no `new Function`, no dynamic import of anything a document names.

This matters more here than in most products because of what a document is: it is shared live with
collaborators, it is built into a game handed to strangers, and — since Sprint 25 — a language model
proposes edits to it. If any of those could carry code, a shared project would be remote code
execution in every collaborator's browser, and the repair loop would be a model writing code into
somebody else's game.

**Evidence:** `no-eval`, `no-implied-eval` and `no-new-func` in `eslint.config.js`, a matching
Semgrep rule in `.semgrep.yml`, and a sweep of every tracked source file that returns nothing.

**The one exception, stated plainly:** `packages/engine/dist/runtime-full.js` — the physics build —
contains a single `new Function` inside wasm-bindgen's generated glue for Rapier. It is third-party
code, it is not reachable from scene data, and the physics-free `runtime.js` has no occurrence at
all. Its practical consequence is that an exported game with physics cannot run under a Content
Security Policy without `unsafe-eval`.

## Authentication and sessions

|                       |                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords             | scrypt, per-password salt, 64-byte key (`auth.ts`). Minimum length 10, no composition rules — those push people towards `Password1!`                                                                                |
| Session tokens        | 256 bits of randomness; **only the SHA-256 hash is stored**                                                                                                                                                         |
| Session lifetime      | 14 days                                                                                                                                                                                                             |
| Sign-out              | `DELETE /auth/session` revokes the presented token server-side, not just in the tab                                                                                                                                 |
| Invite tokens         | 256 bits, hashed at rest, 7 days, single use                                                                                                                                                                        |
| Upload tickets        | HMAC-SHA-256 over org, asset and expiry; 5 minutes; compared in constant time                                                                                                                                       |
| Export download links | Session token in the query — the only place a credential may ride in a URL, because a browser's download manager cannot send a header. Membership is re-checked on every request, so the link is not the permission |
| Rate limits           | Login (per address **and** per account), sign-up, invite-token guessing                                                                                                                                             |

Timing is handled where it matters: login verifies a hash even when there is no such user, so the
response time does not say which of the two it was.

**Known limit:** rate limiting is per process and in memory. Two API instances behind a load
balancer give an attacker twice the budget, and a restart clears the counters. The upgrade is Redis,
which this product already runs. `apps/api/src/throttle.ts` says the same thing at the call site.

## Tenant isolation

Every route that takes an organisation, project, job or asset id calls `requireRole` explicitly.
Non-membership answers **404, not 403** — telling a stranger "you may not touch organisation X"
confirms X exists, which is a membership oracle for anybody willing to guess ids.

**Evidence:** a table-driven suite in `apps/api/src/api.test.ts` drives all eighteen tenant-scoped
routes with a valid session belonging to a _different_ tenant. Adding a route without adding a row
fails the suite. The suite itself was checked by deleting a guard on purpose: exactly one test
failed, and the right one.

## Data at rest

| Data                  | Where                                                            | Retained                                       |
| --------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| Scene versions        | Postgres, one row per save                                       | For the life of the project; deleted with it   |
| Uploaded assets       | Content-addressed files, `orgs/{id}/assets/{hash}.glb`           | Until deleted                                  |
| Export artifacts      | Files, deleted by the worker's hourly sweep                      | 24 hours                                       |
| Sessions and invites  | Postgres                                                         | Deleted by the API's hourly sweep once expired |
| Audit log             | Postgres                                                         | Indefinite, on purpose — see below             |
| Traces, metrics, logs | Wherever they are shipped; nothing is retained by these services | Per backend                                    |

Storage is local disk behind an interface. Object storage (S3, R2) replaces two methods and nothing
else; that decision is recorded in Sprint 30 rather than pretended away.

Path containment is checked with `relative()` rather than a string prefix — `startsWith(root)` is
true for `/data/assets-old` when the root is `/data/assets`, which was a real (if narrow) bug fixed
in this sprint (`apps/api/src/paths.ts`).

## Audit log

Ten actions: invitations, joins, role changes, removals, project creation, deletion and restore,
asset deletion, export requests and export downloads. The vocabulary is closed in the database as
well as in the code, because a row must mean the same thing years later.

Entries are kept indefinitely and survive the thing they describe being deleted — `subject` is text
rather than a foreign key, so the record of a deletion outlives the deleted project. Every entry
carries a correlation id, so an audit line leads back to the full trace and logs of the request that
produced it. `GET /orgs/:org/audit` is admin-only.

**Known limit:** `audit()` never throws. A failed audit write is logged, not raised, because a
database hiccup turning a member removal into a 500 _after_ the removal committed is worse than a
missing row. A regime that requires no action to proceed unaudited needs the entry written in the
same transaction as the action — a real change, written down rather than half-done.

## Network and browser

- **CORS** is a wildcard by default and an allowlist when `ALLOWED_ORIGINS` is set.
  `Access-Control-Allow-Credentials` is **never** sent: authentication is a bearer token in
  `localStorage`, not a cookie, so a hostile page cannot make an authenticated request with ambient
  credentials. An allowlisted deployment echoes the origin and sets `Vary: origin`.
- **`/metrics`** is unauthenticated unless `METRICS_TOKEN` is set. It carries counts and latencies,
  never user data, but it does describe the shape of the business.
- **The co-op and share services** accept any origin by design: an exported build is served from
  wherever its author put it, so the server cannot know its callers. Tying this to a project
  allowlist is future work.
- **Crash reports** from the editor go nowhere unless `VITE_SENTRY_DSN` is set, and carry the
  message, the stack and a correlation id — never the scene document, never a token.

## Scanning

| What                              | Where                                                                                                         | Blocking?    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- | ------------ |
| Runtime dependency advisories     | `pnpm audit --prod --audit-level high`                                                                        | Yes          |
| Development dependency advisories | `pnpm audit --audit-level moderate`                                                                           | No, reported |
| Static analysis                   | Semgrep: `p/typescript`, `p/javascript`, `p/nodejs`, `p/sql-injection`, `p/secrets`                           | Yes          |
| Repo-specific rules               | `.semgrep.yml` — dynamic execution, SQL interpolation, authorisation from a request body, credentials in logs | Yes          |
| Dependency updates                | Dependabot, weekly, grouped                                                                                   | —            |

The dev/runtime split is deliberate: a ReDoS in eslint's argument parser is not a vulnerability in a
product that ships no eslint, and blocking on it teaches people to bypass the gate.

## Vendors

What a questionnaire actually asks for. Everything here is either self-hosted or absent — this
product has no third-party processor in its request path today, which is the shortest possible
answer to a data-processing question and worth keeping as long as it stays true.

| Vendor             | Used for                    | Status                                                                                  |
| ------------------ | --------------------------- | --------------------------------------------------------------------------------------- |
| Postgres           | Every persistent record     | Self-hosted                                                                             |
| Redis              | The export queue            | Self-hosted                                                                             |
| Clerk              | Authentication              | **Not used.** `AuthProvider` is the seam it would plug into                             |
| Stripe             | Billing                     | **Not used.** Plan tiers are enforced; nothing charges                                  |
| S3 / Cloudflare R2 | Asset and artifact storage  | **Not used.** Local disk behind `AssetStorage`                                          |
| Grafana Cloud      | Traces, metrics, dashboards | **Not connected.** OTLP export is configured by env var; dashboards are unrendered JSON |
| Sentry             | Editor crash reports        | **Not connected.** A DSN turns it on                                                    |

## SOC 2 readiness

Not pursued, and not close. What exists of it:

- **Access control review** — the audit log records membership changes; `GET /orgs/:org/members`
  lists current access. There is no scheduled review process.
- **Incident response** — `docs/RUNBOOK.md` covers detection and diagnosis. There is no on-call
  rota, no severity ladder and no customer-notification process.
- **Data retention** — the table above. Sweeps run hourly and are tested.
- **Change management** — every change goes through CI: lint, typecheck, unit, integration,
  end-to-end, and the scanners above.
- **Encryption in transit** — assumed to be terminated by whatever fronts these services. Nothing
  here serves TLS itself.
- **Encryption at rest** — whatever the disk and database provide. Nothing is encrypted by the
  application.
- **Backups** — none. There is no backup or restore procedure for the database, and that is the
  largest gap on this page.

## What this sprint did not do

- **No penetration test.** The OWASP-focused review was a read of the code and a set of tests
  written against it, by the person who wrote the code. That is worth something and it is not an
  independent assessment.
- **No ZAP or equivalent run against a staging deployment**, because there is no staging deployment.
- **No secrets management.** Secrets are environment variables. There is no vault, no rotation
  policy and no audit of who can read them.
- **No MFA, no SSO, no password reset.** All three are what an identity provider is for, and the
  seam is `AuthProvider`.
