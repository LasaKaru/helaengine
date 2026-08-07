import { SceneGraphSchema, type SceneGraph } from '@helaengine/schema';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphRuntime, STEP_BUDGET, graphHasContent } from './GraphRuntime.js';
import { INERT_WORLD, type WorldHandle } from '../world.js';

/**
 * The interpreter, against real graphs.
 *
 * A tiny event bus rather than a mock, because the bus is half of what the runtime does: an
 * `onEvent` node that subscribed to the wrong name, or a `stop` that left a listener behind, is a
 * failure a mocked `on` would report as success.
 */
function makeBus() {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emitted: { event: string; payload: unknown }[] = [];
  return {
    emitted,
    get listenerCount(): number {
      return [...listeners.values()].reduce((total, set) => total + set.size, 0);
    },
    emit(event: string, payload?: unknown): void {
      emitted.push({ event, payload });
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    },
    on(event: string, listener: (payload: unknown) => void): () => void {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
      return () => set.delete(listener);
    },
  };
}

function graph(parts: Partial<SceneGraph>): SceneGraph {
  return SceneGraphSchema.parse(parts);
}

let bus: ReturnType<typeof makeBus>;
let warnings: string[];
let world: WorldHandle;

beforeEach(() => {
  bus = makeBus();
  warnings = [];
  world = { ...INERT_WORLD };
});

function runtimeFor(subject: SceneGraph): GraphRuntime {
  return new GraphRuntime({
    graph: subject,
    world,
    bus,
    warn: (message) => warnings.push(message),
  });
}

describe('graphHasContent', () => {
  it('is false for a graph with no events, however many other nodes it has', () => {
    // Every scene saved before graphs existed has an empty one, and constructing a runtime for it
    // would validate a document and subscribe to nothing, sixty times a second, for no reason.
    expect(graphHasContent(graph({}))).toBe(false);
    expect(
      graphHasContent(graph({ nodes: [{ id: 'a', type: 'emit', event: 'x', payload: {} }] })),
    ).toBe(false);
    expect(graphHasContent(graph({ nodes: [{ id: 's', type: 'onStart' }] }))).toBe(true);
  });
});

