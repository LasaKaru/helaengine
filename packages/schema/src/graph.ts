import { z } from 'zod';
import { PickupKindSchema } from './inventory.js';
import { IdSchema, Vec3Schema } from './primitives.js';
import { EventNameSchema } from './trigger.js';
import { AnimationStateSchema } from './animation.js';

/**
 * Visual scripting, as a validated document.
 *
 * This is the answer to "HelaEngine needs to be as expressive as Unity" that does not require
 * giving up the thing that makes it worth using. Unity's power is arbitrary C#; every property this
 * project depends on — a release gate that can play a build, collaboration that is safe to open, a
 * repair loop that proposes patches, an export safe to hand to a stranger — rests on a scene being
 * *data*. So the graph is the Blueprints answer, not the C# one: nodes from a fixed list, typed
 * parameters, and edges between them. There is no `eval` anywhere in it and there cannot be.
 *
 * ## What it deliberately is not
 *
 * **There are no data wires.** A node's parameters are literals or references to named variables,
 * not sockets fed from other nodes' outputs. Full dataflow would mean type-checking every
 * connection, a much larger editor, and a document where "what is the value here" can only be
 * answered by running it. Literals-plus-variables covers "if health is below 50" and "set the door
 * flag", which is the overwhelming majority of what a level designer needs, and it stays readable
 * as JSON.
 *
 * Edges are therefore **execution** edges only: what runs next.
 *
 * ## The check that a text scripting language could not have
 *
 * A graph is validated for **loops that cannot terminate** before it ever runs — a cycle with no
 * `wait` in it would spin the frame forever. `findInstantCycles` is what makes that a load error
 * with the node names in it rather than a hung browser tab, and it is only possible because the
 * whole program is inspectable data.
 */

/** A value a node parameter can take: a constant, or the current value of a named variable. */
/**
 * An id, or the empty string meaning "not chosen yet".
 *
 * Authoring is a sequence of half-built states — a Destroy node exists for a moment before it is
 * told what to destroy, and on a fresh project there is nothing to point it at. Refusing the empty
 * string at the parse boundary would mean the editor could not save a scene mid-thought, so the
 * gap is legal to *store* and reported by `validateGraph` as an error that stops the graph running.
 * That is the same trade the rest of the document format makes: parse what the author can express,
 * refuse to run what cannot work.
 */
export const UnsetIdSchema = z.union([z.literal(''), IdSchema]);

export const GraphValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('number'), value: z.number() }),
  z.object({ kind: z.literal('boolean'), value: z.boolean() }),
  z.object({ kind: z.literal('text'), value: z.string().max(500) }),
  z.object({ kind: z.literal('variable'), name: UnsetIdSchema }),
]);
export type GraphValue = z.infer<typeof GraphValueSchema>;

export const VariableTypeSchema = z.enum(['number', 'boolean', 'text']);
export type VariableType = z.infer<typeof VariableTypeSchema>;

/**
 * A named value the graph can read and write.
 *
 * Scene-scoped, because object-scoped variables need a scoping rule in the editor before they are
 * useful and scene-scoped covers the doors, keys and counters a level is actually made of.
 */
export const GraphVariableSchema = z.object({
  name: IdSchema,
  type: VariableTypeSchema,
  /** Its value when the level starts. Also what a reset restores. */
  initial: z.union([z.number(), z.boolean(), z.string().max(500)]),
});
export type GraphVariable = z.infer<typeof GraphVariableSchema>;

export const COMPARISONS = ['==', '!=', '<', '<=', '>', '>='] as const;
export const ComparisonSchema = z.enum(COMPARISONS);

/**
 * A condition, as a small expression tree.
 *
 * A tree rather than a chain of condition *nodes*, because "the player has the key AND the boss is
 * dead" is one thought and drawing it as three boxes and two wires makes it three. Nesting is
 * capped by `MAX_CONDITION_DEPTH` — a document is untrusted input, and an unbounded recursive
 * schema is a stack overflow waiting for a hostile file.
 */
export const MAX_CONDITION_DEPTH = 6;

