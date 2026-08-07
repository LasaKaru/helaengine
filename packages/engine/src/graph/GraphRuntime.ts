import * as THREE from 'three';
import {
  EVENT_NODES,
  graphIsRunnable,
  validateGraph,
  type GraphCondition,
  type GraphNode,
  type GraphProblem,
  type GraphValue,
  type SceneGraph,
} from '@helaengine/schema';
import type { WorldHandle } from '../world.js';

/**
 * Runs a scene's visual script.
 *
 * An interpreter over validated data, and every property that matters follows from that word. It
 * cannot call a function a document names, because a document names no functions — only node types
 * from a closed union, which TypeScript forces this switch to handle exhaustively. There is no
 * `eval`, no `new Function`, and no path by which a scene somebody sent you runs code you did not
 * ship.
 *
 * ## Three guards, and why each exists
 *
 * **It refuses to start a graph with errors.** A dangling edge or an undeclared variable is caught
 * once, at `start`, with the node ids in the message — rather than throwing on the frame the player
 * happens to reach it.
 *
 * **Instant cycles are refused before running**, by the schema's own check. A loop with no `wait`
 * in it is a hung tab, and it is the one failure a graph can express that a list of triggers
 * cannot.
 *
 * **A step budget bounds each burst.** Cycle detection covers loops; it does not cover a graph that
 * fans out through nested `sequence` nodes into an exponential number of steps. The budget stops
 * that with a warning naming the event, which is a slow frame and a message rather than a hang.
 */

/**
 * Nodes one event may run before the runtime gives up on it.
 *
 * Generous — a hand-authored graph reaching a hundred steps in one burst is already unusual — and
 * finite, which is the point. Without it, the fan-out of eight nested three-way `sequence` nodes is
 * 6,561 steps in a frame, and nothing in the schema forbids writing that.
 */
export const STEP_BUDGET = 512;

export interface GraphRuntimeOptions {
  graph: SceneGraph;
  world: WorldHandle;
  /** The event bus. `BehaviorRuntime` is one; anything with these two methods will do. */
  bus: {
    emit(event: string, payload?: unknown): void;
    on(event: string, listener: (payload: unknown) => void): () => void;
  };
  warn?: (message: string) => void;
}

/** A `wait` node that has not finished, or a timer that has not fired. */
interface Pending {
  remaining: number;
  /** Where to continue. For a timer this is the timer node itself. */
  nodeId: string;
  /** Timers re-arm; a `wait` does not. */
  repeatSeconds: number | null;
}

export class GraphRuntime {
  readonly #graph: SceneGraph;
  readonly #world: WorldHandle;
  readonly #bus: GraphRuntimeOptions['bus'];
  readonly #warn: (message: string) => void;

  readonly #nodes = new Map<string, GraphNode>();
  /** `nodeId -> port -> target ids`, in document order. */
  readonly #edges = new Map<string, Map<string, string[]>>();

  readonly #variables = new Map<string, number | boolean | string>();
  readonly #unsubscribes: (() => void)[] = [];
  #pending: Pending[] = [];

  readonly problems: readonly GraphProblem[];
  #started = false;

  constructor(options: GraphRuntimeOptions) {
    this.#graph = options.graph;
    this.#world = options.world;
    this.#bus = options.bus;
    this.#warn = options.warn ?? ((message) => console.warn(`[helaengine] ${message}`));

    this.problems = validateGraph(options.graph);
    for (const node of options.graph.nodes) this.#nodes.set(node.id, node);
    for (const edge of options.graph.edges) {
      const ports = this.#edges.get(edge.from) ?? new Map<string, string[]>();
      ports.set(edge.port, [...(ports.get(edge.port) ?? []), edge.to]);
      this.#edges.set(edge.from, ports);
    }
  }

  /** Whether the graph is safe to run. False means `start` will refuse. */
  get runnable(): boolean {
    return graphIsRunnable(this.problems);
  }

  /** The current value of a variable, for tests and the editor's debug readout. */
  variable(name: string): number | boolean | string | undefined {
    return this.#variables.get(name);
  }