describe('GraphRuntime', () => {
  it('runs a chain from onStart', () => {
    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 'a', type: 'emit', event: 'opened', payload: { door: 1 } },
        ],
        edges: [{ from: 'start', port: 'then', to: 'a' }],
      }),
    );

    runtime.start();
    expect(bus.emitted).toEqual([{ event: 'opened', payload: { door: 1 } }]);
  });

  it('runs a chain when a named event reaches the bus', () => {
    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'on', type: 'onEvent', event: 'keyTaken' },
          { id: 'a', type: 'emit', event: 'gateOpened', payload: {} },
        ],
        edges: [{ from: 'on', port: 'then', to: 'a' }],
      }),
    );

    runtime.start();
    expect(bus.emitted).toHaveLength(0);
    bus.emit('keyTaken');
    expect(bus.emitted.map((entry) => entry.event)).toEqual(['keyTaken', 'gateOpened']);
  });

  it('takes the branch the condition chooses', () => {
    const subject = graph({
      variables: [{ name: 'score', type: 'number', initial: 5 }],
      nodes: [
        { id: 'on', type: 'onEvent', event: 'check' },
        {
          id: 'b',
          type: 'branch',
          condition: {
            type: 'compare',
            left: { kind: 'variable', name: 'score' },
            op: '>=',
            right: { kind: 'number', value: 10 },
          },
        },
        { id: 'win', type: 'emit', event: 'won', payload: {} },
        { id: 'lose', type: 'emit', event: 'lost', payload: {} },
      ],
      edges: [
        { from: 'on', port: 'then', to: 'b' },
        { from: 'b', port: 'true', to: 'win' },
        { from: 'b', port: 'false', to: 'lose' },
      ],
    });

    const runtime = runtimeFor(subject);
    runtime.start();

    bus.emit('check');
    expect(bus.emitted.map((entry) => entry.event)).toContain('lost');

    // The same graph, a different variable — the condition is read each time rather than baked in
    // when the runtime was built.
    bus.emitted.length = 0;
    const second = runtimeFor({
      ...subject,
      variables: [{ name: 'score', type: 'number', initial: 20 }],
    });
    second.start();
    bus.emit('check');
    expect(bus.emitted.map((entry) => entry.event)).toContain('won');
  });

  it('reads and writes variables', () => {
    const runtime = runtimeFor(
      graph({
        variables: [{ name: 'coins', type: 'number', initial: 3 }],
        nodes: [
          { id: 'on', type: 'onEvent', event: 'pickup' },
          { id: 'add', type: 'addToVariable', name: 'coins', amount: { kind: 'number', value: 2 } },
        ],
        edges: [{ from: 'on', port: 'then', to: 'add' }],
      }),
    );

    runtime.start();
    expect(runtime.variable('coins')).toBe(3);
    bus.emit('pickup');
    bus.emit('pickup');
    expect(runtime.variable('coins')).toBe(7);
  });

  it('refuses to add to something that is not a number, and says so', () => {
    const runtime = runtimeFor(
      graph({
        variables: [{ name: 'name', type: 'text', initial: 'hero' }],
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 'add', type: 'addToVariable', name: 'name', amount: { kind: 'number', value: 1 } },
        ],
        edges: [{ from: 'start', port: 'then', to: 'add' }],
      }),
    );

    runtime.start();
    // Silently concatenating would leave a level whose counter is `hero1` and an author with no
    // idea why.
    expect(runtime.variable('name')).toBe('hero');
    expect(warnings.join('\n')).toContain('is not a number');
  });

  it('refuses to order-compare values that are not both numbers', () => {
    const runtime = runtimeFor(
      graph({
        variables: [{ name: 'label', type: 'text', initial: 'b' }],
        nodes: [
          { id: 'start', type: 'onStart' },
          {
            id: 'b',
            type: 'branch',
            condition: {
              type: 'compare',
              left: { kind: 'variable', name: 'label' },
              op: '<',
              right: { kind: 'number', value: 5 },
            },
          },
          { id: 'yes', type: 'emit', event: 'yes', payload: {} },
          { id: 'no', type: 'emit', event: 'no', payload: {} },
        ],
        edges: [
          { from: 'start', port: 'then', to: 'b' },
          { from: 'b', port: 'true', to: 'yes' },
          { from: 'b', port: 'false', to: 'no' },
        ],
      }),
    );

    runtime.start();
    // `'b' < 5` is a question without an answer, and JavaScript's coercion would invent one.
    expect(bus.emitted.map((entry) => entry.event)).toEqual(['no']);
  });

  it('waits before continuing, and resumes from update', () => {
    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 'w', type: 'wait', seconds: 2 },
          { id: 'a', type: 'emit', event: 'later', payload: {} },
        ],
        edges: [
          { from: 'start', port: 'then', to: 'w' },
          { from: 'w', port: 'then', to: 'a' },
        ],
      }),
    );

    runtime.start();
    expect(bus.emitted).toHaveLength(0);
    runtime.update(1);
    expect(bus.emitted).toHaveLength(0);
    runtime.update(1.5);
    expect(bus.emitted.map((entry) => entry.event)).toEqual(['later']);
  });

  it('fires a repeating timer more than once and a one-shot exactly once', () => {
    const repeating = runtimeFor(
      graph({
        nodes: [
          { id: 't', type: 'onTimer', seconds: 1, repeat: true },
          { id: 'a', type: 'emit', event: 'tick', payload: {} },
        ],
        edges: [{ from: 't', port: 'then', to: 'a' }],
      }),
    );
    repeating.start();
    for (let step = 0; step < 3; step += 1) repeating.update(1);
    expect(bus.emitted.filter((entry) => entry.event === 'tick')).toHaveLength(3);

    bus.emitted.length = 0;
    const once = runtimeFor(
      graph({
        nodes: [
          { id: 't', type: 'onTimer', seconds: 1, repeat: false },
          { id: 'a', type: 'emit', event: 'once', payload: {} },
        ],
        edges: [{ from: 't', port: 'then', to: 'a' }],
      }),
    );
    once.start();
    for (let step = 0; step < 3; step += 1) once.update(1);
    expect(bus.emitted.filter((entry) => entry.event === 'once')).toHaveLength(1);
  });

  it('runs a loop through a wait without hanging', () => {
    // The legal loop: a repeating behaviour, because the chain yields the frame each time round.
    const runtime = runtimeFor(
      graph({
        variables: [{ name: 'n', type: 'number', initial: 0 }],
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 'add', type: 'addToVariable', name: 'n', amount: { kind: 'number', value: 1 } },
          { id: 'w', type: 'wait', seconds: 1 },
        ],
        edges: [
          { from: 'start', port: 'then', to: 'add' },
          { from: 'add', port: 'then', to: 'w' },
          { from: 'w', port: 'then', to: 'add' },
        ],
      }),
    );

    runtime.start();
    expect(runtime.variable('n')).toBe(1);
    runtime.update(1);
    runtime.update(1);
    expect(runtime.variable('n')).toBe(3);
  });

  it('runs sequence branches in order', () => {
    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 's', type: 'sequence', branches: 3 },
          { id: 'a', type: 'emit', event: 'first', payload: {} },
          { id: 'b', type: 'emit', event: 'second', payload: {} },
          { id: 'c', type: 'emit', event: 'third', payload: {} },
        ],
        edges: [
          { from: 'start', port: 'then', to: 's' },
          // Deliberately out of document order: the order that matters is the port's, not the
          // array's, or a level breaks when somebody reorders it in the editor.
          { from: 's', port: '2', to: 'c' },
          { from: 's', port: '0', to: 'a' },
          { from: 's', port: '1', to: 'b' },
        ],
      }),
    );

    runtime.start();
    expect(bus.emitted.map((entry) => entry.event)).toEqual(['first', 'second', 'third']);
  });

  it('refuses to start a graph with errors, and says why', () => {
    const runtime = runtimeFor(
      graph({
        nodes: [{ id: 'start', type: 'onStart' }],
        edges: [{ from: 'start', port: 'then', to: 'ghost' }],
      }),
    );

    expect(runtime.runnable).toBe(false);
    runtime.start();
    // Refused rather than run partially: a graph with a dangling edge means something the runtime
    // cannot guess, and running the reachable half is subtly wrong rather than visibly broken.
    expect(warnings.join('\n')).toContain('not started');
    expect(bus.listenerCount).toBe(0);
  });

  it('refuses a graph that would loop forever, before running any of it', () => {
    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 'a', type: 'emit', event: 'boom', payload: {} },
        ],
        edges: [
          { from: 'start', port: 'then', to: 'a' },
          { from: 'a', port: 'then', to: 'a' },
        ],
      }),
    );

    runtime.start();
    // The check that a text scripting language cannot offer: this is a load error naming the node,
    // not a hung tab discovered by playing the level.
    expect(bus.emitted).toHaveLength(0);
    expect(warnings.join('\n')).toContain('loop');
  });

  it('stops a runaway fan-out with the budget rather than hanging', () => {
    // Cycle detection covers loops; it does not cover an acyclic graph whose fan-out is enormous.
    // Seven three-way sequences chained is 3^7 = 2,187 steps, comfortably past the budget.
    const nodes: SceneGraph['nodes'] = [{ id: 'start', type: 'onStart' }];
    const edges: SceneGraph['edges'] = [];
    const depth = 7;
    for (let level = 0; level < depth; level += 1) {
      nodes.push({ id: `s${level}`, type: 'sequence', branches: 3 });
    }
    edges.push({ from: 'start', port: 'then', to: 's0' });
    for (let level = 0; level < depth - 1; level += 1) {
      for (let branch = 0; branch < 3; branch += 1) {
        edges.push({ from: `s${level}`, port: String(branch), to: `s${level + 1}` });
      }
    }

    const runtime = runtimeFor(graph({ nodes, edges }));
    runtime.start();
    expect(warnings.join('\n')).toContain(`${STEP_BUDGET} nodes`);
  });

  it('lets go of its bus subscriptions when stopped', () => {
    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'on', type: 'onEvent', event: 'ping' },
          { id: 'a', type: 'emit', event: 'pong', payload: {} },
        ],
        edges: [{ from: 'on', port: 'then', to: 'a' }],
      }),
    );

    runtime.start();
    expect(bus.listenerCount).toBe(1);

    runtime.stop();
    expect(bus.listenerCount).toBe(0);

    bus.emitted.length = 0;
    bus.emit('ping');
    // A listener left behind keeps a stopped preview reacting to the next one's events, which
    // reads as the editor being haunted.
    expect(bus.emitted.map((entry) => entry.event)).toEqual(['ping']);
  });

  it('reaches the world for the actions that touch it', () => {
    world = {
      ...INERT_WORLD,
      spawn: vi.fn(() => 'obj_9001'),
      destroy: vi.fn(),
      damagePlayer: vi.fn(),
      setObjectHidden: vi.fn(() => true),
      setAnimationState: vi.fn(() => true),
    };

    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 's', type: 'sequence', branches: 5 },
          { id: 'spawn', type: 'spawn', assetId: 'enemy_fox', position: [1, 0, 2] },
          { id: 'kill', type: 'destroy', targetId: 'obj_0001' },
          { id: 'hurt', type: 'damagePlayer', amount: 10 },
          { id: 'heal', type: 'healPlayer', amount: 4 },
          { id: 'anim', type: 'setAnimation', targetId: 'obj_0002', state: 'run' },
        ],
        edges: [
          { from: 'start', port: 'then', to: 's' },
          { from: 's', port: '0', to: 'spawn' },
          { from: 's', port: '1', to: 'kill' },
          { from: 's', port: '2', to: 'hurt' },
          { from: 's', port: '3', to: 'heal' },
          { from: 's', port: '4', to: 'anim' },
        ],
      }),
    );

    runtime.start();

    expect(world.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ assetId: 'enemy_fox', position: [1, 0, 2] }),
    );
    expect(world.destroy).toHaveBeenCalledWith('obj_0001');
    expect(world.damagePlayer).toHaveBeenCalledWith(10);
    // Healing is negative damage, so there is one place that decides what health may be rather
    // than two sets of clamping rules to keep in step.
    expect(world.damagePlayer).toHaveBeenCalledWith(-4);
    expect(world.setAnimationState).toHaveBeenCalledWith('obj_0002', 'run');
  });

  it('asks the world about the inventory rather than knowing about it', () => {
    world = { ...INERT_WORLD, itemCount: vi.fn(() => 3) };
    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'start', type: 'onStart' },
          {
            id: 'b',
            type: 'branch',
            condition: { type: 'hasItem', kind: 'ammo', atLeast: 2 },
          },
          { id: 'yes', type: 'emit', event: 'armed', payload: {} },
        ],
        edges: [
          { from: 'start', port: 'then', to: 'b' },
          { from: 'b', port: 'true', to: 'yes' },
        ],
      }),
    );

    runtime.start();
    expect(world.itemCount).toHaveBeenCalledWith('ammo');
    expect(bus.emitted.map((entry) => entry.event)).toEqual(['armed']);
  });

  it('puts a message on the bus rather than into the HUD', () => {
    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 'm', type: 'showMessage', text: 'The gate opens.', seconds: 4 },
        ],
        edges: [{ from: 'start', port: 'then', to: 'm' }],
      }),
    );

    runtime.start();
    // On the bus so the same message reaches anything that wants it — the HUD, a subtitle track, a
    // test — and the graph stays independent of the UI.
    expect(bus.emitted).toEqual([
      { event: 'hudMessage', payload: { text: 'The gate opens.', seconds: 4 } },
    ]);
  });

  it('starts once, however many times it is asked', () => {
    const runtime = runtimeFor(
      graph({
        nodes: [
          { id: 'start', type: 'onStart' },
          { id: 'a', type: 'emit', event: 'ping', payload: {} },
        ],
        edges: [{ from: 'start', port: 'then', to: 'a' }],
      }),
    );

    runtime.start();
    runtime.start();
    expect(bus.emitted).toHaveLength(1);
  });
});