export type GraphCondition =
  | { type: 'compare'; left: GraphValue; op: z.infer<typeof ComparisonSchema>; right: GraphValue }
  | { type: 'flag'; name: string; expected: boolean }
  | { type: 'hasItem'; kind: z.infer<typeof PickupKindSchema>; atLeast: number }
  | { type: 'playerHealthBelow'; value: number }
  | { type: 'and'; of: GraphCondition[] }
  | { type: 'or'; of: GraphCondition[] }
  | { type: 'not'; of: GraphCondition };

function conditionAtDepth(depth: number): z.ZodType<GraphCondition> {
  const leaves = [
    z.object({
      type: z.literal('compare'),
      left: GraphValueSchema,
      op: ComparisonSchema,
      right: GraphValueSchema,
    }),
    z.object({ type: z.literal('flag'), name: UnsetIdSchema, expected: z.boolean().default(true) }),
    z.object({
      type: z.literal('hasItem'),
      kind: PickupKindSchema,
      atLeast: z.number().int().min(1).max(9999).default(1),
    }),
    z.object({ type: z.literal('playerHealthBelow'), value: z.number().min(0).max(10_000) }),
  ] as const;

  // At the depth limit the combinators are simply absent, so a document that nests deeper fails to
  // parse with a message about the field rather than crashing the parser.
  if (depth <= 0) return z.discriminatedUnion('type', [...leaves]) as z.ZodType<GraphCondition>;

  const nested = z.lazy(() => conditionAtDepth(depth - 1));
  return z.discriminatedUnion('type', [
    ...leaves,
    z.object({ type: z.literal('and'), of: z.array(nested).min(1).max(8) }),
    z.object({ type: z.literal('or'), of: z.array(nested).min(1).max(8) }),
    z.object({ type: z.literal('not'), of: nested }),
  ]) as z.ZodType<GraphCondition>;
}

export const GraphConditionSchema = conditionAtDepth(MAX_CONDITION_DEPTH);

/**
 * Every node type, as one discriminated union.
 *
 * The union *is* the closed vocabulary, and it closes at both ends at once: Zod rejects a `type` it
 * has never heard of when the document is parsed, and TypeScript refuses to compile a runtime that
 * does not handle every arm. Adding a node means adding it here, which means adding it to the
 * runtime, which means the two cannot drift.
 *
 * Nodes fall into three kinds, distinguished by nothing but their outputs — the runtime knows which
 * is which from `NODE_OUTPUTS` below rather than from a `kind` field somebody could set wrongly.
 */
export const GraphNodeSchema = z.discriminatedUnion('type', [
  // --- Events: where execution starts. No inputs. ---
  z.object({ id: IdSchema, type: z.literal('onStart') }),
  z.object({ id: IdSchema, type: z.literal('onEvent'), event: EventNameSchema }),
  z.object({
    id: IdSchema,
    type: z.literal('onTimer'),
    seconds: z.number().min(0.05).max(3600),
    repeat: z.boolean().default(false),
  }),

  // --- Flow ---
  z.object({ id: IdSchema, type: z.literal('branch'), condition: GraphConditionSchema }),
  z.object({
    id: IdSchema,
    type: z.literal('wait'),
    seconds: z.number().min(0.01).max(3600),
  }),
  /**
   * Lets one output feed several chains in a defined order.
   *
   * Without it, two edges from one port would run in whatever order they were stored in, and a
   * level whose behaviour depends on document ordering is a level that breaks when somebody
   * reorders it in the editor.
   */
  z.object({ id: IdSchema, type: z.literal('sequence'), branches: z.number().int().min(2).max(8) }),

  // --- Actions ---
  z.object({
    id: IdSchema,
    type: z.literal('setVariable'),
    name: UnsetIdSchema,
    value: GraphValueSchema,
  }),
  z.object({
    id: IdSchema,
    type: z.literal('addToVariable'),
    name: UnsetIdSchema,
    amount: GraphValueSchema,
  }),
  z.object({
    id: IdSchema,
    type: z.literal('emit'),
    event: EventNameSchema,
    payload: z.record(z.unknown()).default({}),
  }),
  z.object({
    id: IdSchema,
    type: z.literal('spawn'),
    assetId: UnsetIdSchema,
    position: Vec3Schema.default([0, 0, 0]),
  }),
  z.object({ id: IdSchema, type: z.literal('destroy'), targetId: UnsetIdSchema }),
  z.object({
    id: IdSchema,
    type: z.literal('setHidden'),
    targetId: UnsetIdSchema,
    hidden: z.boolean().default(true),
  }),
  z.object({
    id: IdSchema,
    type: z.literal('moveObject'),
    targetId: UnsetIdSchema,
    position: Vec3Schema,
  }),
  z.object({
    id: IdSchema,
    type: z.literal('setAnimation'),
    targetId: UnsetIdSchema,
    state: AnimationStateSchema,
  }),
  z.object({
    id: IdSchema,
    type: z.literal('damagePlayer'),
    amount: z.number().min(0).max(10_000),
  }),
  z.object({ id: IdSchema, type: z.literal('healPlayer'), amount: z.number().min(0).max(10_000) }),
  z.object({ id: IdSchema, type: z.literal('teleportPlayer'), position: Vec3Schema }),
  /**
   * Ends this level and starts another.
   *
   * The chain stops here — anything wired after it would be running in a level that is being torn
   * down. The runtime signals the request rather than performing it: loading a level needs an asset
   * loader and a render target, neither of which the interpreter has or should have.
   */
  z.object({
    id: IdSchema,
    type: z.literal('loadLevel'),
    levelId: UnsetIdSchema,
    /** Whether the player keeps their health, weapons and the graph's variables. */
    carryState: z.boolean().default(true),
  }),
  z.object({
    id: IdSchema,
    type: z.literal('showMessage'),
    text: z.string().min(1).max(200),
    seconds: z.number().min(0.5).max(30).default(3),
  }),
]);
export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphNodeType = GraphNode['type'];

