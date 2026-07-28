import type { Behavior, BehaviorDefinition } from './Behavior.js';

export class UnknownBehaviorError extends Error {
  constructor(readonly behaviorType: string) {
    super(`No behaviour is registered for type "${behaviorType}"`);
    this.name = 'UnknownBehaviorError';
  }
}

export class InvalidBehaviorParamsError extends Error {
  constructor(
    readonly behaviorType: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(`Invalid params for behaviour "${behaviorType}": ${message}`, options);
    this.name = 'InvalidBehaviorParamsError';
  }
}

/**
 * The closed vocabulary of behaviours.
 *
 * A scene document names a behaviour type; this is the only place that name turns into running
 * code, and only for types registered ahead of time. There is no path from document data to an
 * arbitrary function — which is what makes an exported project safe to hand to someone else.
 */
export class BehaviorRegistry {
  readonly #definitions = new Map<string, BehaviorDefinition>();

  register(definition: BehaviorDefinition): this {
    if (this.#definitions.has(definition.type)) {
      throw new Error(`Behaviour type "${definition.type}" is already registered`);
    }
    this.#definitions.set(definition.type, definition);
    return this;
  }

  has(type: string): boolean {
    return this.#definitions.has(type);
  }

  get(type: string): BehaviorDefinition | undefined {
    return this.#definitions.get(type);
  }

  list(): BehaviorDefinition[] {
    return [...this.#definitions.values()];
  }

  /** Validates params against the type's schema and returns a fresh instance. */
  create(type: string, params: unknown): Behavior {
    const definition = this.#definitions.get(type);
    if (!definition) throw new UnknownBehaviorError(type);

    const result = definition.params.safeParse(params);
    if (!result.success) {
      throw new InvalidBehaviorParamsError(type, result.error.issues[0]?.message ?? 'invalid', {
        cause: result.error,
      });
    }

    return definition.create(result.data);
  }

  /** Fills in defaults for a type, for the editor's "add behaviour" action. */
  defaultParams(type: string): unknown {
    const definition = this.#definitions.get(type);
    if (!definition) throw new UnknownBehaviorError(type);

    const result = definition.params.safeParse({});
    if (!result.success) {
      throw new InvalidBehaviorParamsError(
        type,
        'its schema has required fields with no default, so it cannot be added without values',
        { cause: result.error },
      );
    }
    return result.data;
  }
}

/** The registry the engine ships with. Exported projects use this same instance. */
export const behaviorRegistry = new BehaviorRegistry();