  /**
   * Every variable's current value, for carrying into the next level.
   *
   * A plain object rather than the live map: the caller is going to hold this across a teardown,
   * and handing out the map would hand out something `stop` is about to clear.
   */
  variables(): Record<string, number | boolean | string> {
    return Object.fromEntries(this.#variables);
  }

  /**
   * Puts carried variables back, keeping only the ones this graph declares.
   *
   * Called after `start`, which is what makes the filter meaningful: `start` has already written
   * every declared variable's initial value, so anything not in the map here is a name this level
   * never heard of. Accepting it would mean a level that behaves differently depending on which
   * door the player came through.
   */
  restoreVariables(values: Record<string, number | boolean | string>): void {
    if (!this.#started) return;
    for (const [name, value] of Object.entries(values)) {
      // Type checked as well as name: a level that declares `score` as a number should not inherit
      // a `score` that is text because an earlier level spelled it differently.
      const current = this.#variables.get(name);
      if (current !== undefined && typeof current === typeof value) {
        this.#variables.set(name, value);
      }
    }
  }

  start(): void {
    if (this.#started) return;

    for (const problem of this.problems) {
      this.#warn(`graph ${problem.severity}: ${problem.message}`);
    }
    if (!this.runnable) {
      // Refused rather than run partially. A graph with a dangling edge is a graph whose author
      // meant something the runtime cannot guess, and running the reachable half of it produces a
      // level that is subtly wrong rather than visibly broken.
      this.#warn('graph not started: fix the errors above');
      return;
    }

    this.#started = true;
    for (const variable of this.#graph.variables) {
      this.#variables.set(variable.name, variable.initial);
    }

    for (const node of this.#graph.nodes) {
      if (node.type === 'onEvent') {
        this.#unsubscribes.push(this.#bus.on(node.event, () => this.#burst(node.id)));
      }
      if (node.type === 'onTimer') {
        this.#pending.push({
          remaining: node.seconds,
          nodeId: node.id,
          repeatSeconds: node.repeat ? node.seconds : null,
        });
      }
    }

    for (const node of this.#graph.nodes) {
      if (node.type === 'onStart') this.#burst(node.id);
    }
  }

  update(deltaSeconds: number): void {
    if (!this.#started || this.#pending.length === 0) return;

    // Collected before running, because a chain can add pending entries — a `wait` that leads to
    // another `wait` — and mutating the list mid-iteration would run the new one this same frame.
    const due: Pending[] = [];
    const still: Pending[] = [];
    for (const entry of this.#pending) {
      entry.remaining -= deltaSeconds;
      if (entry.remaining <= 0) due.push(entry);
      else still.push(entry);
    }
    this.#pending = still;

    for (const entry of due) {
      if (entry.repeatSeconds !== null) {
        this.#pending.push({ ...entry, remaining: entry.repeatSeconds });
      }
      this.#burst(entry.nodeId);
    }
  }

  stop(): void {
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.length = 0;
    this.#pending = [];
    this.#variables.clear();
    this.#started = false;
  }

  /** One event's worth of execution, bounded. */
  #burst(fromNodeId: string): void {
    const budget = { left: STEP_BUDGET, exhausted: false };
    this.#follow(fromNodeId, 'then', budget);
    if (budget.exhausted) {
      this.#warn(
        `graph: the chain from "${fromNodeId}" ran ${STEP_BUDGET} nodes without finishing and was ` +
          'stopped. Check for a very wide fan-out of sequence nodes.',
      );
    }
  }

