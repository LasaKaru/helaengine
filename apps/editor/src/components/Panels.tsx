import { useMemo } from 'react';
import type { Transform, Vec3 } from '@helaengine/schema';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

type Axis = 0 | 1 | 2;
const AXES: Array<{ axis: Axis; label: string }> = [
  { axis: 0, label: 'X' },
  { axis: 1, label: 'Y' },
  { axis: 2, label: 'Z' },
];

interface VectorRowProps {
  title: string;
  value: Vec3;
  step: number;
  suffix?: string;
  onChange(value: Vec3): void;
}

function VectorRow({ title, value, step, suffix, onChange }: VectorRowProps): React.JSX.Element {
  return (
    <div className="vector-row" role="group" aria-label={title}>
      <span className="vector-title">{title}</span>
      <div className="vector-fields">
        {AXES.map(({ axis, label }) => (
          <NumberField
            key={label}
            label={`${title} ${label}`}
            scrubLabel={label}
            value={value[axis]}
            step={step}
            {...(suffix ? { suffix } : {})}
            onChange={(next) => {
              const updated: Vec3 = [...value];
              updated[axis] = next;
              onChange(updated);
            }}
          />
        ))}
      </div>
    </div>
  );
}

/** Inspector for the current selection, above the scene list. */
export function InspectorPanel(): React.JSX.Element {
  const selectedIds = useSceneStore((state) => state.selectedIds);
  const objects = useSceneStore((state) => state.scene.objects);
  const setTransform = useSceneStore((state) => state.setTransform);
  const duplicateObjects = useSceneStore((state) => state.duplicateObjects);
  const removeObjects = useSceneStore((state) => state.removeObjects);
  const gizmoMode = useEditorStore((state) => state.gizmoMode);
  const setGizmoMode = useEditorStore((state) => state.setGizmoMode);

  const selected = useMemo(
    () => objects.filter((object) => selectedIds.includes(object.id)),
    [objects, selectedIds],
  );
  const single = selected.length === 1 ? selected[0] : null;

  const update = (patch: Partial<Transform>): void => {
    if (single) setTransform(single.id, patch);
  };

  return (
    <aside className="rail rail-right">
      <section className="panel" aria-label="Inspector">
        <h2>Inspector</h2>

        {selected.length === 0 && <p className="panel-hint">Nothing selected.</p>}

        {selected.length > 1 && (
          <p className="panel-hint">
            {selected.length} objects selected. Drag the gizmo to move, rotate or scale them
            together; the numeric fields edit one object at a time.
          </p>
        )}

        {single && (
          <>
            <dl className="inspector-meta">
              <dt>Id</dt>
              <dd>{single.id}</dd>
              <dt>Asset</dt>
              <dd>{single.assetId}</dd>
            </dl>

            <div className="gizmo-modes" role="group" aria-label="Transform mode">
              {(['translate', 'rotate', 'scale'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  className={gizmoMode === mode ? 'active' : ''}
                  aria-pressed={gizmoMode === mode}
                  onClick={() => setGizmoMode(mode)}
                >
                  {mode}
                </button>
              ))}
            </div>

            <VectorRow
              title="Position"
              value={single.transform.position}
              step={0.1}
              onChange={(position) => update({ position })}
            />
            <VectorRow
              title="Rotation"
              value={single.transform.rotation}
              step={1}
              suffix="°"
              onChange={(rotation) => update({ rotation })}
            />
            <VectorRow
              title="Scale"
              value={single.transform.scale}
              step={0.05}
              onChange={(scale) => update({ scale })}
            />
          </>
        )}

        {selected.length > 0 && (
          <div className="inspector-actions">
            <button type="button" onClick={() => duplicateObjects(selectedIds)}>
              Duplicate
            </button>
            <button type="button" className="danger" onClick={() => removeObjects(selectedIds)}>
              Delete
            </button>
          </div>
        )}
      </section>
    </aside>
  );
}
