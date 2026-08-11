import { useMemo } from 'react';
import {
  JOINT_HINTS,
  JOINT_LABELS,
  JOINT_TYPES,
  jointHasAxis,
  jointIsInert,
  jointProblems,
  type Joint,
  type JointType,
  type Vec3,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * Constraints between two objects.
 *
 * The panel is built around the two mistakes that are easy to make and hard to see. A joint between
 * two static bodies is a hinge that is right in every respect and cannot move, because neither end
 * can be moved by anything; and an anchor left at the origin puts the pivot through the middle of
 * the door rather than along its edge, so it spins instead of swinging. Both are called out here,
 * because in the viewport they look identical to a joint that is simply not working.
 */

const AXES: Array<{ index: 0 | 1 | 2; label: string }> = [
  { index: 0, label: 'X' },
  { index: 1, label: 'Y' },
  { index: 2, label: 'Z' },
];

interface JointCardProps {
  joint: Joint;
  objects: Array<{ id: string; label: string; body: string }>;
  problems: string[];
  onChange(patch: Partial<Joint>): void;
  onRemove(): void;
}

function VectorField({
  title,
  value,
  onChange,
}: {
  title: string;
  value: Vec3;
  onChange(next: Vec3): void;
}): React.JSX.Element {
  return (
    <div className="vector-row" role="group" aria-label={title}>
      <span className="vector-title">{title}</span>
      <div className="vector-fields">
        {AXES.map(({ index, label }) => (
          <NumberField
            key={label}
            label={`${title} ${label}`}
            scrubLabel={label}
            value={value[index]}
            step={0.1}
            onChange={(next) => {
              const updated: Vec3 = [...value];
              updated[index] = next;
              onChange(updated);
            }}
          />
        ))}
      </div>
    </div>
  );
}

function JointCard({
  joint,
  objects,
  problems,
  onChange,
  onRemove,
}: JointCardProps): React.JSX.Element {
  const name = joint.metadata.label ?? `${JOINT_LABELS[joint.type]} joint`;

  return (
    <div className="joint-card">
      <div className="behavior-head">
        <input
          type="text"
          aria-label={`${joint.id} label`}
          className="scatter-name"
          value={joint.metadata.label ?? ''}
          placeholder={`${JOINT_LABELS[joint.type]} joint`}
          onChange={(event) =>
            onChange({
              metadata: event.target.value ? { label: event.target.value } : {},
            } as Partial<Joint>)
          }
        />
        <button type="button" aria-label={`Remove ${name}`} onClick={onRemove}>
          Remove
        </button>
      </div>

      <label className="param-row">
        <span>Kind</span>
        <select
          aria-label={`${name} kind`}
          value={joint.type}
          title={JOINT_HINTS[joint.type]}
          onChange={(event) => onChange({ type: event.target.value as JointType })}
        >
          {JOINT_TYPES.map((type) => (
            <option key={type} value={type}>
              {JOINT_LABELS[type]}
            </option>
          ))}
        </select>
      </label>
      <p className="panel-hint">{JOINT_HINTS[joint.type]}</p>

      {(['objectA', 'objectB'] as const).map((end) => (
        <label key={end} className="param-row">
          <span>{end === 'objectA' ? 'Attach to' : 'and to'}</span>
          <select
            aria-label={`${name} ${end === 'objectA' ? 'first object' : 'second object'}`}
            value={joint[end]}
            onChange={(event) => onChange({ [end]: event.target.value } as Partial<Joint>)}
          >
            {objects.map((object) => (
              <option key={object.id} value={object.id}>
                {object.label}
              </option>
            ))}
          </select>
        </label>
      ))}

      <VectorField
        title="Pivot on first"
        value={joint.anchorA}
        onChange={(anchorA) => onChange({ anchorA } as Partial<Joint>)}
      />
      <VectorField
        title="Pivot on second"
        value={joint.anchorB}
        onChange={(anchorB) => onChange({ anchorB } as Partial<Joint>)}
      />

      {jointHasAxis(joint.type) && 'axis' in joint && (
        <VectorField
          title="Axis"
          value={joint.axis}
          onChange={(axis) => onChange({ axis } as Partial<Joint>)}
        />
      )}

      {'limit' in joint && (
        <>
          <label className="param-check">
            <input
              type="checkbox"
              aria-label={`${name} limited`}
              checked={joint.limit !== null}
              onChange={(event) =>
                onChange({
                  limit: event.target.checked
                    ? joint.type === 'hinge'
                      ? { min: -1.5, max: 1.5 }
                      : { min: 0, max: 2 }
                    : null,
                } as Partial<Joint>)
              }
            />
            Stop at a limit
          </label>

          {joint.limit && (
            <div className="param-row">
              <span>{joint.type === 'hinge' ? 'Travel (rad)' : 'Travel (m)'}</span>
              <NumberField
                label={`${name} minimum`}
                scrubLabel="min"
                value={joint.limit.min}
                step={0.1}
                onChange={(min) =>
                  onChange({
                    limit: { min, max: Math.max(min, joint.limit!.max) },
                  } as Partial<Joint>)
                }
              />
              <NumberField
                label={`${name} maximum`}
                scrubLabel="max"
                value={joint.limit.max}
                step={0.1}
                onChange={(max) =>
                  onChange({
                    limit: { min: Math.min(joint.limit!.min, max), max },
                  } as Partial<Joint>)
                }
              />
            </div>
          )}
        </>
      )}

      {'motor' in joint && (
        <>
          <label className="param-row">
            <span>Motor</span>
            <select
              aria-label={`${name} motor`}
              value={joint.motor.mode}
              onChange={(event) =>
                onChange({
                  motor: { ...joint.motor, mode: event.target.value as 'off' },
                } as Partial<Joint>)
              }
            >
              <option value="off">None</option>
              <option value="velocity">Spin at a rate</option>
              <option value="position">Hold a target</option>
            </select>
          </label>

          {joint.motor.mode !== 'off' && (
            <div className="param-row">
              <span>{joint.motor.mode === 'velocity' ? 'Rate' : 'Target'}</span>
              <NumberField
                label={`${name} motor target`}
                scrubLabel=""
                value={joint.motor.mode === 'velocity' ? joint.motor.velocity : joint.motor.target}
                step={0.1}
                onChange={(value) =>
                  onChange({
                    motor: {
                      ...joint.motor,
                      ...(joint.motor.mode === 'velocity'
                        ? { velocity: value }
                        : { target: value }),
                    },
                  } as Partial<Joint>)
                }
              />
            </div>
          )}
        </>
      )}

      {'restLength' in joint && (
        <div className="param-row">
          <span>Rest length</span>
          <NumberField
            label={`${name} rest length`}
            scrubLabel=""
            value={joint.restLength}
            step={0.1}
            suffix="m"
            onChange={(restLength) => onChange({ restLength } as Partial<Joint>)}
          />
        </div>
      )}

      {'length' in joint && (
        <div className="param-row">
          <span>Length</span>
          <NumberField
            label={`${name} length`}
            scrubLabel=""
            value={joint.length}
            step={0.1}
            suffix="m"
            onChange={(length) => onChange({ length } as Partial<Joint>)}
          />
        </div>
      )}

      <label className="param-check">
        <input
          type="checkbox"
          aria-label={`${name} bodies collide`}
          checked={joint.collide}
          onChange={(event) => onChange({ collide: event.target.checked } as Partial<Joint>)}
        />
        The two still collide
      </label>

      {problems.length > 0 && (
        <div className="joint-problems" role="status" aria-label={`${name} problems`}>
          {problems.map((problem) => (
            <p key={problem}>{problem}</p>
          ))}
        </div>
      )}
    </div>
  );
}

export function JointsPanel(): React.JSX.Element {
  const objects = useSceneStore((state) => state.scene.objects);
  const joints = useSceneStore((state) => state.scene.joints);
  const selectedIds = useSceneStore((state) => state.selectedIds);
  const addJoint = useSceneStore((state) => state.addJoint);
  const updateJoint = useSceneStore((state) => state.updateJoint);
  const removeJoint = useSceneStore((state) => state.removeJoint);

  const choices = useMemo(
    () =>
      objects.map((object) => ({
        id: object.id,
        label: object.metadata.label ?? object.assetId,
        body: object.physics.body,
      })),
    [objects],
  );

  const bodyById = useMemo(
    () => new Map(objects.map((object) => [object.id, object.physics.body] as const)),
    [objects],
  );

  const dangling = useMemo(
    () => jointProblems(joints, new Set(objects.map((object) => object.id))),
    [joints, objects],
  );

  /** Two selected objects is the whole of what a joint needs, so that is what the button wants. */
  const pair = selectedIds.length === 2 ? selectedIds : null;

  const problemsFor = (joint: Joint): string[] => {
    const found = dangling
      .filter((problem) => problem.jointId === joint.id)
      .map((problem) => problem.reason);

    const bodyA = bodyById.get(joint.objectA);
    const bodyB = bodyById.get(joint.objectB);
    if (bodyA && bodyB && jointIsInert(bodyA, bodyB)) {
      // The single most common way to build a door that does not open. Everything about the
      // document says it should work; nothing in the world can move either end.
      found.push('neither end is Dynamic, so nothing can move — set one of them under Physics');
    }

    if (
      joint.type === 'hinge' &&
      joint.anchorA.every((value) => value === 0) &&
      joint.anchorB.every((value) => value === 0)
    ) {
      // A hinge through a body's own centre lets it spin without swinging, which reads as "the
      // hinge is broken" rather than "the pivot is in the wrong place".
      found.push('both pivots are at the centre, so this will spin in place rather than swing');
    }

    return found;
  };

  return (
    <section className="panel" aria-label="Joints">
      <h2>Joints</h2>

      {joints.length === 0 && (
        <p className="panel-hint">
          Nothing joined yet. A joint pins two objects together and says how they may still move — a
          hinge for a door, a slider for a lift, a rope for a hanging sign.
        </p>
      )}

      {joints.map((joint) => (
        <JointCard
          key={joint.id}
          joint={joint}
          objects={choices}
          problems={problemsFor(joint)}
          onChange={(patch) => updateJoint(joint.id, patch)}
          onRemove={() => removeJoint(joint.id)}
        />
      ))}

      <button
        type="button"
        disabled={pair === null}
        title={
          pair === null
            ? 'Select exactly two objects to join them'
            : 'Join the two selected objects'
        }
        onClick={() => {
          if (pair) addJoint('hinge', pair[0]!, pair[1]!);
        }}
      >
        Join the two selected
      </button>

      {pair === null && (
        <p className="panel-hint">Select two objects in the viewport to join them.</p>
      )}
    </section>
  );
}
