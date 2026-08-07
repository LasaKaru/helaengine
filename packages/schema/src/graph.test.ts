import { describe, expect, it } from 'vitest';
import {
  MAX_CONDITION_DEPTH,
  SceneGraphSchema,
  findInstantCycles,
  graphIsRunnable,
  outputsOf,
  validateGraph,
  type SceneGraph,
} from './graph.js';

/**
 * The graph's static checks.
 *
 * These are the part a text scripting language cannot have. `while (true) {}` in C# is a hung game
 * discovered by playing it; here it is a load error naming the nodes, and only because the whole
 * program is inspectable data rather than a string that becomes a function.
 */

function graph(parts: Partial<SceneGraph>): SceneGraph {
  return SceneGraphSchema.parse(parts);
}

const errorsOf = (subject: SceneGraph): string[] =>
  validateGraph(subject)
    .filter((problem) => problem.severity === 'error')
    .map((problem) => problem.message);

describe('parsing', () => {
  it('refuses a node type it has never heard of', () => {
    // The closed vocabulary, at the parse boundary. A document naming `runShellCommand` is not a
    // document with a bad node — it is not a document.
    expect(() =>
      SceneGraphSchema.parse({ nodes: [{ id: 'n1', type: 'runShellCommand', cmd: 'rm -rf /' }] }),
    ).toThrow();
  });

  it('refuses a condition nested past the depth limit', () => {
    // A document is untrusted input, and an unbounded recursive schema is a stack overflow waiting
    // for a hostile file. Built from the inside out so the count is exact.
    let condition: unknown = { type: 'flag', name: 'x', expected: true };
    for (let depth = 0; depth <= MAX_CONDITION_DEPTH; depth += 1) {
      condition = { type: 'not', of: condition };
    }
    expect(() =>
      SceneGraphSchema.parse({
        variables: [{ name: 'x', type: 'boolean', initial: false }],
        nodes: [{ id: 'n1', type: 'branch', condition }],
      }),
    ).toThrow();
  });

  it('accepts a condition at the limit', () => {
    let condition: unknown = { type: 'flag', name: 'x', expected: true };
    for (let depth = 0; depth < MAX_CONDITION_DEPTH; depth += 1) {
      condition = { type: 'not', of: condition };
    }
    expect(() =>
      SceneGraphSchema.parse({
        variables: [{ name: 'x', type: 'boolean', initial: false }],
        nodes: [{ id: 'n1', type: 'branch', condition }],
      }),
    ).not.toThrow();
  });
});

describe('outputsOf', () => {
  it('gives a branch two ports and an action one', () => {
    expect(
      outputsOf({ id: 'b', type: 'branch', condition: { type: 'playerHealthBelow', value: 10 } }),
    ).toEqual(['true', 'false']);
    expect(outputsOf({ id: 'e', type: 'emit', event: 'ping', payload: {} })).toEqual(['then']);
  });

  it('numbers a sequence by how many branches it declares', () => {
    expect(outputsOf({ id: 's', type: 'sequence', branches: 3 })).toEqual(['0', '1', '2']);
  });
});

describe('findInstantCycles', () => {
  it('finds a loop with no wait in it', () => {
    const subject = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'a', type: 'emit', event: 'ping', payload: {} },
        { id: 'b', type: 'emit', event: 'pong', payload: {} },
      ],
      edges: [
        { from: 'start', port: 'then', to: 'a' },
        { from: 'a', port: 'then', to: 'b' },
        { from: 'b', port: 'then', to: 'a' },
      ],
    });

    const cycles = findInstantCycles(subject);
    expect(cycles).toHaveLength(1);
    // Named, not merely detected: the message has to say which nodes, or somebody has to find them
    // on a canvas by hand.
    expect(cycles[0]?.sort()).toEqual(['a', 'b']);
  });

  it('allows a loop that passes through a wait', () => {
    // A repeating behaviour rather than a hang: the chain yields the frame, which is the whole
    // distinction the check is built on.
    const subject = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'a', type: 'emit', event: 'tick', payload: {} },
        { id: 'w', type: 'wait', seconds: 1 },
      ],
      edges: [
        { from: 'start', port: 'then', to: 'a' },
        { from: 'a', port: 'then', to: 'w' },
        { from: 'w', port: 'then', to: 'a' },
      ],
    });
    expect(findInstantCycles(subject)).toEqual([]);
  });

  it('finds a loop through a branch, which is how one is usually written by accident', () => {
    const subject = graph({
      variables: [{ name: 'flag', type: 'boolean', initial: true }],
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'check', type: 'branch', condition: { type: 'flag', name: 'flag', expected: true } },
        { id: 'act', type: 'emit', event: 'ping', payload: {} },
      ],
      edges: [
        { from: 'start', port: 'then', to: 'check' },
        { from: 'check', port: 'true', to: 'act' },
        { from: 'act', port: 'then', to: 'check' },
      ],
    });
    // A condition that happens to be false today does not make this safe: the check is about what
    // the graph *can* do, not what it did on one run.
    expect(findInstantCycles(subject)).toHaveLength(1);
  });
});

