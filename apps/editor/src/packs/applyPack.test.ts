import { describe, expect, it } from 'vitest';
import { parseAssetManifest, parseSkillPack, type Scene } from '@helaengine/schema';
import { createEmptyScene } from '../store/sceneStore';
import { applyPack, planPack } from './applyPack';

/**
 * Applying a pack.
 *
 * The claims worth pinning are all about *not damaging the level it is applied to*: ids that
 * collide, a variable that resets somebody's progress, a graph that stops running. A pack is a
 * convenience, and a convenience that can break a level is not one.
 */

const manifest = parseAssetManifest({
  version: 1,
  assets: [
    { id: 'grass_large', name: 'Grass', category: 'trees', tags: [] },
    { id: 'prop_crate_01', name: 'Crate', category: 'props', tags: [] },
    { id: 'audio_ambience_wind', name: 'Wind', category: 'audio', tags: ['ambience'] },
  ],
});

const HEADER = `---
id: forest
name: Forest
description: Test pack.
---
`;

const packOf = (patches: string): ReturnType<typeof parseSkillPack> =>
  parseSkillPack(`${HEADER}\n\`\`\`hela\n${patches}\n\`\`\`\n`);

const scene = (): Scene => createEmptyScene('Level');

describe('planning', () => {
  it('lists what will change, in the author’s language', () => {
    const plan = planPack(packOf('{ "op": "applyLook", "look": "realistic" }'), manifest);
    expect(plan.steps).toEqual(['Apply the realistic look']);
    expect(plan.problems).toEqual([]);
  });

  it('refuses a pack naming an asset this project does not have', () => {
    /**
     * A missing asset is a problem, not a warning.
     *
     * A scatter layer naming an unknown model grows nothing; a spawn node naming one fails the
     * graph's validation, which stops the *whole* graph — including the parts of the level that
     * were already working.
     */
    const pack = packOf(
      '{ "op": "addScatterLayer", "value": { "id": "g", "assetId": "not_shipped" } }',
    );
    const plan = planPack(pack, manifest);

    expect(plan.missingAssets).toEqual(['not_shipped']);
    expect(plan.problems.join('\n')).toContain('not_shipped');
    expect(() => applyPack(scene(), pack, manifest)).toThrow(/not_shipped/);
  });
});

describe('applying', () => {
  it('sets the wind without touching anything else', () => {
    const before = scene();
    const after = applyPack(
      before,
      packOf('{ "op": "setWind", "value": { "strength": 0.8, "direction": 120 } }'),
      manifest,
    );

    expect(after.environment.wind.strength).toBeCloseTo(0.8, 5);
    expect(after.environment.background).toBe(before.environment.background);
    // Pure: the input is not mutated, so the caller decides how it enters the document.
    expect(before.environment.wind.strength).toBe(0);
  });

  it('applies a look through the same function the button calls', () => {
    const after = applyPack(
      scene(),
      packOf('{ "op": "applyLook", "look": "realistic" }'),
      manifest,
    );
    // A pack and a click must not be able to disagree about what "realistic" means.
    expect(after.environment.toneMapping).toBe('aces');
    expect(after.environment.postProcessing.enabled).toBe(true);
  });

  it('adds ground cover and ambience', () => {
    const after = applyPack(
      scene(),
      packOf(`[
        { "op": "addScatterLayer", "value": { "id": "g", "assetId": "grass_large", "name": "Meadow" } },
        { "op": "addAmbience", "value": { "assetId": "audio_ambience_wind", "followWind": 1 } }
      ]`),
      manifest,
    );

    expect(after.scatter).toHaveLength(1);
    expect(after.scatter[0]?.name).toBe('Meadow');
    expect(after.audioConfig.ambience[0]?.followWind).toBe(1);
  });
});