/**
 * How many execution outputs each node type has, and what they are called.
 *
 * The single source of truth for the graph's shape. The editor draws ports from it, validation
 * checks edges against it, and the runtime follows it — so a node cannot gain an output in one
 * place and not the others.
 */
export const NODE_OUTPUTS: Readonly<Record<GraphNodeType, readonly string[]>> = {
  onStart: ['then'],
  onEvent: ['then'],
  onTimer: ['then'],
  branch: ['true', 'false'],
  wait: ['then'],
  // Named by index; `sequence` declares how many it has, and validation checks against that.
  sequence: [],
  setVariable: ['then'],
  addToVariable: ['then'],
  emit: ['then'],
  spawn: ['then'],
  destroy: ['then'],
  setHidden: ['then'],
  moveObject: ['then'],
  setAnimation: ['then'],
  damagePlayer: ['then'],
  healPlayer: ['then'],
  teleportPlayer: ['then'],
  showMessage: ['then'],
  // Nothing follows a level change: the level this node lives in is about to stop existing.
  loadLevel: [],
};

/** Node types that start a chain. Nothing may connect *into* one. */
export const EVENT_NODES: readonly GraphNodeType[] = ['onStart', 'onEvent', 'onTimer'];

/**
 * Node types that let time pass before the chain continues.
 *
 * The list is what makes cycle detection meaningful: a loop containing one of these is a repeating
 * behaviour, and a loop containing none of them cannot terminate within a frame.
 */
export const DELAY_NODES: readonly GraphNodeType[] = ['wait', 'onTimer'];

export function outputsOf(node: GraphNode): readonly string[] {
  if (node.type === 'sequence') {
    return Array.from({ length: node.branches }, (_, index) => String(index));
  }
  return NODE_OUTPUTS[node.type];
}

export const GraphEdgeSchema = z.object({
  from: IdSchema,
  /** Which output of `from`. `then`, `true`/`false`, or a sequence branch index. */
  port: z.string().min(1).max(32).default('then'),
  to: IdSchema,
});
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;

/** Where a node sits on the editor's canvas. Presentation only; the runtime ignores it. */
export const GraphLayoutSchema = z.record(IdSchema, z.tuple([z.number(), z.number()]));

export const SceneGraphSchema = z.object({
  variables: z.array(GraphVariableSchema).max(64).default([]),
  nodes: z.array(GraphNodeSchema).max(256).default([]),
  edges: z.array(GraphEdgeSchema).max(512).default([]),
  layout: GraphLayoutSchema.default({}),
});
export type SceneGraph = z.infer<typeof SceneGraphSchema>;

