import { isBuiltinTriggerAsset } from '@helaengine/engine';
import { TriggerSchema, type Trigger, type TriggerAction } from '@helaengine/schema';

/** The trigger a freshly placed volume starts with: the right shape, and no wiring yet. */
export function triggerDefaults(assetId: string): Trigger {
  return TriggerSchema.parse({
    shape: assetId === 'logic_trigger_sphere' ? 'sphere' : 'box',
  });
}

export { isBuiltinTriggerAsset };

/**
 * A new action of the given kind, with its required fields filled in.
 *
 * Actions are a discriminated union, so "add an action" has to pick a variant before the inspector
 * has anything to render. Keeping the starting values here means the panel never has to construct
 * a half-built action that would fail its own schema.
 */
export function newAction(type: TriggerAction['type'], assetId?: string): TriggerAction {
  if (type === 'emit') return { type: 'emit', event: 'doorOpened', payload: {} };
  if (type === 'destroy') return { type: 'destroy', targetId: '' };
  return {
    type: 'spawn',
    assetId: assetId ?? 'enemy_goblin_01',
    offset: [0, 0, 0],
    behaviors: [],
    physics: { body: 'kinematic', collider: 'auto' },
  };
}

/** Human-readable one-liner for an action, for the collapsed row in the inspector. */
export function describeAction(action: TriggerAction): string {
  if (action.type === 'emit') return `Emit "${action.event}"`;
  if (action.type === 'destroy') return `Destroy ${action.targetId || '—'}`;
  return `Spawn ${action.assetId}`;
}