  #follow(nodeId: string, port: string, budget: { left: number; exhausted: boolean }): void {
    for (const targetId of this.#edges.get(nodeId)?.get(port) ?? []) {
      this.#step(targetId, budget);
    }
  }

  /**
   * Runs one node and continues from it.
   *
   * The switch is exhaustive over the schema's union, which is the whole safety argument: a node
   * type added to the document format without an arm here fails to compile, so a document can never
   * name something this cannot do.
   */
  #step(nodeId: string, budget: { left: number; exhausted: boolean }): void {
    if (budget.left <= 0) {
      budget.exhausted = true;
      return;
    }
    budget.left -= 1;

    const node = this.#nodes.get(nodeId);
    if (!node) return;

    switch (node.type) {
      // Events are entry points; validation already refuses edges into them, so reaching one is
      // impossible rather than merely unusual.
      case 'onStart':
      case 'onEvent':
      case 'onTimer':
        return;

      case 'branch':
        this.#follow(node.id, this.#test(node.condition) ? 'true' : 'false', budget);
        return;

      case 'wait':
        // The chain stops here for this frame and resumes from `update`. That yield is what makes a
        // loop through this node legal where an instant one is refused.
        this.#pending.push({ remaining: node.seconds, nodeId: node.id, repeatSeconds: null });
        return;

      case 'sequence':
        for (let index = 0; index < node.branches; index += 1) {
          this.#follow(node.id, String(index), budget);
        }
        return;

      case 'setVariable':
        this.#variables.set(node.name, this.#read(node.value));
        break;

      case 'addToVariable': {
        const current = this.#variables.get(node.name);
        const amount = this.#read(node.amount);
        // Numbers only. Adding to a flag or a label is a document that says something the author
        // did not mean, and silently concatenating strings would hide it.
        if (typeof current === 'number' && typeof amount === 'number') {
          this.#variables.set(node.name, current + amount);
        } else {
          this.#warn(
            `graph: node "${node.id}" adds to "${node.name}", which is not a number — ignored`,
          );
        }
        break;
      }

      case 'emit':
        this.#bus.emit(node.event, node.payload);
        break;

      case 'spawn':
        this.#world.spawn({ assetId: node.assetId, position: node.position, behaviors: [] });
        break;

      case 'destroy':
        this.#world.destroy(node.targetId);
        break;

      case 'setHidden':
        this.#world.setObjectHidden(node.targetId, node.hidden);
        break;

      case 'moveObject':
        this.#world.moveTo(node.targetId, new THREE.Vector3(...node.position));
        break;

      case 'setAnimation':
        this.#world.setAnimationState(node.targetId, node.state);
        break;

      case 'damagePlayer':
        this.#world.damagePlayer(node.amount);
        break;

      case 'healPlayer':
        // Negative damage, because there is one place that decides what the player's health may be
        // and a second entry point would be a second set of clamping rules to keep in step.
        this.#world.damagePlayer(-node.amount);
        break;

      case 'teleportPlayer':
        this.#world.teleportPlayer(new THREE.Vector3(...node.position));
        break;

      case 'showMessage':
        // On the bus rather than straight to the HUD, so the same message reaches anything that
        // wants it — the HUD, a subtitle track, a test — and the graph stays independent of the UI.
        this.#bus.emit('hudMessage', { text: node.text, seconds: node.seconds });
        break;

      case 'loadLevel':
        // Requested, not performed. Loading a level needs an asset loader and a render target, and
        // an interpreter that had either would be able to do things a document should not be able
        // to ask for. Nothing follows: `loadLevel` has no outputs, and this level is about to stop
        // existing.
        this.#world.requestLevel(node.levelId, node.carryState);
        return;

      default: {
        /**
         * Makes the switch exhaustive, rather than merely looking it.
         *
         * Without this arm a node type added to the schema compiles fine here and falls through to
         * `#follow`, which finds no edges and does nothing — a new feature that silently does
         * nothing in every existing game, discovered by a player rather than by the compiler. The
         * safety argument for a closed vocabulary is only worth something if both ends are closed.
         */
        const unreachable: never = node;
        void unreachable;
        return;
      }
    }

    this.#follow(node.id, 'then', budget);
  }

  /** A parameter's value: a constant, or a variable's current contents. */
  #read(value: GraphValue): number | boolean | string {
    switch (value.kind) {
      case 'number':
      case 'boolean':
      case 'text':
        return value.value;
      case 'variable':
        // Validation guarantees the variable is declared, so an absent one means `stop` ran between
        // the check and here. Zero is the safe answer; a throw would take the frame down.
        return this.#variables.get(value.name) ?? 0;
    }
  }

  #test(condition: GraphCondition): boolean {
    switch (condition.type) {
      case 'compare': {
        const left = this.#read(condition.left);
        const right = this.#read(condition.right);
        switch (condition.op) {
          case '==':
            return left === right;
          case '!=':
            return left !== right;
          // Ordering only makes sense between numbers. Comparing a label to a number with `<` is a
          // question without an answer, and JavaScript's coercion would invent one.
          case '<':
            return typeof left === 'number' && typeof right === 'number' && left < right;
          case '<=':
            return typeof left === 'number' && typeof right === 'number' && left <= right;
          case '>':
            return typeof left === 'number' && typeof right === 'number' && left > right;
          case '>=':
            return typeof left === 'number' && typeof right === 'number' && left >= right;
        }
        return false;
      }

      case 'flag':
        return (this.#variables.get(condition.name) === true) === condition.expected;

      case 'hasItem':
        return this.#world.itemCount(condition.kind) >= condition.atLeast;

      case 'playerHealthBelow': {
        const health = this.#world.playerHealth();
        return health !== null && health < condition.value;
      }

      case 'and':
        return condition.of.every((inner) => this.#test(inner));
      case 'or':
        return condition.of.some((inner) => this.#test(inner));
      case 'not':
        return !this.#test(condition.of);
    }
  }
}

/** Whether a graph has anything to run. Saves constructing a runtime for the common empty case. */
export function graphHasContent(graph: SceneGraph): boolean {
  return graph.nodes.some((node) => EVENT_NODES.includes(node.type));
}
