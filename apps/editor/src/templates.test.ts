import { describe, expect, it } from 'vitest';
import { SceneSchema } from '@helaengine/schema';
import { TEMPLATES, buildStressScene, templateById } from './templates';

describe('templates', () => {
  it('every template produces a document the schema accepts', () => {
    for (const template of TEMPLATES) {
      expect(() => SceneSchema.parse(template.build()), template.id).not.toThrow();
    }
  });

  it('builds the same scene every time, so a bug report is reproducible', () => {
    const first = buildStressScene();
    const second = buildStressScene();

    expect(first.objects.map((object) => object.transform.position)).toEqual(
      second.objects.map((object) => object.transform.position),
    );
  });
});

describe('the stress benchmark scene', () => {
  const scene = buildStressScene();

  it('has the shape docs/PERFORMANCE.md describes', () => {
    const enemies = scene.objects.filter((object) => object.assetId === 'enemy_goblin_01');
    const props = scene.objects.filter((object) => object.assetId !== 'enemy_goblin_01');

    expect(props).toHaveLength(500);
    expect(enemies).toHaveLength(20);
    expect(scene.terrain.type).toBe('heightmap');
  });

  it('gives every enemy a patrol, an AI state machine and a body that can move', () => {
    // The point of the benchmark is that it costs CPU as well as draw calls. An enemy without
    // these would be another static prop, and the numbers would quietly stop meaning anything.
    for (const enemy of scene.objects.filter((object) => object.assetId === 'enemy_goblin_01')) {
      expect(enemy.behaviors.map((entry) => entry.type)).toEqual(['patrol', 'chaseOnSight']);
      expect(enemy.physics.body).toBe('kinematic');
    }
  });

  it('leaves the props batchable', () => {
    // Instancing only takes objects nothing touches individually. If a future edit gave the props
    // a behaviour, the draw-call figure in the performance doc would silently regress.
    for (const prop of scene.objects.filter((object) => object.assetId !== 'enemy_goblin_01')) {
      expect(prop.behaviors).toEqual([]);
      expect(prop.physics.body).toBe('static');
      expect(prop.parentId).toBeNull();
    }
  });

  it('is reachable from the projects screen', () => {
    expect(templateById('stress-test')?.name).toBe('Stress test');
  });
});