/**
 * Level transitions.
 *
 * The graph asks; it does not act. These pin that separation, because the tempting shortcut — have
 * the interpreter load the level itself — would give a document a way to steer a fetch, and would
 * tear down the objects whose update is on the stack at the moment the request is made.
 */
describe('loadLevel', () => {
  const door = (levelId: string, carryState = true): SceneGraph =>
    graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'go', type: 'loadLevel', levelId, carryState },
      ],
      edges: [{ from: 'start', port: 'then', to: 'go' }],
    });

  it('asks the world rather than doing anything itself', () => {
    const asked: Array<[string, boolean]> = [];
    world = { ...INERT_WORLD, requestLevel: (levelId, carry) => asked.push([levelId, carry]) };

    runtimeFor(door('caves')).start();
    expect(asked).toEqual([['caves', true]]);
  });

  it('carries the flag the author set', () => {
    const asked: Array<[string, boolean]> = [];
    world = { ...INERT_WORLD, requestLevel: (levelId, carry) => asked.push([levelId, carry]) };

    runtimeFor(door('caves', false)).start();
    expect(asked).toEqual([['caves', false]]);
  });

  it('refuses to run with no level chosen', () => {
    const asked: string[] = [];
    world = { ...INERT_WORLD, requestLevel: (levelId) => asked.push(levelId) };

    runtimeFor(door('')).start();
    // The blank is a validation error, so the graph never starts — a door that silently goes
    // nowhere is the failure this is here to prevent.
    expect(asked).toEqual([]);
    expect(warnings.join('\n')).toContain('no level chosen');
  });

  it('runs nothing after itself', () => {
    // `loadLevel` has no outputs, so there is nothing to wire — but a node that fell through to the
    // `then` port would run the next chain inside a level that is being torn down.
    const asked: string[] = [];
    world = { ...INERT_WORLD, requestLevel: (levelId) => asked.push(levelId) };

    const subject = graph({
      nodes: [
        { id: 'start', type: 'onStart' },
        { id: 'go', type: 'loadLevel', levelId: 'caves', carryState: true },
        { id: 'after', type: 'emit', event: 'shouldNotHappen', payload: {} },
      ],
      edges: [
        { from: 'start', port: 'then', to: 'go' },
        // Refused by validation, which is the point: there is no port to attach this to.
        { from: 'go', port: 'then', to: 'after' },
      ],
    });
    const runtime = runtimeFor(subject);
    expect(runtime.runnable).toBe(false);
    runtime.start();
    expect(bus.emitted.map((entry) => entry.event)).not.toContain('shouldNotHappen');
  });
});