describe('ids', () => {
  const doorPack = packOf(`[
    { "op": "addObject", "value": { "id": "door", "assetId": "prop_crate_01" } },
    { "op": "addGraphNode", "value": { "id": "start", "type": "onStart" } },
    { "op": "addGraphNode", "value": { "id": "open", "type": "setHidden", "targetId": "x", "hidden": false } },
    { "op": "addGraphEdge", "value": { "from": "start", "port": "then", "to": "open" } }
  ]`);

  it('rewrites local ids so applying twice adds two doors', () => {
    /**
     * A pack cannot know what is already in the level.
     *
     * Left as written, the second application would collide with the first — and a scene with two
     * objects sharing an id fails its own schema. Remapping is what makes a pack a thing you can
     * use more than once.
     */
    const once = applyPack(scene(), doorPack, manifest);
    const twice = applyPack(once, doorPack, manifest);

    expect(twice.objects).toHaveLength(2);
    expect(new Set(twice.objects.map((object) => object.id)).size).toBe(2);
    expect(new Set(twice.graph.nodes.map((node) => node.id)).size).toBe(4);
  });

  it('rewrites both ends of an edge consistently', () => {
    const after = applyPack(scene(), doorPack, manifest);
    const [edge] = after.graph.edges;
    const ids = new Set(after.graph.nodes.map((node) => node.id));

    // An edge left pointing at the pack's local name would be a dangling wire, which stops the
    // whole graph running.
    expect(ids.has(edge!.from)).toBe(true);
    expect(ids.has(edge!.to)).toBe(true);
  });

  it('does not collide with an id the scene already uses', () => {
    const existing = scene();
    const seeded: Scene = {
      ...existing,
      graph: { ...existing.graph, nodes: [{ id: 'forest_start', type: 'onStart' }], layout: {} },
    };

    const after = applyPack(seeded, doorPack, manifest);
    expect(new Set(after.graph.nodes.map((node) => node.id)).size).toBe(after.graph.nodes.length);
  });

  it('places pack objects at the root rather than inside somebody’s hierarchy', () => {
    const after = applyPack(scene(), doorPack, manifest);
    // Re-parenting is a decision a recipe is not in a position to make.
    expect(after.objects[0]?.parentId).toBeNull();
  });

  it('lays new nodes out below the existing graph', () => {
    const existing = scene();
    const seeded: Scene = {
      ...existing,
      graph: {
        ...existing.graph,
        nodes: [{ id: 'mine', type: 'onStart' }],
        layout: { mine: [40, 40] },
      },
    };

    const after = applyPack(seeded, doorPack, manifest);
    const added = after.graph.nodes.filter((node) => node.id !== 'mine');
    // A pile on top of whatever was already at the origin is unreadable; a group below it is not.
    for (const node of added) expect(after.graph.layout[node.id]![1]).toBeGreaterThan(40);
  });
});

describe('leaving the level’s own work alone', () => {
  it('keeps a variable the level already declares', () => {
    const existing = scene();
    const seeded: Scene = {
      ...existing,
      graph: {
        ...existing.graph,
        variables: [{ name: 'score', type: 'number', initial: 42 }],
      },
    };

    const after = applyPack(
      seeded,
      packOf(
        '{ "op": "addGraphVariable", "value": { "name": "score", "type": "number", "initial": 0 } }',
      ),
      manifest,
    );

    // Overwriting would reset progress the graph was already tracking, from a recipe the author
    // applied for an unrelated reason.
    expect(after.graph.variables).toHaveLength(1);
    expect(after.graph.variables[0]?.initial).toBe(42);
  });

  it('does not add the same ambience bed twice', () => {
    const pack = packOf(
      '{ "op": "addAmbience", "value": { "assetId": "audio_ambience_wind", "volume": 0.5 } }',
    );
    const twice = applyPack(applyPack(scene(), pack, manifest), pack, manifest);

    // Beds are keyed by asset, so a duplicate would silently replace rather than stack.
    expect(twice.audioConfig.ambience).toHaveLength(1);
  });

  it('leaves objects and graph nodes the level already had', () => {
    const existing = scene();
    const seeded: Scene = {
      ...existing,
      graph: {
        ...existing.graph,
        nodes: [{ id: 'mine', type: 'onStart' }],
        layout: { mine: [0, 0] },
      },
    };

    const after = applyPack(seeded, packOf('{ "op": "applyLook", "look": "stylized" }'), manifest);
    expect(after.graph.nodes.map((node) => node.id)).toEqual(['mine']);
  });
});
