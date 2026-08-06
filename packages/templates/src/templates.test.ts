import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_ASSET_ENTRIES } from '@helaengine/engine';
import { SceneSchema } from '@helaengine/schema';
import { CheckpointParamsSchema } from '@helaengine/engine';
import { TEMPLATES, buildStressScene, templateById } from './index.js';

describe('templates', () => {
  it('every template produces a document the schema accepts', () => {
    for (const template of TEMPLATES) {
      expect(() => SceneSchema.parse(template.build()), template.id).not.toThrow();
    }
  });

  /**
   * Every asset a template places actually exists.
   *
   * The schema check above passes on an id that resolves to nothing: `assetId` is a string, and a
   * string that names no asset is a valid document describing a scene full of grey placeholder
   * boxes. That is the failure mode a starter template can least afford — it is the first thing a
   * new user sees, and it looks like the product is broken rather than like a typo.
   *
   * Read from the *generated* manifest rather than a list kept here, because the manifest is what
   * the editor and every export actually load. A copy would agree with reality right up until
   * somebody removed an asset.
   */
  it('places only assets the manifest actually has', () => {
    const manifestPath = resolve(
      fileURLToPath(new URL('.', import.meta.url)),
      '../../../generated/assets/manifest.json',
    );

    let manifest: { assets: Array<{ id: string }> };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest;
    } catch {
      // Generated output. A checkout that has not run `pnpm ingest-assets` cannot answer this, and
      // failing there would be a test about the working copy rather than about the templates.
      return;
    }

    const known = new Set([
      ...manifest.assets.map((asset) => asset.id),
      // Trigger volumes come from the engine, not the pipeline, and are placed like props.
      ...BUILTIN_ASSET_ENTRIES.map((entry) => entry.id),
    ]);

    const missing = new Map<string, string[]>();
    for (const template of TEMPLATES) {
      const unknown = template
        .build()
        .objects.map((object) => object.assetId)
        .filter((assetId) => !known.has(assetId));
      if (unknown.length > 0) missing.set(template.id, [...new Set(unknown)]);
    }

    expect(Object.fromEntries(missing)).toEqual({});
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

describe('skirmish template', () => {
  it('is playable the moment it loads: a weapon, pickups that grant it, and enemies', () => {
    const scene = templateById('skirmish')!.build();

    // The rifle is behind a secret (Sprint 17), so the catalogue has two entries but only the
    // pistol is reachable by walking into something.
    expect(scene.inventory.weapons.map((weapon) => weapon.id)).toEqual([
      'weapon_0001',
      'weapon_0002',
    ]);

    const pickups = scene.objects.flatMap((object) =>
      object.behaviors.filter((behavior) => behavior.type === 'pickup'),
    );
    expect(pickups.map((pickup) => (pickup.params as { kind: string }).kind).sort()).toEqual([
      'ammo',
      'health',
      'weapon',
    ]);

    // Every pickup that names a weapon names one that exists — the schema enforces this for the
    // starting loadout but not for behaviour params, so the template has to be right by itself.
    for (const pickup of pickups) {
      const weaponId = (pickup.params as { weaponId?: string }).weaponId;
      if (weaponId) expect(scene.inventory.weapons.some((w) => w.id === weaponId)).toBe(true);
    }

    const enemies = scene.objects.filter((object) =>
      object.behaviors.some((behavior) => behavior.type === 'chaseOnSight'),
    );
    expect(enemies.length).toBeGreaterThanOrEqual(2);
  });
});

describe('skirmish secrets', () => {
  it('ships both secret kinds, wired to real ids', () => {
    const scene = templateById('skirmish')!.build();
    const ids = new Set(scene.objects.map((object) => object.id));

    expect(scene.unlockables.map((secret) => secret.unlockMethod.type)).toEqual([
      'inputSequence',
      'triggerVolume',
    ]);

    for (const secret of scene.unlockables) {
      // A secret pointing at an object or a weapon that does not exist would do nothing at all,
      // with nothing anywhere saying so — the schema cannot catch it, so the template must be right.
      if (secret.unlockMethod.type === 'triggerVolume') {
        expect(ids.has(secret.unlockMethod.triggerId)).toBe(true);
      }
      for (const action of secret.actions) {
        if (action.type === 'revealArea') {
          for (const objectId of action.objectIds) expect(ids.has(objectId)).toBe(true);
        }
        if (action.type === 'unlockInventoryItem') {
          expect(scene.inventory.weapons.some((w) => w.id === action.weaponId)).toBe(true);
        }
      }
    }
  });

  it('gives the secret trigger volume an actual trigger', () => {
    const scene = templateById('skirmish')!.build();
    const alcove = scene.objects.find((object) => object.metadata.label === 'Alcove');

    expect(alcove?.trigger).not.toBeNull();
  });
});

describe('skirmish checkpoints', () => {
  it('places two, the deeper one more generous than the first', () => {
    const scene = templateById('skirmish')!.build();
    const checkpoints = scene.objects
      .map((object) => object.behaviors.find((behavior) => behavior.type === 'checkpoint'))
      .filter((behavior) => behavior !== undefined);

    expect(checkpoints).toHaveLength(2);
    // Parsed through the behaviour's own schema, because that is where the defaults land — a
    // document stores the params as written, and the runtime fills the rest in on creation.
    const resets = checkpoints.map(
      (behavior) => CheckpointParamsSchema.parse(behavior!.params).reset.ammo,
    );
    // A scarcity stretch that never refills is a checkpoint you dread rather than one you want.
    expect(resets).toEqual(['none', 'full']);
  });
});
