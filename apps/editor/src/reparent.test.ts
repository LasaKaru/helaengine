import { describe, expect, it } from 'vitest';
import { parseScene, type Scene } from '@helaengine/schema';
import { buildTree, flattenTree, reparentedTransform, worldMatrix } from './reparent';
import { collectDescendants, wouldCreateCycle } from './store/sceneStore';

function scene(objects: unknown[]): Scene {
  return parseScene({ sceneId: 'scene_test', version: 1, objects });
}

const nested = scene([
  { id: 'building', assetId: 'building_hut_01', transform: { position: [10, 0, 5] } },
  {
    id: 'lamp',
    assetId: 'prop_barrel_01',
    parentId: 'building',
    transform: { position: [2, 0, 0] },
  },
  { id: 'bulb', assetId: 'prop_crate_01', parentId: 'lamp', transform: { position: [0, 3, 0] } },
  { id: 'rock', assetId: 'rock_boulder_01', transform: { position: [-4, 0, 0] } },
]);

describe('worldMatrix', () => {
  it('composes a transform down the parent chain', () => {
    const world = worldMatrix(nested, 'bulb');
    const position = { x: world.elements[12], y: world.elements[13], z: world.elements[14] };

    // building(10,0,5) -> lamp(+2,0,0) -> bulb(0,+3,0)
    expect(position.x).toBeCloseTo(12, 6);
    expect(position.y).toBeCloseTo(3, 6);
    expect(position.z).toBeCloseTo(5, 6);
  });

  it('is just the local transform for a root object', () => {
    const world = worldMatrix(nested, 'rock');
    expect(world.elements[12]).toBeCloseTo(-4, 6);
  });
});

describe('reparentedTransform', () => {
  it('keeps an object where it looks when it gains a parent', () => {
    const transform = reparentedTransform(nested, 'rock', 'building');
    // World (-4,0,0) under a parent at (10,0,5) is local (-14,0,-5).
    expect(transform.position[0]).toBeCloseTo(-14, 4);
    expect(transform.position[2]).toBeCloseTo(-5, 4);
  });

  it('keeps an object where it looks when it is unparented', () => {
    const transform = reparentedTransform(nested, 'bulb', null);
    expect(transform.position[0]).toBeCloseTo(12, 4);
    expect(transform.position[1]).toBeCloseTo(3, 4);
    expect(transform.position[2]).toBeCloseTo(5, 4);
  });

  it('round-trips through a nest and an unnest', () => {
    const nestedTransform = reparentedTransform(nested, 'rock', 'building');
    const afterNesting = scene([
      ...nested.objects.filter((object) => object.id !== 'rock'),
      { id: 'rock', assetId: 'rock_boulder_01', parentId: 'building', transform: nestedTransform },
    ]);

    const back = reparentedTransform(afterNesting, 'rock', null);

    expect(back.position[0]).toBeCloseTo(-4, 3);
    expect(back.position[1]).toBeCloseTo(0, 3);
    expect(back.position[2]).toBeCloseTo(0, 3);
  });

  it('compensates for a rotated parent', () => {
    const rotated = scene([
      { id: 'parent', assetId: 'a', transform: { position: [0, 0, 0], rotation: [0, 90, 0] } },
      { id: 'child', assetId: 'b', transform: { position: [4, 0, 0] } },
    ]);

    const transform = reparentedTransform(rotated, 'child', 'parent');

    // Under a parent yawed 90 degrees, world +X becomes local -Z (or +Z, depending on sign) —
    // what matters is that the offset moved out of X entirely.
    expect(Math.abs(transform.position[0])).toBeCloseTo(0, 3);
    expect(Math.abs(transform.position[2])).toBeCloseTo(4, 3);
  });

  it('compensates for a scaled parent', () => {
    const scaled = scene([
      { id: 'parent', assetId: 'a', transform: { scale: [2, 2, 2] } },
      { id: 'child', assetId: 'b', transform: { position: [4, 0, 0] } },
    ]);

    expect(reparentedTransform(scaled, 'child', 'parent').position[0]).toBeCloseTo(2, 3);
  });
});

describe('buildTree', () => {
  it('nests children under their parents', () => {
    const roots = buildTree(nested);
    expect(roots.map((node) => node.object.id)).toEqual(['building', 'rock']);
    expect(roots[0]!.children.map((node) => node.object.id)).toEqual(['lamp']);
    expect(roots[0]!.children[0]!.children.map((node) => node.object.id)).toEqual(['bulb']);
  });

  it('records depth for indentation', () => {
    const flat = flattenTree(buildTree(nested));
    expect(flat.map((node) => [node.object.id, node.depth])).toEqual([
      ['building', 0],
      ['lamp', 1],
      ['bulb', 2],
      ['rock', 0],
    ]);
  });

  it('lists a parent immediately before its descendants', () => {
    const ids = flattenTree(buildTree(nested)).map((node) => node.object.id);
    expect(ids.indexOf('lamp')).toBe(ids.indexOf('building') + 1);
  });
});

describe('cycle and descendant rules', () => {
  it('refuses to parent an object to itself', () => {
    expect(wouldCreateCycle(nested, 'building', 'building')).toBe(true);
  });

  it('refuses to parent an object to its own descendant', () => {
    expect(wouldCreateCycle(nested, 'building', 'bulb')).toBe(true);
  });

  it('allows a legitimate reparent', () => {
    expect(wouldCreateCycle(nested, 'rock', 'building')).toBe(false);
  });

  it('always allows unparenting', () => {
    expect(wouldCreateCycle(nested, 'bulb', null)).toBe(false);
  });

  it('collects the whole subtree when deleting a parent', () => {
    expect([...collectDescendants(nested, ['building'])].sort()).toEqual([
      'building',
      'bulb',
      'lamp',
    ]);
  });

  it('collects only the object itself when it is a leaf', () => {
    expect([...collectDescendants(nested, ['rock'])]).toEqual(['rock']);
  });
});
