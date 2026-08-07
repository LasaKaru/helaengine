import {
  ANIMATION_STATES,
  EVENT_NODES,
  type GraphCondition,
  type GraphNode,
  type GraphNodeType,
  type GraphValue,
  type SceneGraph,
} from '@helaengine/schema';

/**
 * The editor's side of the node vocabulary: starting values, labels and grouping.
 *
 * The schema decides what a node *is*; this decides what the palette calls it and what it looks
 * like the moment it is dropped on the canvas. Those are two different jobs, and keeping them apart
 * means adding a node type is a schema change plus an entry here, with the compiler naming the
 * second if you forget it — `Record<GraphNodeType, …>` below is not decoration.
 */

/** The palette, in the order it is offered. Grouped because a flat list of eighteen is a wall. */
export const NODE_GROUPS: ReadonlyArray<{ label: string; types: readonly GraphNodeType[] }> = [
  { label: 'When…', types: ['onStart', 'onEvent', 'onTimer'] },
  { label: 'Flow', types: ['branch', 'wait', 'sequence'] },
  { label: 'Variables', types: ['setVariable', 'addToVariable'] },
  { label: 'Objects', types: ['spawn', 'destroy', 'setHidden', 'moveObject', 'setAnimation'] },
  { label: 'Player', types: ['damagePlayer', 'healPlayer', 'teleportPlayer'] },
  { label: 'Signals', types: ['emit', 'showMessage'] },
  { label: 'Levels', types: ['loadLevel'] },
];

/** What the palette calls each type. */
export const NODE_LABELS: Readonly<Record<GraphNodeType, string>> = {
  onStart: 'On start',
  onEvent: 'On event',
  onTimer: 'On timer',
  branch: 'Branch',
  wait: 'Wait',
  sequence: 'Sequence',
  setVariable: 'Set variable',
  addToVariable: 'Add to variable',
  emit: 'Emit event',
  spawn: 'Spawn object',
  destroy: 'Destroy object',
  setHidden: 'Show / hide',
  moveObject: 'Move object',
  setAnimation: 'Set animation',
  damagePlayer: 'Damage player',
  healPlayer: 'Heal player',
  teleportPlayer: 'Teleport player',
  showMessage: 'Show message',
  loadLevel: 'Load level',
};

/** Which of the three colours a node's header takes. Events read as starts, flow as decisions. */
export function nodeFamily(type: GraphNodeType): 'event' | 'flow' | 'action' {
  if (EVENT_NODES.includes(type)) return 'event';
  if (type === 'branch' || type === 'wait' || type === 'sequence' || type === 'loadLevel')
    return 'flow';
  return 'action';
}

/** Context the palette can offer a new node, so it lands valid rather than half-filled. */
export interface NodeContext {
  assetId?: string;
  objectId?: string;
  variableName?: string;
  levelId?: string;
}

/**
 * A new node of the given type, with every required field filled in.
 *
 * Every branch here returns something the schema accepts, which is why the canvas never has to hold
 * a node that would fail validation on save. Where a sensible default needs a scene — an asset to
 * spawn, an object to destroy — it comes from `context`, and the empty string when the scene has
 * none is deliberate: validation will say so, which is better than silently picking a wrong object.
 */
