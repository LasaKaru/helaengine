# @helaengine/api

Accounts, organisations, memberships and role-gated access — the platform every later backend
feature builds on.

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
