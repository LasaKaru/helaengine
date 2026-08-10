import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { SceneObjectSchema, SceneSchema, projectFromScene, type Scene } from '@helaengine/schema';
import { createEmptyScene } from '../store/sceneStore';
import { templateById } from '@helaengine/templates';
import { db } from './db';
import {
  deleteProject,
  duplicateProject,
  listProjects,
  loadProject,
  newProjectId,
  ProjectLoadError,
  saveProject,
} from './projects';

function sceneWith(name: string, objectCount = 0): Scene {
  const scene = createEmptyScene(name);
  return {
    ...scene,
    objects: Array.from({ length: objectCount }, (_unused, index) =>
      SceneObjectSchema.parse({
        id: `obj_${String(index + 1).padStart(4, '0')}`,
        assetId: 'tree_pine_01',
      }),
    ),
  };
}

describe('project storage', () => {
  beforeEach(async () => {
    await db.projects.clear();
  });

  it('round-trips a scene through storage', async () => {
    const id = newProjectId();
    const scene = sceneWith('Round Trip', 3);

    await saveProject({ id, scene });
    const { scene: restored } = await loadProject(id);

    expect(restored.name).toBe('Round Trip');
    expect(restored.objects).toHaveLength(3);
    expect(restored).toEqual(scene);
  });

  it('takes the project name from the scene document', async () => {
    const id = newProjectId();
    await saveProject({ id, scene: sceneWith('Named From Scene') });

    expect((await listProjects())[0]?.name).toBe('Named From Scene');
  });

  it('keeps createdAt across saves and moves updatedAt forward', async () => {
    const id = newProjectId();
    const first = await saveProject({ id, scene: sceneWith('A') });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await saveProject({ id, scene: sceneWith('A', 1) });

    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt);
  });

  it('keeps the previous thumbnail when a save cannot capture one', async () => {
    const id = newProjectId();
    await saveProject({ id, scene: sceneWith('Thumb'), thumbnail: 'data:image/jpeg;base64,AAA' });

    // A save while the tab is hidden may not be able to read the canvas — a stale picture is a
    // better outcome than a blank card.
    await saveProject({ id, scene: sceneWith('Thumb', 1) });

    expect((await listProjects())[0]?.thumbnail).toBe('data:image/jpeg;base64,AAA');
  });

  it('lists the most recently edited project first', async () => {
    const older = newProjectId();
    await saveProject({ id: older, scene: sceneWith('Older') });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = newProjectId();
    await saveProject({ id: newer, scene: sceneWith('Newer') });

    expect((await listProjects()).map((project) => project.name)).toEqual(['Newer', 'Older']);
  });

  it('omits the scene payload from the list', async () => {
    await saveProject({ id: newProjectId(), scene: sceneWith('Light') });
    expect((await listProjects())[0]).not.toHaveProperty('sceneJson');
  });

  it('reports a project that is not there', async () => {
    await expect(loadProject('prj_missing')).rejects.toBeInstanceOf(ProjectLoadError);
  });

  it('refuses to open a project whose scene is not valid JSON', async () => {
    await db.projects.put({
      id: 'prj_broken',
      name: 'Broken',
      sceneJson: '{not json',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await expect(loadProject('prj_broken')).rejects.toThrow(/not JSON/);
  });

  it('refuses to open a project whose scene fails validation', async () => {
    // Stored data is untrusted: an older build, a hand edit, a corrupted write. It must fail at
    // the boundary rather than reaching the renderer.
    await db.projects.put({
      id: 'prj_invalid',
      name: 'Invalid',
      sceneJson: JSON.stringify({ sceneId: 'x', version: 1, objects: [{ id: 'a' }] }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await expect(loadProject('prj_invalid')).rejects.toThrow(/failed validation/);
  });

  it('deletes a project', async () => {
    const id = newProjectId();
    await saveProject({ id, scene: sceneWith('Doomed') });

    await deleteProject(id);

    expect(await listProjects()).toHaveLength(0);
  });

  it('duplicates a project without touching the original', async () => {
    const id = newProjectId();
    await saveProject({ id, scene: sceneWith('Original', 2) });

    const copy = await duplicateProject(id);

    expect(copy.id).not.toBe(id);
    expect(copy.name).toBe('Original copy');
    const { scene: original } = await loadProject(id);
    expect(original.name).toBe('Original');
    expect((await loadProject(copy.id)).scene.objects).toHaveLength(2);
  });
});

describe('templates', () => {
  it('produces a valid, empty blank scene', () => {
    const scene = templateById('blank')!.build();
    expect(scene.objects).toHaveLength(0);
    expect(scene.terrain.type).toBe('flat');
  });

  it('builds a populated forest clearing on sculpted ground', () => {
    const scene = templateById('forest-clearing')!.build();

    expect(scene.objects.length).toBeGreaterThan(20);
    expect(scene.terrain.type).toBe('heightmap');
    expect(scene.terrain.heightmap).not.toBeNull();
  });

  it('builds the village outpost with a hut and enemies', () => {
    const scene = templateById('village-outpost')!.build();
    const assetIds = scene.objects.map((object) => object.assetId);

    expect(assetIds).toContain('building_hut_01');
    expect(assetIds.filter((id) => id === 'enemy_goblin_01')).toHaveLength(2);
  });

  it('gives every object in every template a unique id', () => {
    for (const template of ['blank', 'forest-clearing', 'village-outpost']) {
      const scene = templateById(template)!.build();
      const ids = scene.objects.map((object) => object.id);
      expect(new Set(ids).size, template).toBe(ids.length);
    }
  });

  it('is deterministic, so a reported problem is reproducible', () => {
    const first = templateById('forest-clearing')!.build();
    const second = templateById('forest-clearing')!.build();

    // Everything but the generated scene id must match.
    expect(second.objects).toEqual(first.objects);
    expect(second.terrain.heightmap).toEqual(first.terrain.heightmap);
  });

  it('gives each build its own scene id', () => {
    const first = templateById('blank')!.build();
    const second = templateById('blank')!.build();
    expect(second.sceneId).not.toBe(first.sceneId);
  });
});

/**
 * Levels through local storage.
 *
 * The same two-way compatibility claim the `.hela` container makes: a row written before levels
 * existed must open, and a row with levels must still hold a playable start level in the field an
 * older build reads.
 */
describe('levels', () => {
  const level = (sceneId: string, name: string) =>
    SceneSchema.parse({ sceneId, version: 1, name, objects: [] });

  it('stores no project payload for a single-level game', async () => {
    const scene = level('only', 'Only');
    await saveProject({ id: 'p1', scene, project: projectFromScene(scene) });

    // The common row stays exactly what it was.
    const row = await db.projects.get('p1');
    expect(row?.projectJson).toBeUndefined();

    const loaded = await loadProject('p1');
    expect(loaded.project.levels).toHaveLength(1);
  });

  it('keeps every level, and keeps the start level readable by an older build', async () => {
    const project = {
      version: 1 as const,
      name: 'Game',
      startLevelId: 'caves',
      levels: [level('forest', 'Forest'), level('caves', 'Caves')],
    };
    await saveProject({ id: 'p2', scene: project.levels[1]!, project });

    const row = await db.projects.get('p2');
    expect(row?.projectJson).toBeTruthy();
    // A build that knows nothing about levels reads this field and finds a playable game.
    expect(JSON.parse(row!.sceneJson).sceneId).toBe('caves');

    const loaded = await loadProject('p2');
    expect(loaded.project.levels.map((one) => one.sceneId)).toEqual(['forest', 'caves']);
    expect(loaded.scene.sceneId).toBe('caves');
  });

  it('opens a row written before levels existed', async () => {
    await db.projects.put({
      id: 'p3',
      name: 'Legacy',
      sceneJson: JSON.stringify(level('legacy', 'Legacy')),
      createdAt: 1,
      updatedAt: 1,
    });

    const loaded = await loadProject('p3');
    expect(loaded.project.levels).toHaveLength(1);
    expect(loaded.scene.sceneId).toBe('legacy');
  });

  it('keeps both payloads out of the projects list', async () => {
    const project = {
      version: 1 as const,
      name: 'Game',
      startLevelId: 'forest',
      levels: [level('forest', 'Forest'), level('caves', 'Caves')],
    };
    await saveProject({ id: 'p4', scene: project.levels[0]!, project });

    // Carrying every level's geometry into a grid of cards would load the whole library to draw it.
    const [summary] = await listProjects();
    expect(summary).not.toHaveProperty('sceneJson');
    expect(summary).not.toHaveProperty('projectJson');
  });
});
