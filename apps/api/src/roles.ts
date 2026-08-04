import { roleAtLeast, type Role } from '@helaengine/schema';
import type { Db } from './db.js';

/**
 * Who may do what, in one place.
 *
 * The equivalent of the plan's `RoleGuard`, as a function rather than a decorator: every route
 * calls it explicitly, so reading a handler tells you what it requires without also knowing how
 * the framework assembles metadata. There is one way to be authorised and it is visible at the
 * call site.
 */

export class Forbidden extends Error {
  readonly status = 403;
}

export class Unauthorized extends Error {
  readonly status = 401;
}

export class NotFound extends Error {
  readonly status = 404;
}

/** The role this user holds in this organisation, or null if they are not a member. */
export async function roleIn(db: Db, organizationId: string, userId: string): Promise<Role | null> {
  const found = await db.query<{ role: Role }>(
    'select role from memberships where organization_id = $1 and user_id = $2',
    [organizationId, userId],
  );
  return found.rows[0]?.role ?? null;
}

/**
 * Requires a role, or refuses.
 *
 * Non-membership answers **404, not 403**. Telling a stranger "you are not allowed in organisation
 * X" confirms that organisation X exists, which is a membership-list oracle for anyone willing to
 * guess ids. A member who lacks the *rank* gets a 403, because they already know the place exists.
 */
export async function requireRole(
  db: Db,
  organizationId: string,
  userId: string,
  required: Role,
): Promise<Role> {
  const held = await roleIn(db, organizationId, userId);
  if (!held) throw new NotFound('no such organization');
  if (!roleAtLeast(held, required)) {
    throw new Forbidden(`this action needs ${required}; you are ${held}`);
  }
  return held;
}
