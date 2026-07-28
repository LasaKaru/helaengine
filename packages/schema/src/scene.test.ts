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
    expect(scene.terrain.size).toEqual([128, 128]);
    expect(scene.terrain.heightmap).toBeNull();
    expect(scene.terrain.layers).toHaveLength(4);
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

describe('object hierarchy', () => {
  const base = { sceneId: 'scene_demo', version: CURRENT_SCENE_VERSION };

  it('defaults an object to the root', () => {
    expect(parseScene(minimalScene).objects[0]?.parentId).toBeNull();
  });

  it('accepts a valid parent', () => {
    const result = safeParseScene({
      ...base,
      objects: [
        { id: 'a', assetId: 'x' },
        { id: 'b', assetId: 'y', parentId: 'a' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a child declared before its parent', () => {
    const result = safeParseScene({
      ...base,
      objects: [
        { id: 'b', assetId: 'y', parentId: 'a' },
        { id: 'a', assetId: 'x' },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a parent that does not exist', () => {
    const result = safeParseScene({
      ...base,
      objects: [{ id: 'b', assetId: 'y', parentId: 'ghost' }],
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toContain('does not exist');
  });

  it('rejects an object parented to itself', () => {
    const result = safeParseScene({
      ...base,
      objects: [{ id: 'a', assetId: 'x', parentId: 'a' }],
    });
    expect(result.success).toBe(false);
    expect(result.success === false && result.error.issues[0]?.message).toContain('cycle');
  });

  it('rejects a longer parent cycle', () => {
    // A cycle would hang any naive traversal, so it must never reach a consumer.
    const result = safeParseScene({
      ...base,
      objects: [
        { id: 'a', assetId: 'x', parentId: 'c' },
        { id: 'b', assetId: 'y', parentId: 'a' },
        { id: 'c', assetId: 'z', parentId: 'b' },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('terrain schema', () => {
  const base = { sceneId: 'scene_demo', version: CURRENT_SCENE_VERSION, objects: [] };

  it('accepts a sculpted terrain', () => {
    const result = safeParseScene({
      ...base,
      terrain: {
        type: 'heightmap',
        segments: 64,
        heightmap: { encoding: 'base64', data: 'AAAA' },
        splatmap: { encoding: 'base64', data: 'AAAA' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a resolution beyond what inline storage is meant to carry', () => {
    expect(safeParseScene({ ...base, terrain: { segments: 512 } }).success).toBe(false);
  });

  it('requires exactly four blend layers, matching the splat map channels', () => {
    const result = safeParseScene({
      ...base,
      terrain: { layers: [{ name: 'Grass', color: '#6a8f4f' }] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown terrain type', () => {
    expect(safeParseScene({ ...base, terrain: { type: 'voxel' } }).success).toBe(false);
  });
});

describe('physics fields', () => {
  it('reads a document written before physics existed', () => {
    // The Sprint 10 additions are all defaulted, which is the only reason the scene version did
    // not have to move. A field without a default here would have needed a migration.
    const scene = parseScene({
      sceneId: 'scene_old',
      version: 1,
      objects: [{ id: 'obj_0001', assetId: 'tree_pine_01' }],
    });

    expect(scene.objects[0]!.physics).toEqual({ body: 'static', collider: 'auto' });
    expect(scene.player.spawn).toEqual([0, 0, 0]);
    expect(scene.player.height).toBe(1.8);
  });

  it('accepts a per-instance collider override', () => {
    const scene = parseScene({
      sceneId: 'scene_test',
      version: 1,
      objects: [
        {
          id: 'obj_0001',
          assetId: 'building_hut_01',
          physics: { collider: 'mesh', body: 'static' },
        },
      ],
    });

    expect(scene.objects[0]!.physics.collider).toBe('mesh');
  });

  it('rejects a collider or body type it has never heard of', () => {
    for (const physics of [{ collider: 'convexhull' }, { body: 'ragdoll' }]) {
      expect(() =>
        parseScene({
          sceneId: 'scene_test',
          version: 1,
          objects: [{ id: 'obj_0001', assetId: 'a', physics }],
        }),
      ).toThrow();
    }
  });

  it('keeps the player inside sane limits', () => {
    const base = { sceneId: 'scene_test', version: 1 };
    expect(() => parseScene({ ...base, player: { height: 0 } })).toThrow();
    expect(() => parseScene({ ...base, player: { maxSlopeDegrees: 90 } })).toThrow();
    expect(parseScene({ ...base, player: { moveSpeed: 12 } }).player.moveSpeed).toBe(12);
  });
});
