import { useMemo } from 'react';
import type { AssetManifest, SceneObject, Trigger, TriggerAction } from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { describeAction, newAction } from '../triggers';
import { NumberField } from './NumberField';

type ActionList = 'onEnter' | 'onExit';

interface ActionEditorProps {
  action: TriggerAction;
  index: number;
  label: string;
  assets: AssetManifest['assets'];
  objectIds: string[];
  onChange(action: TriggerAction): void;
  onRemove(): void;
}

/**
 * One action's fields.
 *
 * The action is a discriminated union, so this switches on the tag rather than rendering a
 * lowest-common-denominator form. There are only three kinds and there are only ever going to be a
 * handful — that is the point of a closed vocabulary — so a `switch` here is honest where a
 * schema-driven form would be indirection for its own sake.
 */
function ActionEditor({
  action,
  index,
  label,
  assets,
  objectIds,
  onChange,
  onRemove,
}: ActionEditorProps): React.JSX.Element {
  return (
    <div className="action-card">
      <div className="behavior-head">
        <span className="behavior-name">{describeAction(action)}</span>
        <button type="button" aria-label={`Remove ${label} action ${index + 1}`} onClick={onRemove}>
          Remove
        </button>
      </div>

      {action.type === 'emit' && (
        <label className="param-row">
          <span>Event</span>
          <input
            type="text"
            aria-label={`${label} event ${index + 1}`}
            value={action.event}
            spellCheck={false}
            onChange={(event) => onChange({ ...action, event: event.target.value })}
          />
        </label>
      )}

      {action.type === 'destroy' && (
        <label className="param-row">
          <span>Target</span>
          <select
            aria-label={`${label} target ${index + 1}`}
            value={action.targetId}
            onChange={(event) => onChange({ ...action, targetId: event.target.value })}
          >
            <option value="">Pick an object…</option>
            {objectIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
      )}

      {action.type === 'spawn' && (
        <>
          <label className="param-row">
            <span>Asset</span>
            <select
              aria-label={`${label} asset ${index + 1}`}
              value={action.assetId}
              onChange={(event) => onChange({ ...action, assetId: event.target.value })}
            >
              {assets.map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
            </select>
          </label>

          <div className="vector-row" role="group" aria-label={`${label} offset ${index + 1}`}>
            <span className="vector-title">Offset</span>
            <div className="vector-fields">
              {(['X', 'Y', 'Z'] as const).map((axis, at) => (
                <NumberField
                  key={axis}
                  label={`${label} offset ${index + 1} ${axis}`}
                  scrubLabel={axis}
                  value={action.offset[at] ?? 0}
                  step={0.5}
                  onChange={(next) => {
                    const offset: [number, number, number] = [...action.offset];
                    offset[at] = next;
                    onChange({ ...action, offset });
                  }}
                />
              ))}
            </div>
          </div>

          <label className="param-check">
            <input
              type="checkbox"
              checked={action.physics.body === 'kinematic'}
              onChange={(event) =>
                onChange({
                  ...action,
                  physics: {
                    ...action.physics,
                    body: event.target.checked ? 'kinematic' : 'static',
                  },
                })
              }
            />
            Movable (kinematic body)
          </label>
        </>
      )}
    </div>
  );
}

interface TriggerPanelProps {
  object: SceneObject;
  manifest: AssetManifest;
}

/**
 * Wiring for a trigger volume: what it watches for, and what happens then.
 *
 * The volume's size is deliberately not here — it is the object's scale, edited with the same
 * gizmo as everything else. A second size control would mean two answers to how big the thing is.
 */
export function TriggerPanel({ object, manifest }: TriggerPanelProps): React.JSX.Element | null {
  const setTrigger = useSceneStore((state) => state.setTrigger);
  const objects = useSceneStore((state) => state.scene.objects);
  const trigger = object.trigger;

  const objectIds = useMemo(
    () => objects.filter((item) => item.id !== object.id).map((item) => item.id),
    [objects, object.id],
  );
  const spawnable = useMemo(
    () => manifest.assets.filter((asset) => asset.category !== 'logic'),
    [manifest],
  );

  if (!trigger) return null;

  const update = (patch: Partial<Trigger>): void => setTrigger(object.id, patch);

  const editList = (list: ActionList, next: TriggerAction[]): void => update({ [list]: next });

  const renderList = (list: ActionList, label: string): React.JSX.Element => (
    <div className="trigger-list">
      <h3>{label}</h3>
      {trigger[list].length === 0 && <p className="panel-hint">Nothing yet.</p>}

      {trigger[list].map((action, index) => (
        <ActionEditor
          key={`${action.type}-${index}`}
          action={action}
          index={index}
          label={label}
          assets={spawnable}
          objectIds={objectIds}
          onChange={(next) =>
            editList(
              list,
              trigger[list].map((current, at) => (at === index ? next : current)),
            )
          }
          onRemove={() =>
            editList(
              list,
              trigger[list].filter((_unused, at) => at !== index),
            )
          }
        />
      ))}

      <label className="param-row">
        <span className="visually-hidden">Add {label} action</span>
        <select
          aria-label={`Add ${label} action`}
          value=""
          onChange={(event) => {
            const type = event.target.value as TriggerAction['type'] | '';
            if (!type) return;
            editList(list, [...trigger[list], newAction(type, spawnable[0]?.id)]);
          }}
        >
          <option value="">Add action…</option>
          <option value="emit">Emit event</option>
          <option value="spawn">Spawn object</option>
          <option value="destroy">Destroy object</option>
        </select>
      </label>
    </div>
  );

  return (
    <section className="panel" aria-label="Trigger">
      <h2>Trigger</h2>

      <label className="param-row">
        <span>Shape</span>
        <select
          aria-label="Shape"
          value={trigger.shape}
          onChange={(event) => update({ shape: event.target.value as Trigger['shape'] })}
        >
          <option value="box">Box</option>
          <option value="sphere">Sphere</option>
        </select>
      </label>

      <label className="param-row">
        <span>Detects</span>
        <select
          aria-label="Detects"
          value={trigger.detects}
          onChange={(event) => update({ detects: event.target.value as Trigger['detects'] })}
        >
          <option value="player">Player only</option>
          <option value="any">Anything</option>
        </select>
      </label>

      <label className="param-check">
        <input
          type="checkbox"
          checked={trigger.once}
          onChange={(event) => update({ once: event.target.checked })}
        />
        Fire only once
      </label>

      <p className="panel-hint">Scale the volume with the transform gizmo.</p>

      {renderList('onEnter', 'On enter')}
      {renderList('onExit', 'On exit')}
    </section>
  );
}
