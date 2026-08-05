import { createHash } from 'node:crypto';
import pg from 'pg';
import { migrateScene, type Scene } from '@helaengine/schema';
import type { Authorizer } from './server.js';
import type { RoomStore } from './rooms.js';

/**
 * The collaboration server's view of the database.
 *
 * Deliberately small: three queries, no ORM, and — importantly — **no shared code with the API's
 * `projects.ts`**. That is a boundary rather than duplication. This process may seed a room and
 * append a version; it may not create projects, mint sessions, or touch memberships except to read
 * one. A service whose reach is visible in four SQL statements is a service whose blast radius is
 * obvious.
 */

export type Db = pg.Pool;

export function createPool(connectionString?: string): Db {
  return new pg.Pool({
    connectionString:
      connectionString ??
      process.env['DATABASE_URL'] ??
      'postgres://hela@localhost:5432/helaengine',
    max: 10,
  });
}

/**
 * A version-history-backed room store.
 *
 * The live CRDT is the working copy; the version table is the durable one. That keeps one source of
 * truth for "what is this project", so a collaborative session and a solo save produce the same
 * kind of artefact — a version, with an author and a timestamp, visible under History like any
 * other.
 */
export class DbRoomStore implements RoomStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async loadScene(projectId: string): Promise<Scene | null> {
    const found = await this.#db.query<{ document: unknown }>(
      `select document from scene_versions
        where project_id = $1 order by version desc limit 1`,
      [projectId],
    );

    const document = found.rows[0]?.document;
    if (document === undefined) return null;

    // Migrated on the way in, exactly as the API and the editor do. A room seeded from an older
    // document would otherwise be the one place in the product where a scene skips its migrations.
    return migrateScene(document);
  }

  /**
   * Appends a version holding the room's current state.
   *
   * `max(version) + 1` inside the insert rather than read-then-write, for the same reason the API
   * does it: two writers computing the next number separately both compute the same one. Here the
   * second writer is usually the API — somebody pressing Ctrl+S while a collaborative save is in
   * flight — so the race is routine rather than theoretical.
   *
   * The author is the *project's owner* rather than a specific collaborator, because a room's state
   * is the work of everybody in it and attributing it to whoever happened to leave last would put a
   * name on the version that means nothing.
   */
  async saveScene(projectId: string, scene: Scene): Promise<void> {
    await this.#db.query(
      `insert into scene_versions (project_id, version, document, created_by)
       select $1,
              coalesce((select max(version) from scene_versions where project_id = $1), 0) + 1,
              $2::jsonb,
              (select p.created_by from projects p where p.id = $1)
        where exists (select 1 from projects where id = $1 and deleted_at is null)`,
      [projectId, JSON.stringify(scene)],
    );
  }
}

/**
 * Membership, checked against the same tables the API uses.
 *
 * Checked here rather than by calling the API over HTTP: a websocket upgrade that waits on another
 * service's round trip is a connection that fails when that service is slow, and the query is one
 * join. The trade is that this process needs database credentials — which it already needs to seed
 * a room at all.
 */
export class DbAuthorizer implements Authorizer {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async authorize(token: string, projectId: string): Promise<{ userId: string } | null> {
    // Editor or above. A viewer may open a project read-only through the API, but a collaborative
    // room has no read-only mode — everybody in it can write to the document — so a viewer is kept
    // out rather than let in and asked politely not to type.
    const found = await this.#db.query<{ user_id: string }>(
      `select s.user_id
         from sessions s
         join projects p on p.id = $2 and p.deleted_at is null
         join memberships m on m.organization_id = p.organization_id and m.user_id = s.user_id
        where s.token_hash = $1
          and s.expires_at > now()
          and m.role in ('enterprise_admin', 'owner', 'admin', 'editor')`,
      [hashToken(token), projectId],
    );

    const row = found.rows[0];
    return row ? { userId: row.user_id } : null;
  }
}

/**
 * The stored form of a session token.
 *
 * Must match `apps/api/src/auth.ts`. Duplicated rather than imported because importing it would
 * make this service depend on the API's module graph — including its database pool and its route
 * table — to hash sixty-four characters. Small enough to restate, and there is a test that the two
 * agree, because the day they diverge every collaborative session silently stops authenticating.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