export const EMPTY_GRAPH: SceneGraph = { variables: [], nodes: [], edges: [], layout: {} };

/** A problem found by `validateGraph`. Not a parse error — the document is well-formed. */
export interface GraphProblem {
  /** `error` blocks the graph from running; `warning` is worth saying and does not. */
  severity: 'error' | 'warning';
  message: string;
  /** Nodes involved, so the editor can highlight them. */
  nodeIds: string[];
}

/**
 * Cycles that contain no delay.
 *
 * Returned as the node ids in each loop, so the message can name them. This is the check a text
 * scripting language cannot offer: `while (true) {}` in C# is a hung game discovered by playing it,
 * and here it is a load error with the nodes listed before anything runs.
 *
 * Depth-first with a colouring, which is the standard way and the only one that reports the cycle
 * rather than merely its existence. `wait` and `onTimer` cut an edge for this purpose: a loop that
 * passes through one of them yields the frame, which is a repeating behaviour rather than a hang.
 */
export function findInstantCycles(graph: SceneGraph): string[][] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const next = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const source = byId.get(edge.from);
    // An edge leaving a delay node cannot close an instant loop, so it is simply not followed.
    if (!source || DELAY_NODES.includes(source.type)) continue;
    next.set(edge.from, [...(next.get(edge.from) ?? []), edge.to]);
  }

  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const walk = (id: string): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      // Back edge: everything from where this id first appeared is the loop.
      const at = stack.indexOf(id);
      if (at >= 0) cycles.push(stack.slice(at));
      return;
    }

    state.set(id, 'visiting');
    stack.push(id);
    for (const target of next.get(id) ?? []) walk(target);
    stack.pop();
    state.set(id, 'done');
  };

  for (const node of graph.nodes) walk(node.id);
  return cycles;
}

/**
 * Everything wrong with a graph that parsing cannot catch.
 *
 * Parsing proves each node is a known type with valid fields. It cannot know whether an edge points
 * at a node that exists, whether a variable was declared, or whether the whole thing loops forever
 * — those are properties of the graph rather than of any one part, and they are exactly the ones
 * that turn into a broken level rather than a broken file.
 */
