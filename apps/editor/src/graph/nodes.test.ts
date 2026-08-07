import { describe, expect, it } from 'vitest';
import { GraphNodeSchema, NODE_OUTPUTS, type GraphNodeType } from '@helaengine/schema';
import { NODE_GROUPS, NODE_LABELS, describeNode, newNode, nextNodeId } from './nodes';

const ALL_TYPES = Object.keys(NODE_OUTPUTS) as GraphNodeType[];

describe('the palette covers the vocabulary', () => {
  it('offers every node type exactly once', () => {
    // The palette is the only way to create a node, so a type missing from it is a feature that
    // exists in the schema, the runtime and the documentation and cannot be reached by a user.
    const offered = NODE_GROUPS.flatMap((group) => group.types);
    expect([...offered].sort()).toEqual([...ALL_TYPES].sort());
    expect(new Set(offered).size).toBe(offered.length);
  });

  it('names every type', () => {
    for (const type of ALL_TYPES) expect(NODE_LABELS[type]).toBeTruthy();
  });
});

describe('newNode', () => {
  it.each(ALL_TYPES)('makes a valid %s', (type) => {
    // The point of filling defaults in one place: a node is never on the canvas in a state the
    // document format would refuse, so "add a node then save" cannot produce an unloadable scene.
    const node = newNode(type, `${type}1`, {
      assetId: 'prop_crate',
      objectId: 'object_1',
      variableName: 'score',
    });
    expect(() => GraphNodeSchema.parse(node)).not.toThrow();
    expect(node.type).toBe(type);
    expect(node.id).toBe(`${type}1`);
  });

  it('stays valid with no scene to draw defaults from', () => {
    // An empty project is the first thing anybody opens. A node that needs an object id gets an
    // empty one, which validation reports — better than silently pointing at an unrelated object.
    for (const type of ALL_TYPES) {
      expect(() => GraphNodeSchema.parse(newNode(type, 'n1'))).not.toThrow();
    }
  });

  it('describes every type without falling back to the type name', () => {
    for (const type of ALL_TYPES) {
      expect(
        describeNode(newNode(type, 'n1', { objectId: 'crate', variableName: 'score' })),
      ).toBeTruthy();
    }
  });
});

describe('nextNodeId', () => {
  it('skips ids already in use', () => {
    const graph = {
      variables: [],
      nodes: [newNode('wait', 'wait1'), newNode('wait', 'wait2')],
      edges: [],
      layout: {},
    };
    expect(nextNodeId(graph, 'wait')).toBe('wait3');
    expect(nextNodeId(graph, 'emit')).toBe('emit1');
  });
});