export function newNode(type: GraphNodeType, id: string, context: NodeContext = {}): GraphNode {
  const target = context.objectId ?? '';
  switch (type) {
    case 'onStart':
      return { id, type };
    case 'onEvent':
      return { id, type, event: 'doorOpened' };
    case 'onTimer':
      return { id, type, seconds: 5, repeat: false };
    case 'branch':
      return { id, type, condition: { type: 'playerHealthBelow', value: 50 } };
    case 'wait':
      return { id, type, seconds: 1 };
    case 'sequence':
      return { id, type, branches: 2 };
    case 'setVariable':
      return {
        id,
        type,
        name: context.variableName ?? '',
        value: { kind: 'number', value: 1 },
      };
    case 'addToVariable':
      return {
        id,
        type,
        name: context.variableName ?? '',
        amount: { kind: 'number', value: 1 },
      };
    case 'emit':
      return { id, type, event: 'doorOpened', payload: {} };
    case 'spawn':
      return { id, type, assetId: context.assetId ?? '', position: [0, 0, 0] };
    case 'destroy':
      return { id, type, targetId: target };
    case 'setHidden':
      return { id, type, targetId: target, hidden: true };
    case 'moveObject':
      return { id, type, targetId: target, position: [0, 0, 0] };
    case 'setAnimation':
      return { id, type, targetId: target, state: 'walk' };
    case 'damagePlayer':
      return { id, type, amount: 10 };
    case 'healPlayer':
      return { id, type, amount: 10 };
    case 'teleportPlayer':
      return { id, type, position: [0, 0, 0] };
    case 'showMessage':
      return { id, type, text: 'Hello', seconds: 3 };
    case 'loadLevel':
      // Never the level it is being added to: a door back to where you already are is never what
      // was meant, and the blank is reported rather than silently wrong.
      return { id, type, levelId: context.levelId ?? '', carryState: true };
  }
}

/** A short line describing what this particular node does, for the node's body on the canvas. */
export function describeNode(node: GraphNode): string {
  switch (node.type) {
    case 'onStart':
      return 'when the level begins';
    case 'onEvent':
      return `"${node.event}"`;
    case 'onTimer':
      return node.repeat ? `every ${node.seconds}s` : `after ${node.seconds}s`;
    case 'branch':
      return describeCondition(node.condition);
    case 'wait':
      return `${node.seconds}s`;
    case 'sequence':
      return `${node.branches} branches, in order`;
    case 'setVariable':
      return `${node.name || '—'} = ${describeValue(node.value)}`;
    case 'addToVariable':
      return `${node.name || '—'} += ${describeValue(node.amount)}`;
    case 'emit':
      return `"${node.event}"`;
    case 'spawn':
      return node.assetId || '—';
    case 'destroy':
    case 'setHidden':
    case 'moveObject':
      return node.targetId || '—';
    case 'setAnimation':
      return `${node.targetId || '—'} → ${node.state}`;
    case 'damagePlayer':
    case 'healPlayer':
      return `${node.amount} HP`;
    case 'teleportPlayer':
      return node.position.map((part) => part.toFixed(1)).join(', ');
    case 'showMessage':
      return `"${node.text}"`;
    case 'loadLevel':
      return `${node.levelId || '—'}${node.carryState ? '' : ', fresh start'}`;
  }
}

export function describeValue(value: GraphValue): string {
  return value.kind === 'variable' ? value.name || '—' : String(value.value);
}

/** A condition as one line. Nested combinators are parenthesised so precedence is never guessed. */
export function describeCondition(condition: GraphCondition): string {
  switch (condition.type) {
    case 'compare':
      return `${describeValue(condition.left)} ${condition.op} ${describeValue(condition.right)}`;
    case 'flag':
      return condition.expected ? condition.name : `not ${condition.name}`;
    case 'hasItem':
      return `has ${condition.atLeast}× ${condition.kind}`;
    case 'playerHealthBelow':
      return `health < ${condition.value}`;
    case 'and':
      return condition.of.map((inner) => `(${describeCondition(inner)})`).join(' and ');
    case 'or':
      return condition.of.map((inner) => `(${describeCondition(inner)})`).join(' or ');
    case 'not':
      return `not (${describeCondition(condition.of)})`;
  }
}

export const ANIMATION_STATE_OPTIONS = ANIMATION_STATES;

/**
 * An id no node in this graph is using.
 *
 * Counts up from the type name rather than generating a random string, because these ids show up in
 * validation messages and on the canvas, and `spawn3` tells you which node is meant where a uuid
 * sends you hunting.
 */
export function nextNodeId(graph: SceneGraph, type: GraphNodeType): string {
  const taken = new Set(graph.nodes.map((node) => node.id));
  for (let index = 1; ; index += 1) {
    const candidate = `${type}${index}`;
    if (!taken.has(candidate)) return candidate;
  }
}
