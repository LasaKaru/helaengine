import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.js';
import type { Role, User } from '@helaengine/schema';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Credentials, sessions, and the seam where a real identity provider goes.
 *
 * `DEVELOPMENT-PLAN.md` names Clerk, and Clerk is the right answer for a product with users: it
 * handles password resets, MFA, SSO, breach lists and the email flows around all of them, none of
 * which is core to a game engine. It is not what runs here, for the plain reason that there is no
 * Clerk account, no API key and no way to receive its webhooks from this environment.
 *
 * So what exists is the *shape* Clerk plugs into. Everything downstream — sessions, memberships,
 * the role guard — depends on `identify()` returning a user id, not on how that user proved who
 * they are. Swapping in Clerk means implementing `AuthProvider` against its session tokens and
 * pointing its user-created webhook at `provisionUser`; nothing else in this service moves.
 */
export interface AuthProvider {
  /** Resolves a bearer token to a user id, or null. */
  identify(token: string): Promise<string | null>;
}

/** How long a session lasts. Short enough to matter, long enough not to be a nuisance. */
const SESSION_DAYS = 14;
const INVITE_DAYS = 7;

const SCRYPT_KEY_BYTES = 64;

/**
 * Hashes a password with scrypt.
 *
 * Node's own implementation, deliberately: argon2 and bcrypt both mean a native module to build on
 * every platform this ends up on, and scrypt is memory-hard, in the standard library, and good
 * enough that the weak link will be elsewhere. The salt is per-password and stored beside the hash.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT_KEY_BYTES);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  // A user with no local password — provisioned by an identity provider — cannot log in this way,
  // and must not be able to by sending an empty one.
  if (!stored) return false;

  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;

  const derived = await scrypt(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEY_BYTES);
  const expected = Buffer.from(hashHex, 'hex');
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/**
 * Tokens are random, and only their hash is stored.
 *
 * SHA-256 rather than scrypt here, and that is not an inconsistency: a password is low-entropy and
 * needs the cost to make guessing expensive, while a 256-bit random token cannot be guessed at all.
 * Hashing it protects against a leaked database, which is the threat that applies.
 */
export function mintToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface SessionRecord {
  token: string;
  userId: string;
  expiresAt: Date;
}

export async function createSession(db: Db, userId: string): Promise<SessionRecord> {
  const { token, hash } = mintToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);

  await db.query('insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)', [
    hash,
    userId,
    expiresAt,
  ]);
  return { token, userId, expiresAt };
}

/** The provider backed by this service's own `sessions` table. */
export class LocalAuthProvider implements AuthProvider {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async identify(token: string): Promise<string | null> {
    const found = await this.#db.query<{ user_id: string }>(
      'select user_id from sessions where token_hash = $1 and expires_at > now()',
      [hashToken(token)],
    );
    return found.rows[0]?.user_id ?? null;
  }
}

export interface ProvisionedUser {
  user: User;
  personalOrganizationId: string;
}

/**
 * Creates a user and the personal workspace that comes with them.
 *
 * One transaction, because a user without a workspace is an account that cannot do anything and a
 * workspace without its owner is a row nobody can reach. This is also the function an identity
 * provider's user-created webhook calls, which is why the password is optional.
 */
export async function provisionUser(
  db: Db,
  input: { email: string; displayName: string; password?: string },
): Promise<ProvisionedUser> {
  const email = input.email.trim().toLowerCase();
  const passwordHash = input.password ? await hashPassword(input.password) : null;

  const client = await db.connect();
  try {
    await client.query('begin');

    const user = await client.query<{
      id: string;
      email: string;
      display_name: string;
      created_at: Date;
    }>(
      `insert into users (email, display_name, password_hash)
       values ($1, $2, $3)
       returning id, email, display_name, created_at`,
      [email, input.displayName, passwordHash],
    );
    const row = user.rows[0]!;

    const org = await client.query<{ id: string }>(
      `insert into organizations (name, is_personal) values ($1, true) returning id`,
      [`${input.displayName}'s workspace`],
    );
    const organizationId = org.rows[0]!.id;

    await client.query(
      `insert into memberships (organization_id, user_id, role) values ($1, $2, 'owner')`,
      [organizationId, row.id],
    );

    await client.query('commit');
    return {
      user: {
        id: row.id,
        email: row.email,
        displayName: row.display_name,
        createdAt: row.created_at.toISOString(),
      },
      personalOrganizationId: organizationId,
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export const INVITE_LIFETIME_MS = INVITE_DAYS * 24 * 60 * 60 * 1000;

export type { Role };
