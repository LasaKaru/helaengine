/**
 * A state in a finite state machine, over whatever context the owner cares about.
 *
 * Every hook is optional. `update` returns the id of the state to move to, or nothing to stay put
 * — which keeps a transition next to the condition that causes it, rather than in a separate
 * table that drifts out of step with the states themselves.
 */
export interface State<TContext> {
  onEnter?(context: TContext): void;
  onUpdate?(context: TContext, deltaSeconds: number): string | void;
  onExit?(context: TContext): void;
}

/**
 * A small finite state machine.
 *
 * Yuka ships one, and the sprint plan allows either it or a lightweight custom one. This is the
 * custom one, because Yuka's is generic over `GameEntity` — its states receive the entity that
 * owns the machine, while ours need the whole enemy context (params, world handle, target, the
 * steering agent). Adapting to that would mean smuggling the context onto a vehicle field and
 * losing the types on the way through. Forty lines here keeps both.
 *
 * Yuka is still doing the work it is good at: the steering in `SteeringAgent`.
 */
export class StateMachine<TContext> {
  readonly #states = new Map<string, State<TContext>>();
  readonly #context: TContext;
  #current: string | null = null;
  /** Ids visited in order, capped — enough to explain "why is it attacking" without leaking. */
  readonly #history: string[] = [];

  constructor(context: TContext) {
    this.#context = context;
  }

  add(id: string, state: State<TContext>): this {
    if (this.#states.has(id)) throw new Error(`state "${id}" is already registered`);
    this.#states.set(id, state);
    return this;
  }

  get current(): string | null {
    return this.#current;
  }

  /** The states entered so far, oldest first. Used by tests and the debug readout. */
  get history(): readonly string[] {
    return this.#history;
  }

  has(id: string): boolean {
    return this.#states.has(id);
  }

  /** Enters a state, running the previous state's exit hook first. A no-op if already there. */
  changeTo(id: string): void {
    if (this.#current === id) return;

    const next = this.#states.get(id);
    if (!next) throw new Error(`unknown state "${id}"`);

    if (this.#current) this.#states.get(this.#current)?.onExit?.(this.#context);
    this.#current = id;
    this.#history.push(id);
    if (this.#history.length > 32) this.#history.shift();
    next.onEnter?.(this.#context);
  }

  /**
   * Advances the current state, following transitions until one settles.
   *
   * Chained transitions are followed within a single update — entering `chase` and immediately
   * finding the target dead should reach `idle` this frame, not next frame. The step budget is
   * what stops a pair of states that each point at the other from hanging the loop.
   */
  update(deltaSeconds: number): void {
    for (let step = 0; step < 8; step += 1) {
      if (!this.#current) return;
      const next = this.#states.get(this.#current)?.onUpdate?.(this.#context, deltaSeconds);
      if (typeof next !== 'string' || next === this.#current) return;
      this.changeTo(next);
    }
  }

  /** Runs the current state's exit hook and leaves the machine stopped. */
  stop(): void {
    if (!this.#current) return;
    this.#states.get(this.#current)?.onExit?.(this.#context);
    this.#current = null;
  }
}
