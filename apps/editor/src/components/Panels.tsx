import { useMemo } from 'react';
import type {
  AssetManifest,
  BodyType,
  ColliderChoice,
  SceneObject,
  Transform,
  Vec3,
} from '@helaengine/schema';
import { useEditorStore } from '../store/editorStore';
import { useSceneStore } from '../store/sceneStore';
import { BehaviorPanel } from './BehaviorPanel';
import { TriggerPanel } from './TriggerPanel';
import { NumberField } from './NumberField';
import { TerrainPanel } from './TerrainPanel';

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

const BODY_TYPES: Array<{ value: BodyType; label: string; hint: string }> = [
  { value: 'static', label: 'Static', hint: 'Never moves. Buildings, rocks, trees.' },
  { value: 'dynamic', label: 'Dynamic', hint: 'Falls and is pushed around by contacts.' },
  { value: 'kinematic', label: 'Kinematic', hint: 'Moved by gameplay; pushes, is not pushed.' },
];

const COLLIDER_CHOICES: ColliderChoice[] = ['auto', 'box', 'capsule', 'sphere', 'mesh', 'none'];

/**
 * How one placement collides.
 *
 * `auto` is the default and stays the default: the asset manifest already knows the shape of a
 * pine tree, and answering it per instance would be a hundred chances to answer it differently.
 */
function PhysicsSection({ object }: { object: SceneObject }): React.JSX.Element {
  const setObjectPhysics = useSceneStore((state) => state.setObjectPhysics);

  return (
    <section className="panel" aria-label="Physics">
      <h2>Physics</h2>

      <div className="gizmo-modes" role="group" aria-label="Body type">
        {BODY_TYPES.map((entry) => (
          <button
            key={entry.value}
            type="button"
            title={entry.hint}
            className={object.physics.body === entry.value ? 'active' : ''}
            aria-pressed={object.physics.body === entry.value}
            onClick={() => setObjectPhysics(object.id, { body: entry.value })}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <label className="param-row">
        <span>Collider</span>
        <select
          aria-label="Collider"
          value={object.physics.collider}
          onChange={(event) =>
            setObjectPhysics(object.id, { collider: event.target.value as ColliderChoice })
          }
        >
          {COLLIDER_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {choice === 'auto' ? 'Auto (from asset)' : choice}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

/** Where the player starts, and how they move, when the scene is walked or exported. */
function PlayerPanel(): React.JSX.Element {
  const player = useSceneStore((state) => state.scene.player);
  const setPlayer = useSceneStore((state) => state.setPlayer);
  const selectedIds = useSceneStore((state) => state.selectedIds);
  const objects = useSceneStore((state) => state.scene.objects);

  const moveToSelection = (): void => {
    const object = objects.find((item) => item.id === selectedIds[0]);
    if (object) setPlayer({ spawn: [...object.transform.position] });
  };

  return (
    <section className="panel" aria-label="Player">
      <h2>Player</h2>

      <VectorRow
        title="Spawn"
        value={player.spawn}
        step={0.5}
        onChange={(spawn) => setPlayer({ spawn })}
      />

      <div className="param-row">
        <span>Move speed</span>
        <NumberField
          label="Move speed"
          scrubLabel=""
          value={player.moveSpeed}
          step={0.5}
          suffix="m/s"
          onChange={(moveSpeed) => setPlayer({ moveSpeed: Math.min(50, Math.max(0.5, moveSpeed)) })}
        />
      </div>

      <div className="param-row">
        <span>Jump speed</span>
        <NumberField
          label="Jump speed"
          scrubLabel=""
          value={player.jumpSpeed}
          step={0.5}
          suffix="m/s"
          onChange={(jumpSpeed) => setPlayer({ jumpSpeed: Math.min(50, Math.max(0, jumpSpeed)) })}
        />
      </div>

      <button type="button" disabled={selectedIds.length !== 1} onClick={moveToSelection}>
        Spawn at object
      </button>
    </section>
  );
}

/** Inspector for the current selection, above the scene list. */
export function InspectorPanel({ manifest }: { manifest: AssetManifest }): React.JSX.Element {
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

      {single?.trigger && <TriggerPanel object={single} manifest={manifest} />}
      {single && !single.trigger && <PhysicsSection object={single} />}
      {single && !single.trigger && <BehaviorPanel object={single} />}

      <TerrainPanel />
      <PlayerPanel />
    </aside>
  );
}
