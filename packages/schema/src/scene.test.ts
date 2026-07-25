import { describe, expect, it } from 'vitest';
import { CURRENT_SCENE_VERSION, SceneSchema, parseScene, safeParseScene } from './scene.js';
import {
  applyMigrationChain,
  migrateScene,
  SceneMigrationError,
  sceneMigrations,
} from './migrations.js';

const minimalScene = {
  sceneId: 'scene_demo',
  version: CURRENT_SCENE_VERSION,
  objects: [{ id: 'obj_0001', assetId: 'tree_pine_02' }],
};

describe('SceneSchema', () => {
  it('fills every optional branch with defaults', () => {
    const scene = parseScene(minimalScene);

    expect(scene.name).toBe('Untitled scene');
    expect(scene.terrain.type).toBe('flat');
    expect(scene.terrain.size).toEqual([256, 256]);
    expect(scene.environment.fog).toBeNull();
    expect(scene.environment.lighting.ambient).toBe(0.4);
    expect(scene.objects[0]?.transform).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    });
  });

  it('preserves explicit transforms verbatim', () => {
    const scene = parseScene({
      ...minimalScene,
      objects: [
        {
          id: 'obj_0001',
          assetId: 'tree_pine_02',
          transform: { position: [10, 0, -4], rotation: [0, 45, 0], scale: [2, 2, 2] },
        },
      ],
    });

    expect(scene.objects[0]?.transform.position).toEqual([10, 0, -4]);
    expect(scene.objects[0]?.transform.rotation).toEqual([0, 45, 0]);
  });

  it('rejects duplicate object ids', () => {
    const result = safeParseScene({
      ...minimalScene,
      objects: [
        { id: 'obj_0001', assetId: 'a' },
        { id: 'obj_0001', assetId: 'b' },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toContain('duplicate');
  });

  it('rejects non-finite coordinates', () => {
    const result = safeParseScene({
      ...minimalScene,
      objects: [{ id: 'obj_0001', assetId: 'a', transform: { position: [Number.NaN, 0, 0] } }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects malformed hex colours', () => {
    const result = safeParseScene({ ...minimalScene, environment: { background: 'skyblue' } });
    expect(result.success).toBe(false);
  });

  it('rejects a document declaring an unknown version', () => {
    expect(SceneSchema.safeParse({ ...minimalScene, version: 99 }).success).toBe(false);
  });
});

describe('migrateScene', () => {
  it('passes a current-version document straight through to validation', () => {
    expect(migrateScene(minimalScene).sceneId).toBe('scene_demo');
  });

  it('refuses documents from a newer build', () => {
    expect(() => migrateScene({ ...minimalScene, version: CURRENT_SCENE_VERSION + 1 })).toThrow(
      SceneMigrationError,
    );
  });

  it('refuses documents with no usable version field', () => {
    expect(() => migrateScene({ sceneId: 'x' })).toThrow(SceneMigrationError);
  });

  it('walks every step of a multi-version chain in order', () => {
    // Stands in for a future v1 -> v2 -> v3 bump, using an isolated registry.
    const registry = {
      1: (doc: Record<string, unknown>) => ({ ...doc, version: 2, name: 'from-v1' }),
      2: (doc: Record<string, unknown>) => ({ ...doc, version: 3, name: 'from-v2' }),
    };

    const result = applyMigrationChain({ sceneId: 'scene_old', version: 1 }, 3, registry);
    expect(result['version']).toBe(3);
    expect(result['name']).toBe('from-v2');
  });

  it('refuses to run when a step in the chain is missing', () => {
    expect(() => applyMigrationChain({ sceneId: 'x', version: 1 }, 3, {})).toThrow(
      /no migration registered from scene version 1/,
    );
  });

  it('refuses a migration that fails to advance the version', () => {
    const registry = { 1: (doc: Record<string, unknown>) => ({ ...doc, version: 1 }) };
    expect(() => applyMigrationChain({ sceneId: 'x', version: 1 }, 2, registry)).toThrow(
      /did not advance the version/,
    );
  });

  it('ships with no migrations registered while v1 is the only version', () => {
    expect(Object.keys(sceneMigrations)).toHaveLength(0);
  });
});
