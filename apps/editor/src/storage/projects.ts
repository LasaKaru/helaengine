import { migrateScene, type Scene } from '@helaengine/schema';
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
  return rows.map(({ sceneJson: _sceneJson, ...summary }) => summary);
}

export async function saveProject(project: {
  id: string;
  scene: Scene;
  thumbnail?: string | undefined;
}): Promise<StoredProject> {
  const existing = await db.projects.get(project.id);
  const now = Date.now();

  const record: StoredProject = {
    id: project.id,
    name: project.scene.name,
    sceneJson: JSON.stringify(project.scene),
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
export async function loadProject(id: string): Promise<{ record: StoredProject; scene: Scene }> {
  const record = await db.projects.get(id);
  if (!record) throw new ProjectLoadError(`Project "${id}" is not in this browser's storage.`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(record.sceneJson);
  } catch (error) {
    throw new ProjectLoadError(`Project "${record.name}" is stored in a form that is not JSON.`, {
      cause: error,
    });
  }

  try {
    return { record, scene: migrateScene(parsed) };
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
