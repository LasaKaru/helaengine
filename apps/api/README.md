# @helaengine/api

Accounts, organisations, memberships, role-gated access, cloud project storage and per-organisation
asset uploads — the platform every later backend feature builds on.

```bash
createdb helaengine                                    # or point DATABASE_URL somewhere
DATABASE_URL=postgres://you@localhost/helaengine pnpm --filter @helaengine/api migrate
DATABASE_URL=postgres://you@localhost/helaengine pnpm --filter @helaengine/api start
```

## Three deviations from DEVELOPMENT-PLAN.md, and why

The plan names **NestJS + Prisma + Clerk**. None of the three is here, and each substitution is a
decision rather than an omission.

**No NestJS.** Two services in this repo already run on plain `node:http`, because a handful of
routes do not need a framework's opinion about which handler owns a request. NestJS's decorators
and dependency injection would be the only such pattern in the codebase. The plan's `RoleGuard`
exists as `requireRole(db, orgId, userId, role)` — called explicitly at the top of each handler, so
reading one tells you what it requires.

**No Prisma.** Types in this product come from Zod, in `@helaengine/schema`, and Prisma would add a
second generator producing a second set of types for the same concepts — one of which would drift.
Migrations are hand-written SQL applied by a thirty-line runner, each file in a transaction with
its own record, so a half-applied migration leaves no claim to have run. The cost is real: queries
are strings, and their result shapes are asserted rather than inferred. Past a few dozen tables,
revisit it.

**No Clerk.** There is no Clerk account and no way to receive its webhooks from here. What exists
is the seam it plugs into: everything downstream depends on `AuthProvider.identify()` returning a
user id, not on how that user proved who they are. Swapping Clerk in means implementing that
interface against its session tokens and pointing its user-created webhook at `provisionUser`.
Local passwords use scrypt from the standard library — memory-hard, no native module to build.

Invite emails are the same shape: `sendInvite` is a function you pass in. The default logs the
link, because pretending mail is being sent would be worse than saying it is not.

## What the security decisions are

- **Non-membership answers 404, not 403.** "You are not allowed in organisation X" confirms X
  exists, which is a membership oracle for anyone guessing ids. A member of insufficient rank gets
  403, because they already know the place exists.
- **Tokens are stored as hashes.** Sessions and invites both. A leaked backup should not be a set
  of live keys.
- **Login answers identically for a wrong password and an unknown address**, and verifies a hash
  even when there is no user — otherwise the response time says which it was.
- **Nobody may invite above their own rank.** Without it, an admin promotes a friend to owner and
  the privilege ladder has a rung going upwards.
- **An invite is addressed.** Intercepting the link does not make you the person it was for.

## Asset uploads

An organisation's own `.glb` files, alongside the curated library.

```
POST   /orgs/:id/assets          -> { asset, upload: { url, ticket, maxBytes } }
PUT    /uploads/:orgId/:assetId?expires=…&signature=…   (the bytes)
GET    /orgs/:id/assets[?category=…]
DELETE /orgs/:id/assets/:assetId
GET    /assets/*                 (the bytes back, unauthenticated, immutable)
```

**Two requests, not one.** The first asks permission and gets a five-minute HMAC-signed URL; the
second sends the bytes to it and never touches the authenticated path. That is what keeps a 25 MB
file from travelling through the API twice, and it is the same shape a presigned S3 URL has — which
is what makes moving to one a change to `uploadUrl()` rather than to the uploader.

`PUT /uploads/...` is deliberately routed **before** authentication: the signature _is_ the
authorisation. The organisation id is inside the signature rather than merely in the path, so one
valid ticket is not a write into every tenant.

`GET /assets/*` is deliberately **unauthenticated**: it is the origin a CDN would sit in front of,
and a CDN holds no session. The protection is that the path contains a content hash nobody can
guess. Because the path is content-addressed, the same bytes always get the same URL and different
bytes always get a different one — which is what makes `max-age=31536000, immutable` safe and what
would let a CDN in front of this need no invalidation strategy.

**No R2, no S3, no CDN, and no ingest worker.** `LocalAssetStorage` writes files to `ASSET_ROOT`
behind a two-method `AssetStorage` interface. Uploads are validated (non-empty, under 25 MB, and
starting with the four `glTF` magic bytes) and stored as sent — nothing is compressed or
thumbnailed. The `status` column already means `pending -> ready | failed`, so a worker plugs into a
state machine that exists rather than one that has to be invented; it just does not exist yet.