export function validateGraph(graph: SceneGraph): GraphProblem[] {
  const problems: GraphProblem[] = [];
  const byId = new Map<string, GraphNode>();

  for (const node of graph.nodes) {
    if (byId.has(node.id)) {
      problems.push({
        severity: 'error',
        message: `two nodes share the id "${node.id}"`,
        nodeIds: [node.id],
      });
    }
    byId.set(node.id, node);
  }

  const declared = new Set(graph.variables.map((variable) => variable.name));
  const seenVariableNames = new Set<string>();
  for (const variable of graph.variables) {
    if (seenVariableNames.has(variable.name)) {
      problems.push({
        severity: 'error',
        message: `two variables are named "${variable.name}"`,
        nodeIds: [],
      });
    }
    seenVariableNames.add(variable.name);
  }

  /**
   * A field the author has not filled in yet.
   *
   * An error rather than a warning: `UnsetIdSchema` lets the document *hold* the gap so a
   * half-built graph can be saved, and this is the other half of that trade. Without it a Destroy
   * node with no target would load, run, and quietly destroy nothing — the exact failure that sends
   * somebody hunting through a level for a bug that is really a blank dropdown.
   */
  const checkSet = (value: string, nodeId: string, what: string): void => {
    if (value === '') {
      problems.push({
        severity: 'error',
        message: `node "${nodeId}" has no ${what} chosen`,
        nodeIds: [nodeId],
      });
    }
  };

  const checkValue = (value: GraphValue, nodeId: string): void => {
    if (value.kind === 'variable' && value.name === '') {
      checkSet(value.name, nodeId, 'variable');
      return;
    }
    if (value.kind === 'variable' && !declared.has(value.name)) {
      problems.push({
        severity: 'error',
        message: `node "${nodeId}" reads variable "${value.name}", which is not declared`,
        nodeIds: [nodeId],
      });
    }
  };

  const checkCondition = (condition: GraphCondition, nodeId: string): void => {
    switch (condition.type) {
      case 'compare':
        checkValue(condition.left, nodeId);
        checkValue(condition.right, nodeId);
        break;
      case 'flag':
        if (condition.name === '') {
          checkSet(condition.name, nodeId, 'flag');
        } else if (!declared.has(condition.name)) {
          problems.push({
            severity: 'error',
            message: `node "${nodeId}" reads flag "${condition.name}", which is not declared`,
            nodeIds: [nodeId],
          });
        }
        break;
      case 'and':
      case 'or':
        for (const inner of condition.of) checkCondition(inner, nodeId);
        break;
      case 'not':
        checkCondition(condition.of, nodeId);
        break;
      default:
        break;
    }
  };

  for (const node of graph.nodes) {
    if (node.type === 'branch') checkCondition(node.condition, node.id);
    if (node.type === 'spawn') checkSet(node.assetId, node.id, 'asset');
    if (node.type === 'loadLevel') checkSet(node.levelId, node.id, 'level');
    if (
      node.type === 'destroy' ||
      node.type === 'setHidden' ||
      node.type === 'moveObject' ||
      node.type === 'setAnimation'
    ) {
      checkSet(node.targetId, node.id, 'target object');
    }
    if (node.type === 'setVariable') {
      checkValue(node.value, node.id);
      if (node.name === '') {
        checkSet(node.name, node.id, 'variable');
      } else if (!declared.has(node.name)) {
        problems.push({
          severity: 'error',
          message: `node "${node.id}" writes variable "${node.name}", which is not declared`,
          nodeIds: [node.id],
        });
      }
    }
    if (node.type === 'addToVariable') {
      checkValue(node.amount, node.id);
      if (node.name === '') {
        checkSet(node.name, node.id, 'variable');
      } else if (!declared.has(node.name)) {
        problems.push({
          severity: 'error',
          message: `node "${node.id}" adds to variable "${node.name}", which is not declared`,
          nodeIds: [node.id],
        });
      }
    }
  }

  for (const edge of graph.edges) {
    const source = byId.get(edge.from);
    const target = byId.get(edge.to);

    if (!source) {
      problems.push({
        severity: 'error',
        message: `an edge starts at "${edge.from}", which is not a node`,
        nodeIds: [edge.from],
      });
      continue;
    }
    if (!target) {
      problems.push({
        severity: 'error',
        message: `an edge from "${edge.from}" ends at "${edge.to}", which is not a node`,
        nodeIds: [edge.from],
      });
      continue;
    }
    if (!outputsOf(source).includes(edge.port)) {
      problems.push({
        severity: 'error',
        message: `node "${edge.from}" has no output "${edge.port}"`,
        nodeIds: [edge.from],
      });
    }
    if (EVENT_NODES.includes(target.type)) {
      // An event is where execution *starts*. Running into one would run its chain a second time
      // from the middle, which is never what was meant and is hard to see on a canvas.
      problems.push({
        severity: 'error',
        message: `node "${edge.to}" is an event and cannot be run into`,
        nodeIds: [edge.from, edge.to],
      });
    }
  }

  for (const cycle of findInstantCycles(graph)) {
    problems.push({
      severity: 'error',
      message:
        `these nodes form a loop with no wait in it, which would never finish: ${cycle.join(' → ')}. ` +
        'Add a Wait node, or break the loop.',
      nodeIds: cycle,
    });
  }

  // Warnings: things that are legal and almost certainly a mistake.
  const reachable = new Set<string>();
  const queue = graph.nodes
    .filter((node) => EVENT_NODES.includes(node.type))
    .map((node) => node.id);
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    queue.push(...(outgoing.get(id) ?? []));
  }

  for (const node of graph.nodes) {
    if (reachable.has(node.id)) continue;
    problems.push({
      severity: 'warning',
      message: `node "${node.id}" is never reached — nothing connects to it from an event`,
      nodeIds: [node.id],
    });
  }

  return problems;
}

/** Whether a graph may run. Warnings do not block. */
export function graphIsRunnable(problems: readonly GraphProblem[]): boolean {
  return !problems.some((problem) => problem.severity === 'error');
}
