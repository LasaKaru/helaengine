import { behaviorRegistry, type BehaviorRegistry } from './BehaviorRegistry.js';
import { chaseOnSightDefinition } from '../ai/ChaseOnSightBehavior.js';
import { patrolDefinition } from './PatrolBehavior.js';
import { pickupDefinition } from './PickupBehavior.js';
import { checkpointDefinition } from './CheckpointBehavior.js';

/**
 * Registers the behaviours the engine ships with.
 *
 * Called explicitly rather than at import time so that the exporter can register only the
 * behaviours a given scene actually uses (Sprint 22), and so tests can build a registry with
 * exactly the types they mean to exercise.
 */
export function registerBuiltinBehaviors(registry: BehaviorRegistry = behaviorRegistry): void {
  for (const definition of [
    patrolDefinition,
    chaseOnSightDefinition,
    pickupDefinition,
    checkpointDefinition,
  ]) {
    if (!registry.has(definition.type)) registry.register(definition);
  }
}
