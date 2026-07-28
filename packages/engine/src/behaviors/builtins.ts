import { behaviorRegistry, type BehaviorRegistry } from './BehaviorRegistry.js';
import { patrolDefinition } from './PatrolBehavior.js';

/**
 * Registers the behaviours the engine ships with.
 *
 * Called explicitly rather than at import time so that the exporter can register only the
 * behaviours a given scene actually uses (Sprint 14), and so tests can build a registry with
 * exactly the types they mean to exercise.
 */
export function registerBuiltinBehaviors(registry: BehaviorRegistry = behaviorRegistry): void {
  if (!registry.has(patrolDefinition.type)) registry.register(patrolDefinition);
}
