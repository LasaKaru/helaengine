import { parseScene, type Scene } from '@helaengine/schema';
import type { Db } from './db.js';
import { NotFound } from './roles.js';

/**
 * Projects and their history.
 *
 * The one idea this file is built around: **saving appends, it never updates**. A save is a new
 * `scene_versions` row, so version history is a property of the shape rather than a feature
 * somebody had to build — and "restore" is another append, not a rewrite. History is never
 * destroyed, including by the button whose job is to go back.
 */

export interface ProjectRow {
  id: string;
  organizationId: string;
  name: string;
  thumbnail: string | null;
  latestVersion: number;
  updatedAt: string;
  createdAt: string;
}

export class Conflict extends Error {
  readonly status = 409;
  readonly latestVersion: number;

  constructor(latestVersion: number) {
    super(
      `somebody else saved this project since you loaded it (they are on version ${latestVersion})`,
    );
    this.latestVersion = latestVersion;
  }
}

export async function createProject(
  db: Db,
  input: { organizationId: string; name: string; userId: string; scene?: unknown },
): Promise<ProjectRow> {
  // Validated before anything is written, with the same schema the editor validated it against.
  // A document that only the client checked is a document nobody checked.
  const scene: Scene | null = input.scene === undefined ? null : parseScene(input.scene);

  const client = await db.connect();
  try {
    await client.query('begin');
    const created = await client.query<{ id: string; created_at: Date; updated_at: Date }>(
      `insert into projects (organization_id, name, created_by)
       values ($1, $2, $3) returning id, created_at, updated_at`,
      [input.organizationId, input.name, input.userId],
    );
    const id = created.rows[0]!.id;

    if (scene) {
      await client.query(
        `insert into scene_versions (project_id, version, document, created_by)
         values ($1, 1, $2, $3)`,
        [id, JSON.stringify(scene), input.userId],
      );
    }
    await client.query('commit');

    return {
      id,
      organizationId: input.organizationId,
      name: input.name,
      thumbnail: null,
      latestVersion: scene ? 1 : 0,
      createdAt: created.rows[0]!.created_at.toISOString(),
      updatedAt: created.rows[0]!.updated_at.toISOString(),
    };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function listProjects(db: Db, organizationId: string): Promise<ProjectRow[]> {
  const rows = await db.query<{
    id: string;
    name: string;
    thumbnail: string | null;
    created_at: Date;
    updated_at: Date;
    latest: number | null;
  }>(
    `select p.id, p.name, p.thumbnail, p.created_at, p.updated_at,
            (select max(v.version) from scene_versions v where v.project_id = p.id) as latest
       from projects p
      where p.organization_id = $1 and p.deleted_at is null
      order by p.updated_at desc`,
    [organizationId],
  );

  return rows.rows.map((row) => ({
    id: row.id,
    organizationId,
    name: row.name,
    thumbnail: row.thumbnail,
    latestVersion: row.latest ?? 0,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
}

/** A project and its most recent document, or null when it is gone or was never saved. */
export async function loadProject(
  db: Db,
  projectId: string,
): Promise<{ project: ProjectRow; scene: Scene | null; version: number } | null> {
  const found = await db.query<{
    id: string;
    organization_id: string;
    name: string;
    thumbnail: string | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `select id, organization_id, name, thumbnail, created_at, updated_at
       from projects where id = $1 and deleted_at is null`,
    [projectId],
  );

  const row = found.rows[0];
  if (!row) return null;

  const latest = await db.query<{ version: number; document: unknown }>(
    'select version, document from scene_versions where project_id = $1 order by version desc limit 1',
    [projectId],
  );
  const head = latest.rows[0];

  return {
    project: {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      thumbnail: row.thumbnail,
      latestVersion: head?.version ?? 0,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    },
    // Re-validated on the way out as well as in. A document written by an older build of the
    // schema should fail loudly at this boundary rather than halfway through a render.
    scene: head ? parseScene(head.document) : null,
    version: head?.version ?? 0,
  };
}

/**
 * Saves. Appends a version, and refuses if somebody else got there first.
 *
 * `baseVersion` is what the client had when it started editing. The insert is guarded by a
 * `where` on the current maximum rather than by reading it first and inserting after: two saves
 * arriving together would both read the same maximum and both think they were next. The unique
 * index on `(project_id, version)` is the backstop, and the conditional insert is what turns a
 * constraint violation into a 409 with a number the editor can act on.
 */
export async function saveVersion(
  db: Db,
  input: { projectId: string; userId: string; scene: unknown; baseVersion: number },
): Promise<{ version: number }> {
  const scene = parseScene(input.scene);

  const inserted = await db.query<{ version: number }>(
    `insert into scene_versions (project_id, version, document, created_by)
     select $1, $2, $3::jsonb, $4
      where coalesce((select max(version) from scene_versions where project_id = $1), 0) = $5
     returning version`,
    [
      input.projectId,
      input.baseVersion + 1,
      JSON.stringify(scene),
      input.userId,
      input.baseVersion,
    ],
  );

  if (inserted.rowCount === 0) {
    const current = await db.query<{ latest: number | null }>(
      'select max(version) as latest from scene_versions where project_id = $1',
      [input.projectId],
    );
    // The project may simply not exist, which is a different answer from "you are behind".
    const exists = await db.query('select 1 from projects where id = $1 and deleted_at is null', [
      input.projectId,
    ]);
    if (!exists.rowCount) throw new NotFound('no such project');
    throw new Conflict(current.rows[0]?.latest ?? 0);
  }

  await db.query('update projects set updated_at = now() where id = $1', [input.projectId]);
  return { version: inserted.rows[0]!.version };
}

export interface VersionSummary {
  version: number;
  createdAt: string;
  authorId: string;
  authorName: string;
}

export async function listVersions(
  db: Db,
  projectId: string,
  limit = 20,
): Promise<VersionSummary[]> {
  const rows = await db.query<{
    version: number;
    created_at: Date;
    created_by: string;
    display_name: string;
  }>(
    `select v.version, v.created_at, v.created_by, u.display_name
       from scene_versions v join users u on u.id = v.created_by
      where v.project_id = $1
      order by v.version desc
      limit $2`,
    [projectId, limit],
  );

  return rows.rows.map((row) => ({
    version: row.version,
    createdAt: row.created_at.toISOString(),
    authorId: row.created_by,
    authorName: row.display_name,
  }));
}

/**
 * Restores an old version by appending it as a new one.
 *
 * Never by deleting what came after. Undoing a mistake should not be able to become a second,
 * larger mistake — and a history with holes in it is a history nobody can trust to answer "what
 * did this look like on Tuesday".
 */
export async function restoreVersion(
  db: Db,
  input: { projectId: string; userId: string; version: number },
): Promise<{ version: number; scene: Scene }> {
  const old = await db.query<{ document: unknown }>(
    'select document from scene_versions where project_id = $1 and version = $2',
    [input.projectId, input.version],
  );
  const document = old.rows[0]?.document;
  if (document === undefined) throw new NotFound('no such version');

  const current = await db.query<{ latest: number | null }>(
    'select max(version) as latest from scene_versions where project_id = $1',
    [input.projectId],
  );

  const saved = await saveVersion(db, {
    projectId: input.projectId,
    userId: input.userId,
    scene: document,
    baseVersion: current.rows[0]?.latest ?? 0,
  });
  return { version: saved.version, scene: parseScene(document) };
}

export async function updateProject(
  db: Db,
  input: { projectId: string; name?: string; thumbnail?: string },
): Promise<void> {
  await db.query(
    `update projects
        set name = coalesce($2, name),
            thumbnail = coalesce($3, thumbnail),
            updated_at = now()
      where id = $1 and deleted_at is null`,
    [input.projectId, input.name ?? null, input.thumbnail ?? null],
  );
}

/** Soft delete. Nothing reads it afterwards; nothing removes the rows either. */
export async function deleteProject(db: Db, projectId: string): Promise<void> {
  await db.query('update projects set deleted_at = now() where id = $1', [projectId]);
}