describe('carrying variables between levels', () => {
  const withVariables = (
    variables: Array<{
      name: string;
      type: 'number' | 'boolean' | 'text';
      initial: string | number | boolean;
    }>,
  ): SceneGraph => graph({ variables, nodes: [{ id: 'start', type: 'onStart' }] });

  it('hands out a snapshot, not the live map', () => {
    const runtime = runtimeFor(withVariables([{ name: 'score', type: 'number', initial: 5 }]));
    runtime.start();
    const carried = runtime.variables();
    // Held across a teardown by the caller, so `stop` must not empty it under them.
    runtime.stop();
    expect(carried).toEqual({ score: 5 });
  });

  it('keeps a variable the next level declares', () => {
    const runtime = runtimeFor(withVariables([{ name: 'score', type: 'number', initial: 0 }]));
    runtime.start();
    runtime.restoreVariables({ score: 42 });
    expect(runtime.variable('score')).toBe(42);
  });

  it('drops one it does not', () => {
    const runtime = runtimeFor(withVariables([{ name: 'score', type: 'number', initial: 0 }]));
    runtime.start();
    runtime.restoreVariables({ score: 42, secretsFound: 3 });

    // A level has to be openable on its own. Inheriting an undeclared variable would make it behave
    // differently depending on which door the player came through.
    expect(runtime.variable('secretsFound')).toBeUndefined();
    expect(runtime.variable('score')).toBe(42);
  });

  it('drops one whose type does not match', () => {
    const runtime = runtimeFor(withVariables([{ name: 'score', type: 'number', initial: 7 }]));
    runtime.start();
    runtime.restoreVariables({ score: 'lots' });

    // Two levels spelling `score` differently is a mistake, and taking the text would put a string
    // where every comparison in this level expects a number.
    expect(runtime.variable('score')).toBe(7);
  });

  it('ignores a restore before the graph has started', () => {
    const runtime = runtimeFor(withVariables([{ name: 'score', type: 'number', initial: 0 }]));
    runtime.restoreVariables({ score: 42 });
    // `start` writes every initial value, so restoring first would be overwritten anyway — silently
    // producing a level that lost the player's progress.
    expect(runtime.variable('score')).toBeUndefined();
  });
});
