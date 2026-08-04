import {
  UnlockActionSchema,
  UnlockKeySchema,
  UnlockMethodSchema,
  type Unlockable,
  type UnlockAction,
  type UnlockKey,
  type UnlockMethod,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/** Plain-English names, so neither picker is a list of identifiers. */
const METHOD_LABELS: Record<UnlockMethod['type'], string> = {
  inputSequence: 'Button sequence',
  triggerVolume: 'Enter a trigger volume',
  event: 'An event happens',
  itemCount: 'Collect a number of pickups',
};

const ACTION_LABELS: Record<UnlockAction['type'], string> = {
  teleportPlayer: 'Teleport the player',
  unlockInventoryItem: 'Grant a weapon',
  revealArea: 'Reveal hidden objects',
  emit: 'Raise an event',
};

const METHOD_TYPES = UnlockMethodSchema.options.map(
  (option) => option.shape.type.value as UnlockMethod['type'],
);
const ACTION_TYPES = UnlockActionSchema.options.map(
  (option) => option.shape.type.value as UnlockAction['type'],
);

/** A default of each type, so switching the picker never produces an invalid document. */
function defaultMethod(type: UnlockMethod['type']): UnlockMethod {
  switch (type) {
    case 'inputSequence':
      return UnlockMethodSchema.parse({ type, sequence: ['Up', 'Up', 'B', 'A'] });
    case 'triggerVolume':
      return UnlockMethodSchema.parse({ type, triggerId: 'obj_0001' });
    case 'event':
      return UnlockMethodSchema.parse({ type, event: 'secretFound' });
    case 'itemCount':
      return UnlockMethodSchema.parse({ type, kind: 'health', count: 3 });
  }
}

function defaultAction(type: UnlockAction['type']): UnlockAction {
  switch (type) {
    case 'teleportPlayer':
      return UnlockActionSchema.parse({ type, target: [0, 0, 0] });
    case 'unlockInventoryItem':
      return UnlockActionSchema.parse({ type, weaponId: 'weapon_0001' });
    case 'revealArea':
      return UnlockActionSchema.parse({ type, objectIds: ['obj_0001'] });
    case 'emit':
      return UnlockActionSchema.parse({ type, event: 'secretFound' });
  }
}

/**
 * The button sequence, edited as a row of chips.
 *
 * A picker rather than a text field: the key vocabulary is closed, and a free-text box is a way to
 * type a secret nobody can ever enter.
 */
function SequenceEditor({
  index,
  sequence,
  onChange,
}: {
  index: number;
  sequence: readonly UnlockKey[];
  onChange(next: UnlockKey[]): void;
}): React.JSX.Element {
  return (
    <div className="secret-sequence">
      <span className="vector-title">Sequence</span>
      <div className="secret-keys">
        {sequence.map((key, at) => (
          <select
            key={`${at}-${key}`}
            aria-label={`Secret ${index + 1} key ${at + 1}`}
            value={key}
            onChange={(event) => {
              const next = [...sequence];
              next[at] = event.target.value as UnlockKey;
              onChange(next);
            }}
          >
            {UnlockKeySchema.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ))}
      </div>
      <div className="ui-button-actions">
        <button
          type="button"
          aria-label={`Add key to secret ${index + 1}`}
          disabled={sequence.length >= 24}
          onClick={() => onChange([...sequence, 'A'])}
        >
          +
        </button>
        <button
          type="button"
          aria-label={`Remove last key from secret ${index + 1}`}
          // Two is the schema's floor: a one-key "sequence" is a keybinding, not a secret.
          disabled={sequence.length <= 2}
          onClick={() => onChange(sequence.slice(0, -1))}
        >
          −
        </button>
      </div>
    </div>
  );
}

function MethodEditor({
  index,
  method,
  onChange,
}: {
  index: number;
  method: UnlockMethod;
  onChange(next: UnlockMethod): void;
}): React.JSX.Element {
  return (
    <>
      <label className="param-row">
        <span>Found by</span>
        <select
          aria-label={`Secret ${index + 1} method`}
          value={method.type}
          onChange={(event) => onChange(defaultMethod(event.target.value as UnlockMethod['type']))}
        >
          {METHOD_TYPES.map((type) => (
            <option key={type} value={type}>
              {METHOD_LABELS[type]}
            </option>
          ))}
        </select>
      </label>

      {method.type === 'inputSequence' && (
        <>
          <SequenceEditor
            index={index}
            sequence={method.sequence}
            onChange={(sequence) => onChange({ ...method, sequence })}
          />
          <div className="param-row">
            <span>Key window</span>
            <NumberField
              label={`Secret ${index + 1} key window`}
              scrubLabel=""
              value={method.withinSeconds}
              step={0.1}
              suffix="s"
              onChange={(value) =>
                onChange({ ...method, withinSeconds: Math.min(30, Math.max(0.2, value)) })
              }
            />
          </div>
        </>
      )}

      {method.type === 'triggerVolume' && (
        <label className="param-row">
          <span>Trigger</span>
          <input
            type="text"
            aria-label={`Secret ${index + 1} trigger id`}
            value={method.triggerId}
            onChange={(event) => onChange({ ...method, triggerId: event.target.value })}
          />
        </label>
      )}

      {method.type === 'event' && (
        <label className="param-row">
          <span>Event</span>
          <input
            type="text"
            aria-label={`Secret ${index + 1} event`}
            value={method.event}
            onChange={(event) => onChange({ ...method, event: event.target.value })}
          />
        </label>
      )}

      {method.type === 'itemCount' && (
        <>
          <label className="param-row">
            <span>Pickup kind</span>
            <select
              aria-label={`Secret ${index + 1} pickup kind`}
              value={method.kind}
              onChange={(event) =>
                onChange({ ...method, kind: event.target.value as typeof method.kind })
              }
            >
              {['weapon', 'ammo', 'health'].map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <div className="param-row">
            <span>How many</span>
            <NumberField
              label={`Secret ${index + 1} count`}
              scrubLabel=""
              value={method.count}
              step={1}
              onChange={(value) =>
                onChange({ ...method, count: Math.round(Math.min(999, Math.max(1, value))) })
              }
            />
          </div>
        </>
      )}
    </>
  );
}

function ActionEditor({
  secretIndex,
  index,
  action,
  onChange,
  onRemove,
  removable,
}: {
  secretIndex: number;
  index: number;
  action: UnlockAction;
  onChange(next: UnlockAction): void;
  onRemove(): void;
  removable: boolean;
}): React.JSX.Element {
  const name = `Secret ${secretIndex + 1} action ${index + 1}`;

  return (
    <div className="action-card">
      <div className="behavior-head">
        <select
          aria-label={`${name} type`}
          value={action.type}
          onChange={(event) => onChange(defaultAction(event.target.value as UnlockAction['type']))}
        >
          {ACTION_TYPES.map((type) => (
            <option key={type} value={type}>
              {ACTION_LABELS[type]}
            </option>
          ))}
        </select>
        <div className="ui-button-actions">
          <button
            type="button"
            aria-label={`Remove ${name}`}
            disabled={!removable}
            onClick={onRemove}
          >
            ×
          </button>
        </div>
      </div>

      {action.type === 'teleportPlayer' && (
        <div className="vector-row" role="group" aria-label={`${name} target`}>
          <span className="vector-title">Target</span>
          <div className="vector-fields">
            {(['X', 'Y', 'Z'] as const).map((axis, at) => (
              <NumberField
                key={axis}
                label={`${name} target ${axis}`}
                scrubLabel={axis}
                value={action.target[at]!}
                step={0.5}
                onChange={(value) => {
                  const next: [number, number, number] = [...action.target];
                  next[at] = value;
                  onChange({ ...action, target: next });
                }}
              />
            ))}
          </div>
        </div>
      )}

      {action.type === 'unlockInventoryItem' && (
        <label className="param-row">
          <span>Weapon</span>
          <input
            type="text"
            aria-label={`${name} weapon id`}
            value={action.weaponId}
            onChange={(event) => onChange({ ...action, weaponId: event.target.value })}
          />
        </label>
      )}

      {action.type === 'revealArea' && (
        <label className="param-row">
          <span>Objects</span>
          <input
            type="text"
            aria-label={`${name} object ids`}
            value={action.objectIds.join(', ')}
            onChange={(event) =>
              onChange({
                ...action,
                objectIds: event.target.value
                  .split(',')
                  .map((id) => id.trim())
                  .filter((id) => id.length > 0),
              })
            }
          />
        </label>
      )}

      {action.type === 'emit' && (
        <label className="param-row">
          <span>Event</span>
          <input
            type="text"
            aria-label={`${name} event`}
            value={action.event}
            onChange={(event) => onChange({ ...action, event: event.target.value })}
          />
        </label>
      )}
    </div>
  );
}

function SecretCard({
  unlockable,
  index,
}: {
  unlockable: Unlockable;
  index: number;
}): React.JSX.Element {
  const setUnlockable = useSceneStore((state) => state.setUnlockable);
  const removeUnlockable = useSceneStore((state) => state.removeUnlockable);

  const setActions = (actions: UnlockAction[]): void => setUnlockable(unlockable.id, { actions });

  return (
    <div className="trigger-list">
      <div className="behavior-head">
        <input
          type="text"
          aria-label={`Secret ${index + 1} label`}
          value={unlockable.label}
          onChange={(event) => setUnlockable(unlockable.id, { label: event.target.value })}
        />
        <div className="ui-button-actions">
          <button
            type="button"
            aria-label={`Remove secret ${index + 1}`}
            onClick={() => removeUnlockable(unlockable.id)}
          >
            ×
          </button>
        </div>
      </div>

      <MethodEditor
        index={index}
        method={unlockable.unlockMethod}
        onChange={(unlockMethod) => setUnlockable(unlockable.id, { unlockMethod })}
      />

      <label className="param-check">
        <input
          type="checkbox"
          checked={unlockable.once}
          onChange={(event) => setUnlockable(unlockable.id, { once: event.target.checked })}
        />
        Only once
      </label>

      <h3>Then</h3>
      {unlockable.actions.map((action, at) => (
        <ActionEditor
          key={`${at}-${action.type}`}
          secretIndex={index}
          index={at}
          action={action}
          removable={unlockable.actions.length > 1}
          onChange={(next) =>
            setActions(unlockable.actions.map((entry, i) => (i === at ? next : entry)))
          }
          onRemove={() => setActions(unlockable.actions.filter((_unused, i) => i !== at))}
        />
      ))}

      <button
        type="button"
        className="ui-add"
        aria-label={`Add action to secret ${index + 1}`}
        disabled={unlockable.actions.length >= 8}
        onClick={() => setActions([...unlockable.actions, defaultAction('emit')])}
      >
        Add action
      </button>
    </div>
  );
}

/**
 * Secrets, editable without touching JSON.
 *
 * Both pickers are built from the schema's discriminated unions rather than from a hand-kept list,
 * so a method or action added to the vocabulary appears here — and one that is *not* in the
 * vocabulary cannot be typed in at all. That is the same closed-set guarantee the runtime relies on,
 * enforced at the one place a user could otherwise widen it.
 */
export function SecretsPanel(): React.JSX.Element {
  const unlockables = useSceneStore((state) => state.scene.unlockables);
  const addUnlockable = useSceneStore((state) => state.addUnlockable);

  return (
    <section className="panel" aria-label="Secrets">
      <h2>Secrets</h2>

      {unlockables.length === 0 && (
        <p className="panel-hint">
          No secrets. Add one to hide an area, grant a weapon or teleport the player.
        </p>
      )}

      {unlockables.map((unlockable, index) => (
        <SecretCard key={unlockable.id} unlockable={unlockable} index={index} />
      ))}

      <button
        type="button"
        className="ui-add"
        aria-label="Add secret"
        onClick={() => addUnlockable()}
      >
        Add secret
      </button>
    </section>
  );
}
