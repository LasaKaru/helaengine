import { asProject, migrateScene, type GameProject, type Scene } from '@helaengine/schema';
import { db, type StoredProject } from './db';

/** Project metadata without the scene payload — enough to draw the projects list. */
export interface ProjectSummary {
  id: string;
  name: string;
  thumbnail?: string;
  createdAt: number;
  updatedAt: number;
}

export class ProjectLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectLoadError';
  }
}

export function newProjectId(): string {
  return `prj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const rows = await db.projects.orderBy('updatedAt').reverse().toArray();
  // Neither payload belongs in a summary: the projects list shows names and thumbnails, and
  // carrying every level's geometry into it would load the whole library to draw a grid of cards.
  return rows.map(({ sceneJson: _scene, projectJson: _project, ...summary }) => summary);
}

export async function saveProject(project: {
  id: string;
  scene: Scene;
  /** Every level, when there is more than one. Omitted for a single-level game. */
  project?: GameProject | undefined;
  thumbnail?: string | undefined;
}): Promise<StoredProject> {
  const existing = await db.projects.get(project.id);
  const now = Date.now();

  /**
   * Only written when it says something the scene does not.
   *
   * A one-level game is fully described by `sceneJson`, so storing a project alongside it would be
   * the same document twice — and "does this row have levels" would need a parse to answer.
   */
  const multiLevel = project.project && project.project.levels.length > 1;

  const record: StoredProject = {
    id: project.id,
    name: project.scene.name,
    sceneJson: JSON.stringify(project.scene),
    ...(multiLevel ? { projectJson: JSON.stringify(project.project) } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    // A save that could not capture the viewport keeps the previous thumbnail rather than
    // blanking the card — a stale picture beats no picture.
    ...((project.thumbnail ?? existing?.thumbnail)
      ? { thumbnail: project.thumbnail ?? existing?.thumbnail }
      : {}),
  };

  await db.projects.put(record);
  return record;
}

/**
 * Reads a project back, migrating and validating it on the way in.
 *
 * Stored data is untrusted input: it may have been written by an older build, hand-edited through
 * devtools, or corrupted. `migrateScene` brings it up to the current version and then validates —
 * so a bad document fails here, loudly, rather than as a mystery NaN in the renderer.
 */
export async function loadProject(
  id: string,
): Promise<{ record: StoredProject; scene: Scene; project: GameProject }> {
  const record = await db.projects.get(id);
  if (!record) throw new ProjectLoadError(`Project "${id}" is not in this browser's storage.`);

  let parsed: unknown;
  try {
    // The level set when there is one, the lone scene otherwise. Old rows have only the latter,
    // which is why `asProject` below accepts both rather than this branch being a migration.
    parsed = JSON.parse(record.projectJson ?? record.sceneJson);
  } catch (error) {
    throw new ProjectLoadError(`Project "${record.name}" is stored in a form that is not JSON.`, {
      cause: error,
    });
  }

  try {
    const project = asProject(parsed);
    /**
     * Each level is migrated on the way in.
     *
     * `asProject` validates the container; `migrateScene` brings each level up to the current
     * document version. Doing it here rather than lazily means a project with one bad level fails
     * on open, loudly, rather than when somebody switches to it an hour later.
     */
    const levels = project.levels.map((level) => migrateScene(level));
    const migrated: GameProject = { ...project, levels };
    const scene = levels.find((level) => level.sceneId === project.startLevelId) ?? levels[0]!;
    return { record, scene, project: migrated };
  } catch (error) {
    throw new ProjectLoadError(
      `Project "${record.name}" could not be opened: its scene data failed validation.`,
      { cause: error },
    );
  }
}

export async function deleteProject(id: string): Promise<void> {
  await db.projects.delete(id);
}

/** Copies a project under a new id, so the original is untouched. */
export async function duplicateProject(id: string): Promise<StoredProject> {
  const { record, scene } = await loadProject(id);
  const copy: Scene = { ...scene, name: `${record.name} copy` };

  return saveProject({
    id: newProjectId(),
    scene: copy,
    ...(record.thumbnail ? { thumbnail: record.thumbnail } : {}),
  });
}