describe('validateGraph', () => {
  it('accepts a graph that is simply correct', () => {
    const subject = graph({
      variables: [{ name: 'score', type: 'number', initial: 0 }],
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'set', type: 'setVariable', name: 'score', value: { kind: 'number', value: 10 } },
      ],
      edges: [{ from: 'start', port: 'then', to: 'set' }],
    });
    expect(validateGraph(subject)).toEqual([]);
    expect(graphIsRunnable(validateGraph(subject))).toBe(true);
  });

  it('catches an edge to a node that does not exist', () => {
    const subject = graph({
      nodes: [{ id: 'start', type: 'onStart' }],
      edges: [{ from: 'start', port: 'then', to: 'ghost' }],
    });
    expect(errorsOf(subject).join('\n')).toContain('"ghost"');
  });

  it('catches an output a node does not have', () => {
    const subject = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'e', type: 'emit', event: 'ping', payload: {} },
      ],
      // `emit` has only `then`. A `true` port is a branch's, and connecting one is the mistake a
      // canvas makes easy.
      edges: [{ from: 'e', port: 'true', to: 'start' }],
    });
    expect(errorsOf(subject).join('\n')).toContain('has no output "true"');
  });

  it('catches an undeclared variable, read or written', () => {
    const written = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 's', type: 'setVariable', name: 'missing', value: { kind: 'number', value: 1 } },
      ],
      edges: [{ from: 'start', port: 'then', to: 's' }],
    });
    expect(errorsOf(written).join('\n')).toContain('writes variable "missing"');

    const read = graph({
      variables: [{ name: 'known', type: 'number', initial: 0 }],
      nodes: [
        { id: 'start', type: 'onStart' },
        {
          id: 'b',
          type: 'branch',
          condition: {
            type: 'compare',
            left: { kind: 'variable', name: 'unknown' },
            op: '>',
            right: { kind: 'number', value: 1 },
          },
        },
      ],
      edges: [{ from: 'start', port: 'then', to: 'b' }],
    });
    expect(errorsOf(read).join('\n')).toContain('reads variable "unknown"');
  });

  it('looks inside nested conditions for undeclared variables', () => {
    const subject = graph({
      variables: [{ name: 'a', type: 'boolean', initial: true }],
      nodes: [
        { id: 'start', type: 'onStart' },
        {
          id: 'b',
          type: 'branch',
          condition: {
            type: 'and',
            of: [
              { type: 'flag', name: 'a', expected: true },
              { type: 'not', of: { type: 'flag', name: 'buried', expected: true } },
            ],
          },
        },
      ],
      edges: [{ from: 'start', port: 'then', to: 'b' }],
    });
    // Two levels down inside an `and` holding a `not`. A check that only looked at the top level
    // would pass this and fail at runtime.
    expect(errorsOf(subject).join('\n')).toContain('"buried"');
  });

  it('refuses an edge running into an event node', () => {
    const subject = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'other', type: 'onStart' },
      ],
      edges: [{ from: 'start', port: 'then', to: 'other' }],
    });
    // Running into an event would run its chain a second time from the middle, which is never what
    // was meant and is hard to see on a canvas.
    expect(errorsOf(subject).join('\n')).toContain('cannot be run into');
  });

  it('catches duplicate node ids and duplicate variable names', () => {
    const subject = graph({
      variables: [
        { name: 'x', type: 'number', initial: 0 },
        { name: 'x', type: 'number', initial: 1 },
      ],
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'start', type: 'onStart' },
      ],
    });
    const messages = errorsOf(subject).join('\n');
    expect(messages).toContain('two nodes share the id');
    expect(messages).toContain('two variables are named');
  });

  it('reports a field the author has not filled in', () => {
    // The other half of `UnsetIdSchema`. The blank is legal to store — a half-built graph has to be
    // saveable — and refused at run time, because a Destroy node with no target destroys nothing
    // and says nothing, which is the worst of the three possible behaviours.
    const subject = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'kill', type: 'destroy', targetId: '' },
      ],
      edges: [{ from: 'start', port: 'then', to: 'kill' }],
    });
    expect(errorsOf(subject).join('\n')).toContain('no target object chosen');
    expect(graphIsRunnable(validateGraph(subject))).toBe(false);
  });

  it('calls an empty variable dropdown unchosen rather than undeclared', () => {
    const subject = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 's', type: 'setVariable', name: '', value: { kind: 'number', value: 1 } },
      ],
      edges: [{ from: 'start', port: 'then', to: 's' }],
    });
    const messages = errorsOf(subject).join('\n');
    expect(messages).toContain('no variable chosen');
    // Not `writes variable "", which is not declared` — a message naming a variable called nothing
    // sends the reader looking for one.
    expect(messages).not.toContain('not declared');
  });

  it('warns about a node nothing can reach, without blocking', () => {
    const subject = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'orphan', type: 'emit', event: 'ping', payload: {} },
      ],
    });
    const problems = validateGraph(subject);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.severity).toBe('warning');
    // A half-built graph is a normal state to be in while authoring. Refusing to run it would make
    // the editor unusable between the first node and the last.
    expect(graphIsRunnable(problems)).toBe(true);
  });

  it('reports the loop as an error with the nodes in the message', () => {
    const subject = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'a', type: 'emit', event: 'ping', payload: {} },
      ],
      edges: [
        { from: 'start', port: 'then', to: 'a' },
        { from: 'a', port: 'then', to: 'a' },
      ],
    });
    const problems = validateGraph(subject);
    const loop = problems.find((problem) => problem.message.includes('loop'));
    expect(loop?.severity).toBe('error');
    expect(loop?.nodeIds).toContain('a');
    expect(graphIsRunnable(problems)).toBe(false);
  });
});
