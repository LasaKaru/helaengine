import {
  ANIMATION_STATES,
  COMPARISONS,
  MAX_CONDITION_DEPTH,
  type GraphCondition,
  type GraphNode,
  type GraphValue,
  type GraphVariable,
  type Vec3,
} from '@helaengine/schema';
import { NumberField } from './NumberField';

/**
 * The fields of whichever node is selected.
 *
 * One `switch` over the union, the same shape as `TriggerPanel`'s action editor and for the same
 * reason: the vocabulary is closed and small, so a schema-driven form generator would be
 * indirection standing between the author and eighteen short forms. The compiler checks the switch
 * is complete, which is the only guarantee a generator would have bought.
 */

const PICKUP_KINDS = ['weapon', 'ammo', 'health'] as const;

export interface FieldContext {
  variables: readonly GraphVariable[];
  objectIds: readonly string[];
  assets: ReadonlyArray<{ id: string; name: string }>;
}

/** A dropdown of declared variables. Free text would let a typo become a validation error later. */
function VariablePicker({
  label,
  value,
  variables,
  onChange,
}: {
  label: string;
  value: string;
  variables: readonly GraphVariable[];
  onChange(name: string): void;
}): React.JSX.Element {
  return (
    <label className="param-row">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Pick a variable…</option>
        {variables.map((variable) => (
          <option key={variable.name} value={variable.name}>
            {variable.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function ObjectPicker({
  label,
  value,
  objectIds,
  onChange,
}: {
  label: string;
  value: string;
  objectIds: readonly string[];
  onChange(id: string): void;
}): React.JSX.Element {
  return (
    <label className="param-row">
      <span>{label}</span>
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Pick an object…</option>
        {objectIds.map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
    </label>
  );
}

function VectorFields({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Vec3;
  onChange(next: Vec3): void;
}): React.JSX.Element {
  return (
    <div className="vector-row" role="group" aria-label={label}>
      <span className="vector-title">{label}</span>
      <div className="vector-fields">
        {(['X', 'Y', 'Z'] as const).map((axis, at) => (
          <NumberField
            key={axis}
            label={`${label} ${axis}`}
            scrubLabel={axis}
            value={value[at] ?? 0}
            step={0.5}
            onChange={(next) => {
              const position: Vec3 = [...value];
              position[at] = next;
              onChange(position);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * A constant or a variable read.
 *
 * The kind picker comes first because it changes what the second control is. Switching kind
 * replaces the whole value rather than patching it — the union has no common field to carry over,
 * and inventing one would mean a `number` node quietly holding a leftover string.
 */
export function ValueEditor({
  label,
  value,
  variables,
  onChange,
}: {
  label: string;
  value: GraphValue;
  variables: readonly GraphVariable[];
  onChange(next: GraphValue): void;
}): React.JSX.Element {
  return (
    <div className="graph-value">
      <label className="param-row">
        <span>{label}</span>
        <select
          aria-label={`${label} kind`}
          value={value.kind}
          onChange={(event) => {
            const kind = event.target.value as GraphValue['kind'];
            if (kind === 'number') onChange({ kind, value: 0 });
            else if (kind === 'boolean') onChange({ kind, value: true });
            else if (kind === 'text') onChange({ kind, value: '' });
            else onChange({ kind: 'variable', name: variables[0]?.name ?? '' });
          }}
        >
          <option value="number">Number</option>
          <option value="boolean">True / false</option>
          <option value="text">Text</option>
          <option value="variable">Variable</option>
        </select>
      </label>

      {value.kind === 'number' && (
        <NumberField
          label={`${label} number`}
          value={value.value}
          step={1}
          onChange={(next) => onChange({ kind: 'number', value: next })}
        />
      )}

      {value.kind === 'boolean' && (
        <label className="param-check">
          <input
            type="checkbox"
            aria-label={`${label} true`}
            checked={value.value}
            onChange={(event) => onChange({ kind: 'boolean', value: event.target.checked })}
          />
          True
        </label>
      )}

      {value.kind === 'text' && (
        <label className="param-row">
          <span className="visually-hidden">{label} text</span>
          <input
            type="text"
            aria-label={`${label} text`}
            value={value.value}
            onChange={(event) => onChange({ kind: 'text', value: event.target.value })}
          />
        </label>
      )}

      {value.kind === 'variable' && (
        <VariablePicker
          label={`${label} variable`}
          value={value.name}
          variables={variables}
          onChange={(name) => onChange({ kind: 'variable', name })}
        />
      )}
    </div>
  );
}

/**
 * A condition tree, edited in place.
 *
 * Recursive, because the data is. `depth` is not a styling nicety — it stops the editor offering an
 * `and` at the schema's nesting limit, so the author cannot build a condition the document format
 * would then refuse to save.
 */
export function ConditionEditor({
  label,
  condition,
  variables,
  depth = 0,
  onChange,
}: {
  label: string;
  condition: GraphCondition;
  variables: readonly GraphVariable[];
  depth?: number;
  onChange(next: GraphCondition): void;
}): React.JSX.Element {
  const canNest = depth < MAX_CONDITION_DEPTH - 1;

  const changeType = (type: GraphCondition['type']): void => {
    switch (type) {
      case 'compare':
        return onChange({
          type,
          left: { kind: 'number', value: 0 },
          op: '==',
          right: { kind: 'number', value: 0 },
        });
      case 'flag':
        return onChange({ type, name: variables[0]?.name ?? '', expected: true });
      case 'hasItem':
        return onChange({ type, kind: 'health', atLeast: 1 });
      case 'playerHealthBelow':
        return onChange({ type, value: 50 });
      case 'and':
      case 'or':
        return onChange({ type, of: [{ type: 'playerHealthBelow', value: 50 }] });
      case 'not':
        return onChange({ type, of: { type: 'playerHealthBelow', value: 50 } });
    }
  };

  return (
    <div className="graph-condition">
      <label className="param-row">
        <span>{label}</span>
        <select
          aria-label={`${label} type`}
          value={condition.type}
          onChange={(event) => changeType(event.target.value as GraphCondition['type'])}
        >
          <option value="playerHealthBelow">Player health below</option>
          <option value="flag">Flag is set</option>
          <option value="hasItem">Player has item</option>
          <option value="compare">Compare</option>
          {canNest && <option value="and">All of…</option>}
          {canNest && <option value="or">Any of…</option>}
          {canNest && <option value="not">Not…</option>}
        </select>
      </label>

      {condition.type === 'playerHealthBelow' && (
        <NumberField
          label={`${label} health`}
          value={condition.value}
          step={5}
          onChange={(value) => onChange({ ...condition, value })}
        />
      )}

      {condition.type === 'flag' && (
        <>
          <VariablePicker
            label={`${label} flag`}
            value={condition.name}
            variables={variables}
            onChange={(name) => onChange({ ...condition, name })}
          />
          <label className="param-check">
            <input
              type="checkbox"
              aria-label={`${label} expected`}
              checked={condition.expected}
              onChange={(event) => onChange({ ...condition, expected: event.target.checked })}
            />
            Is true
          </label>
        </>
      )}

      {condition.type === 'hasItem' && (
        <>
          <label className="param-row">
            <span>Item</span>
            <select
              aria-label={`${label} item`}
              value={condition.kind}
              onChange={(event) =>
                onChange({
                  ...condition,
                  kind: event.target.value as (typeof PICKUP_KINDS)[number],
                })
              }
            >
              {PICKUP_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </label>
          <NumberField
            label={`${label} at least`}
            value={condition.atLeast}
            step={1}
            onChange={(atLeast) => onChange({ ...condition, atLeast: Math.max(1, atLeast) })}
          />
        </>
      )}

      {condition.type === 'compare' && (
        <>
          <ValueEditor
            label={`${label} left`}
            value={condition.left}
            variables={variables}
            onChange={(left) => onChange({ ...condition, left })}
          />
          <label className="param-row">
            <span>Operator</span>
            <select
              aria-label={`${label} operator`}
              value={condition.op}
              onChange={(event) =>
                onChange({ ...condition, op: event.target.value as (typeof COMPARISONS)[number] })
              }
            >
              {COMPARISONS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </select>
          </label>
          <ValueEditor
            label={`${label} right`}
            value={condition.right}
            variables={variables}
            onChange={(right) => onChange({ ...condition, right })}
          />
        </>
      )}

      {(condition.type === 'and' || condition.type === 'or') && (
        <div className="graph-condition-children">
          {condition.of.map((inner, index) => (
            <div className="graph-condition-child" key={index}>
              <ConditionEditor
                label={`${label} ${index + 1}`}
                condition={inner}
                variables={variables}
                depth={depth + 1}
                onChange={(next) =>
                  onChange({
                    ...condition,
                    of: condition.of.map((current, at) => (at === index ? next : current)),
                  })
                }
              />
              {condition.of.length > 1 && (
                <button
                  type="button"
                  aria-label={`Remove ${label} ${index + 1}`}
                  onClick={() =>
                    onChange({ ...condition, of: condition.of.filter((_x, at) => at !== index) })
                  }
                >
                  Remove
                </button>
              )}
            </div>
          ))}
          {condition.of.length < 8 && (
            <button
              type="button"
              onClick={() =>
                onChange({
                  ...condition,
                  of: [...condition.of, { type: 'playerHealthBelow', value: 50 }],
                })
              }
            >
              Add condition
            </button>
          )}
        </div>
      )}

      {condition.type === 'not' && (
        <div className="graph-condition-children">
          <ConditionEditor
            label={`${label} inner`}
            condition={condition.of}
            variables={variables}
            depth={depth + 1}
            onChange={(of) => onChange({ type: 'not', of })}
          />
        </div>
      )}
    </div>
  );
}

export function GraphNodeFields({
  node,
  context,
  onChange,
}: {
  node: GraphNode;
  context: FieldContext;
  onChange(next: GraphNode): void;
}): React.JSX.Element | null {
  const { variables, objectIds, assets } = context;

  switch (node.type) {
    case 'onStart':
      return <p className="panel-hint">Runs once, when the level loads.</p>;

    case 'onEvent':
    case 'emit':
      return (
        <label className="param-row">
          <span>Event</span>
          <input
            type="text"
            aria-label="Event"
            spellCheck={false}
            value={node.event}
            onChange={(event) => onChange({ ...node, event: event.target.value })}
          />
        </label>
      );

    case 'onTimer':
      return (
        <>
          <NumberField
            label="Seconds"
            value={node.seconds}
            step={0.5}
            onChange={(seconds) => onChange({ ...node, seconds: Math.max(0.05, seconds) })}
          />
          <label className="param-check">
            <input
              type="checkbox"
              aria-label="Repeat"
              checked={node.repeat}
              onChange={(event) => onChange({ ...node, repeat: event.target.checked })}
            />
            Repeat
          </label>
        </>
      );

    case 'wait':
      return (
        <NumberField
          label="Seconds"
          value={node.seconds}
          step={0.25}
          onChange={(seconds) => onChange({ ...node, seconds: Math.max(0.01, seconds) })}
        />
      );

    case 'sequence':
      return (
        <NumberField
          label="Branches"
          value={node.branches}
          step={1}
          onChange={(branches) =>
            onChange({ ...node, branches: Math.min(8, Math.max(2, Math.round(branches))) })
          }
        />
      );

    case 'branch':
      return (
        <ConditionEditor
          label="Condition"
          condition={node.condition}
          variables={variables}
          onChange={(condition) => onChange({ ...node, condition })}
        />
      );

    case 'setVariable':
      return (
        <>
          <VariablePicker
            label="Variable"
            value={node.name}
            variables={variables}
            onChange={(name) => onChange({ ...node, name })}
          />
          <ValueEditor
            label="Value"
            value={node.value}
            variables={variables}
            onChange={(value) => onChange({ ...node, value })}
          />
        </>
      );

    case 'addToVariable':
      return (
        <>
          <VariablePicker
            label="Variable"
            value={node.name}
            variables={variables}
            onChange={(name) => onChange({ ...node, name })}
          />
          <ValueEditor
            label="Amount"
            value={node.amount}
            variables={variables}
            onChange={(amount) => onChange({ ...node, amount })}
          />
        </>
      );

    case 'spawn':
      return (
        <>
          <label className="param-row">
            <span>Asset</span>
            <select
              aria-label="Asset"
              value={node.assetId}
              onChange={(event) => onChange({ ...node, assetId: event.target.value })}
            >
              <option value="">Pick an asset…</option>
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
            </select>
          </label>
          <VectorFields
            label="Position"
            value={node.position}
            onChange={(position) => onChange({ ...node, position })}
          />
        </>
      );

    case 'destroy':
      return (
        <ObjectPicker
          label="Target"
          value={node.targetId}
          objectIds={objectIds}
          onChange={(targetId) => onChange({ ...node, targetId })}
        />
      );

    case 'setHidden':
      return (
        <>
          <ObjectPicker
            label="Target"
            value={node.targetId}
            objectIds={objectIds}
            onChange={(targetId) => onChange({ ...node, targetId })}
          />
          <label className="param-check">
            <input
              type="checkbox"
              aria-label="Hidden"
              checked={node.hidden}
              onChange={(event) => onChange({ ...node, hidden: event.target.checked })}
            />
            Hide it
          </label>
        </>
      );

    case 'moveObject':
      return (
        <>
          <ObjectPicker
            label="Target"
            value={node.targetId}
            objectIds={objectIds}
            onChange={(targetId) => onChange({ ...node, targetId })}
          />
          <VectorFields
            label="Position"
            value={node.position}
            onChange={(position) => onChange({ ...node, position })}
          />
        </>
      );

    case 'setAnimation':
      return (
        <>
          <ObjectPicker
            label="Target"
            value={node.targetId}
            objectIds={objectIds}
            onChange={(targetId) => onChange({ ...node, targetId })}
          />
          <label className="param-row">
            <span>State</span>
            <select
              aria-label="State"
              value={node.state}
              onChange={(event) =>
                onChange({
                  ...node,
                  state: event.target.value as (typeof ANIMATION_STATES)[number],
                })
              }
            >
              {ANIMATION_STATES.map((state) => (
                <option key={state} value={state}>
                  {state}
                </option>
              ))}
            </select>
          </label>
        </>
      );

    case 'damagePlayer':
    case 'healPlayer':
      return (
        <NumberField
          label="Amount"
          value={node.amount}
          step={5}
          onChange={(amount) => onChange({ ...node, amount: Math.max(0, amount) })}
        />
      );

    case 'teleportPlayer':
      return (
        <VectorFields
          label="Position"
          value={node.position}
          onChange={(position) => onChange({ ...node, position })}
        />
      );

    case 'showMessage':
      return (
        <>
          <label className="param-row">
            <span>Text</span>
            <input
              type="text"
              aria-label="Text"
              value={node.text}
              onChange={(event) => onChange({ ...node, text: event.target.value })}
            />
          </label>
          <NumberField
            label="Seconds"
            value={node.seconds}
            step={0.5}
            onChange={(seconds) =>
              onChange({ ...node, seconds: Math.min(30, Math.max(0.5, seconds)) })
            }
          />
        </>
      );
  }
}
