import { useMemo, useState } from 'react';
import { behaviorRegistry } from '@helaengine/engine';
import type { BehaviorEntry, SceneObject, Vec3 } from '@helaengine/schema';
import { describeParams, type FieldDescriptor } from '../zodForm';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

interface FieldProps {
  field: FieldDescriptor;
  value: unknown;
  onChange(value: unknown): void;
  waypointsKey?: string;
}

function clamp(value: number, field: FieldDescriptor): number {
  const lower = field.min ?? Number.NEGATIVE_INFINITY;
  const upper = field.max ?? Number.POSITIVE_INFINITY;
  return Math.min(upper, Math.max(lower, value));
}

/** Renders one field from its descriptor. Nothing here knows what behaviour it belongs to. */
function ParamField({ field, value, onChange, waypointsKey }: FieldProps): React.JSX.Element {
  const editingWaypoints = useEditorStore((state) => state.editingWaypoints);
  const setEditingWaypoints = useEditorStore((state) => state.setEditingWaypoints);

  if (field.kind === 'boolean') {
    return (
      <label className="param-check">
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => onChange(event.target.checked)}
        />
        {field.label}
      </label>
    );
  }

  if (field.kind === 'enum') {
    return (
      <label className="param-row">
        <span>{field.label}</span>
        <select
          aria-label={field.label}
          value={String(value)}
          onChange={(event) => onChange(event.target.value)}
        >
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (field.kind === 'number') {
    return (
      <div className="param-row">
        <span>{field.label}</span>
        <NumberField
          label={field.label}
          scrubLabel=""
          value={typeof value === 'number' ? value : 0}
          step={0.1}
          onChange={(next) => onChange(clamp(next, field))}
        />
      </div>
    );
  }

  if (field.kind === 'string') {
    return (
      <label className="param-row">
        <span>{field.label}</span>
        <input
          type="text"
          aria-label={field.label}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
    );
  }

  if (field.kind === 'vec3list') {
    const points = Array.isArray(value) ? (value as Vec3[]) : [];
    const editing = waypointsKey !== undefined && editingWaypoints === waypointsKey;

    return (
      <div className="param-waypoints">
        <div className="param-row">
          <span>
            {field.label} ({points.length})
          </span>
          <button
            type="button"
            className={editing ? 'active' : ''}
            aria-pressed={editing}
            onClick={() => setEditingWaypoints(editing ? null : (waypointsKey ?? null))}
          >
            {editing ? 'Done' : 'Add in viewport'}
          </button>
        </div>

        {editing && (
          <p className="panel-hint">Click the ground to add a point. Click Done when finished.</p>
        )}

        {points.length > 0 && (
          <ul className="waypoint-list">
            {points.map((point, index) => (
              <li key={`${index}-${point.join(',')}`}>
                <span>
                  {point[0].toFixed(1)}, {point[2].toFixed(1)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove waypoint ${index + 1}`}
                  onClick={() => onChange(points.filter((_unused, at) => at !== index))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // vec3 — a single point, three numbers.
  const vector = Array.isArray(value) ? (value as Vec3) : ([0, 0, 0] as Vec3);
  return (
    <div className="vector-row" role="group" aria-label={field.label}>
      <span className="vector-title">{field.label}</span>
      <div className="vector-fields">
        {(['X', 'Y', 'Z'] as const).map((axis, index) => (
          <NumberField
            key={axis}
            label={`${field.label} ${axis}`}
            scrubLabel={axis}
            value={vector[index] ?? 0}
            step={0.1}
            onChange={(next) => {
              const updated: Vec3 = [...vector];
              updated[index] = next;
              onChange(updated);
            }}
          />
        ))}
      </div>
    </div>
  );
}

interface AttachedProps {
  objectId: string;
  index: number;
  entry: BehaviorEntry;
}

function AttachedBehavior({ objectId, index, entry }: AttachedProps): React.JSX.Element {
  const setBehaviorParams = useSceneStore((state) => state.setBehaviorParams);
  const removeBehavior = useSceneStore((state) => state.removeBehavior);

  const definition = behaviorRegistry.get(entry.type);
  const fields = useMemo(() => (definition ? describeParams(definition.params) : []), [definition]);

  if (!definition) {
    // A document may name a behaviour this build does not have — an older editor, a newer file.
    // Saying so beats dropping it silently, and the entry survives a round-trip untouched.
    return (
      <div className="behavior-card unknown">
        <div className="behavior-head">
          <span className="behavior-name">{entry.type}</span>
          <button type="button" onClick={() => removeBehavior(objectId, index)}>
            Remove
          </button>
        </div>
        <p className="panel-hint">
          This build has no behaviour of that type. Its settings are kept.
        </p>
      </div>
    );
  }

  return (
    <div className="behavior-card">
      <div className="behavior-head">
        <span className="behavior-name">{definition.label}</span>
        <button
          type="button"
          aria-label={`Remove ${definition.label}`}
          onClick={() => removeBehavior(objectId, index)}
        >
          Remove
        </button>
      </div>

      {fields.map((field) => (
        <ParamField
          key={field.key}
          field={field}
          value={entry.params[field.key] ?? field.defaultValue}
          waypointsKey={`${objectId}:${index}`}
          onChange={(next) =>
            setBehaviorParams(objectId, index, { ...entry.params, [field.key]: next })
          }
        />
      ))}
    </div>
  );
}

/**
 * The behaviours attached to the selected object.
 *
 * Every control here is generated from the behaviour's own Zod schema. Adding a behaviour to the
 * engine gives it a UI for free, which is the point: a per-type form would mean the vocabulary
 * grows twice as slowly and the two halves drift.
 */
export function BehaviorPanel({ object }: { object: SceneObject }): React.JSX.Element {
  const addBehavior = useSceneStore((state) => state.addBehavior);
  const [adding, setAdding] = useState('');

  const available = useMemo(() => behaviorRegistry.list(), []);

  return (
    <section className="panel" aria-label="Behaviours">
      <h2>Behaviours</h2>

      {object.behaviors.length === 0 && (
        <p className="panel-hint">
          None attached. Pick one below to give this object something to do.
        </p>
      )}

      {object.behaviors.map((entry, index) => (
        <AttachedBehavior
          key={`${entry.type}-${index}`}
          objectId={object.id}
          index={index}
          entry={entry}
        />
      ))}

      <label className="param-row add-behavior">
        <span className="visually-hidden">Add behaviour</span>
        <select
          aria-label="Add behaviour"
          value={adding}
          onChange={(event) => {
            const type = event.target.value;
            if (!type) return;
            addBehavior(
              object.id,
              type,
              behaviorRegistry.defaultParams(type) as Record<string, unknown>,
            );
            setAdding('');
          }}
        >
          <option value="">Add behaviour…</option>
          {available.map((definition) => (
            <option key={definition.type} value={definition.type}>
              {definition.label}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
