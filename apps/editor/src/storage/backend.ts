import { projectFromScene, type GameProject, type Scene } from '@helaengine/schema';
import * as local from './projects';
import type { ProjectSummary } from './projects';
import type { StoredProject } from './db';
import {
  CloudProjects,
  ConflictError,
  type CloudSession,
  type VersionSummary,
} from './cloudProjects';
import { CloudAssets } from './cloudAssets';

/**
 * One project store, two places it can live.
 *
 * The same six functions the editor already called, dispatching to IndexedDB or to the API. The
 * store and the projects screen are unchanged — which is the whole argument for having written the
 * cloud adapter against the local store's interface rather than a nicer one.
 *
 * Local is the default and stays the default. Somebody who opens the editor with no account should
 * still be able to build something; requiring a sign-up before the first click would be charging
 * admission to a demo.
 */

let session: CloudSession | null = null;
let cloud: CloudProjects | null = null;
let assets: CloudAssets | null = null;

/**
 * The version each open project is based on.
 *
 * Held here rather than in the scene store because it is a fact about *storage*, not about the
 * document — the same scene saved to a different backend has a different version, and to no
 * backend at all has none. Updated on load and on every successful save; a save that conflicts
 * leaves it alone, because the client is still on the version it thought it was.
 */
const versions = new Map<string, number>();

export type { ProjectSummary };

/**
 * Who wants to know when the account changes.
 *
 * Sign-in happens inside one component's local state, but it changes what the *whole* editor is
 * talking to. Rather than lift that state into a store that only one panel reads, anything that
 * cares subscribes here — which is exactly what `useSyncExternalStore` was added for.
 */
const listeners = new Set<() => void>();

export function subscribeToSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function signIn(next: CloudSession): void {
  session = next;
  cloud = new CloudProjects(next);
  assets = new CloudAssets(next);
  versions.clear();
  for (const listener of listeners) listener();
}

export function signOut(): void {
  session = null;
  cloud = null;
  assets = null;
  versions.clear();
  for (const listener of listeners) listener();
}

/**
 * The uploaded-asset client, or null when nobody is signed in.
 *
 * Returned rather than wrapped in six pass-through functions the way projects are: there is no
 * local equivalent to dispatch to. A browser database cannot hold an asset the *engine* can load,
 * because the loader fetches a URL — so "my assets" is a cloud feature or it is nothing, and
 * pretending otherwise would mean an offline path that silently drops uploads.
 */
export function cloudAssets(): CloudAssets | null {
  return assets;
}

export type { CloudAssets };

export function currentSession(): CloudSession | null {
  return session;
}

export function isCloud(): boolean {
  return cloud !== null;
}

export function newProjectId(): string {
  // The cloud mints its own ids, so this only matters locally. Returning one anyway keeps the
  // store's create path identical in both modes.
  return local.newProjectId();
}

export async function listProjects(): Promise<ProjectSummary[]> {
  if (!cloud) return local.listProjects();
  return cloud.list();
}

export async function saveProject(project: {
  id: string;
  scene: Scene;
  /**
   * Every level, when there is more than one.
   *
   * Carried by the local backend. The cloud API stores a scene per project and validates it as one
   * server-side, so a cloud project keeps only its start level until that endpoint learns about
   * level sets — see `docs/LEVELS.md`.
   */
  project?: GameProject | undefined;
  thumbnail?: string | undefined;
}): Promise<void> {
  if (!cloud) {
    await local.saveProject(project);
    return;
  }

  const base = versions.get(project.id) ?? 0;
  const version = await cloud.save(project.id, project.scene, base);
  versions.set(project.id, version);

  // Sent separately and after: a thumbnail is metadata about a version that now exists, and
  // bundling it into the save would make a picture able to fail a document write.
  if (project.thumbnail) await cloud.setThumbnail(project.id, project.thumbnail);
}

export async function loadProject(
  id: string,
): Promise<{ record: StoredProject; scene: Scene; project: GameProject }> {
  if (!cloud) return local.loadProject(id);

  const { project, scene } = await cloud.load(id);
  versions.set(id, project.version);
  if (!scene) throw new local.ProjectLoadError(`Project "${project.name}" has never been saved.`);

  return {
    record: {
      id: project.id,
      name: project.name,
      ...(project.thumbnail ? { thumbnail: project.thumbnail } : {}),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      sceneJson: JSON.stringify(scene),
    },
    scene,
    // One level, because that is all a cloud project holds today.
    project: projectFromScene(scene),
  };
}

export async function createProject(name: string, scene: Scene): Promise<string> {
  if (!cloud) {
    const id = local.newProjectId();
    await local.saveProject({ id, scene });
    return id;
  }

  const created = await cloud.create(name, scene);
  versions.set(created.id, created.version);
  return created.id;
}

export async function deleteProject(id: string): Promise<void> {
  versions.delete(id);
  if (!cloud) return local.deleteProject(id);
  return cloud.remove(id);
}

export async function duplicateProject(id: string): Promise<{ id: string; name: string }> {
  if (!cloud) {
    const copy = await local.duplicateProject(id);
    return { id: copy.id, name: copy.name };
  }

  // No server-side duplicate endpoint, and none is needed: a copy is a load followed by a create,
  // and doing it here keeps the API's surface to the operations that could not be composed.
  const { project, scene } = await cloud.load(id);
  if (!scene) throw new local.ProjectLoadError(`Project "${project.name}" has nothing to copy.`);

  const created = await cloud.create(`${project.name} copy`, scene);
  versions.set(created.id, created.version);
  return { id: created.id, name: created.name };
}

export async function projectHistory(id: string): Promise<VersionSummary[]> {
  // Empty rather than an error when there is no cloud: a local project genuinely has no history,
  // and the panel showing "no saved versions yet" is a better answer than a thrown exception.
  if (!cloud) return [];
  return cloud.history(id);
}

export async function restoreVersion(id: string, version: number): Promise<Scene> {
  if (!cloud) throw new Error('Version history needs a signed-in account.');

  const restored = await cloud.restore(id, version);
  versions.set(id, restored.version);
  return restored.scene;
}

/** The version an open project is based on, for anything that wants to show it. */
export function baseVersion(id: string): number {
  return versions.get(id) ?? 0;
}

export { ConflictError };
