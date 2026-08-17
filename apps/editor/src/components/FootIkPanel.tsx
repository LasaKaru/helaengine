import { useState } from 'react';
import {
  FOOT_IK_BONES,
  FOOT_IK_BONE_LABELS,
  defaultFootIk,
  footIkProblems,
  guessFootIkBones,
  type FootIk,
  type SceneObject,
} from '@helaengine/schema';
import { boneNamesFor } from '../engine/liveScene';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * Feet that stand on what is under them.
 *
 * Same shape as the ragdoll panel and for the same reason: it is mostly a bone binding, the binding
 * is mostly done by a button, and the button offers rather than applies. A wrong binding here bends
 * a knee backwards, which is far easier to spot in a list of names than in a character walking away
 * from you.
 */
export function FootIkPanel({ object }: { object: SceneObject }): React.JSX.Element {
  const setFootIk = useSceneStore((state) => state.setFootIk);
  const ik = object.footIk;
  const [detected, setDetected] = useState<number | null>(null);

  /**
   * The bone names inside this model, read on every render rather than memoised on the object id.
   *
   * From the model the viewport built: the document does not know what is inside a `.glb`, and the
   * manifest does not carry bone names.
   *
   * The model arrives asynchronously, and a `useMemo` keyed only on the id caches whatever the
   * viewport had at the moment the panel first appeared — which for a freshly placed character is an
   * empty list, leaving the Detect button disabled forever with no explanation. Traversing a
   * skeleton is a few dozen nodes; the memo was saving nothing and costing that.
   */
  const bones = boneNamesFor(object.id);
  const problems = ik ? footIkProblems(ik) : [];

  const update = (patch: Partial<FootIk>): void => {
    if (ik) setFootIk(object.id, { ...ik, ...patch });
  };

  const detect = (): void => {
    if (!ik) return;
    const guessed = guessFootIkBones(bones);
    update({ bones: guessed });
    setDetected(Object.values(guessed).filter((name) => name !== '').length);
  };

  return (
    <section className="panel" aria-label="Foot placement">
      <h2>Foot placement</h2>

      <label className="param-check">
        <input
          type="checkbox"
          aria-label="Foot placement"
          checked={ik !== null}
          onChange={(event) =>
            setFootIk(object.id, event.target.checked ? defaultFootIk(bones) : null)
          }
        />
        Place this character&rsquo;s feet on the ground
      </label>

      {ik === null && (
        <p className="panel-hint">
          A walk clip is authored on a flat floor. On stairs the leading foot hangs in the air and
          the trailing one sinks through the step; on a slope the whole character skates. This moves
          the ankle after the clip has had its say, and drops the hips far enough that the lower
          foot can reach.
        </p>
      )}

      {ik && (
        <>
          {bones.length === 0 && (
            <p className="panel-hint">
              This model has no skeleton, so there is nothing to bind. Foot placement only does
              anything on a rigged character.
            </p>
          )}

          <button type="button" onClick={detect} disabled={bones.length === 0}>
            Detect bones
          </button>
          {detected !== null && (
            <p className="panel-hint">
              Matched {detected} of {FOOT_IK_BONES.length}. Check them before trusting it — a
              crossed-over side bends a knee the wrong way.
            </p>
          )}

          {FOOT_IK_BONES.map((part) => (
            <label className="param-row" key={part}>
              <span>{FOOT_IK_BONE_LABELS[part]}</span>
              <select
                aria-label={FOOT_IK_BONE_LABELS[part]}
                value={ik.bones[part]}
                onChange={(event) => update({ bones: { ...ik.bones, [part]: event.target.value } })}
              >
                <option value="">None</option>
                {bones.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          ))}

          <div className="param-row">
            <span>Ankle height</span>
            <NumberField
              label="Ankle height"
              value={ik.ankleHeight}
              step={0.01}
              suffix="m"
              onChange={(ankleHeight) => update({ ankleHeight: clamp(ankleHeight, 0, 0.5) })}
            />
          </div>
          <p className="panel-hint">
            From the ankle joint to the sole. The solver aims the joint, and the joint is not the
            part that touches the ground — at zero the character walks on its shins.
          </p>

          <div className="param-row">
            <span>Search range</span>
            <NumberField
              label="Search range"
              value={ik.reach}
              step={0.05}
              suffix="m"
              onChange={(reach) => update({ reach: clamp(reach, 0.05, 3) })}
            />
          </div>

          <div className="param-row">
            <span>Hip drop</span>
            <NumberField
              label="Hip drop"
              value={ik.hipDrop}
              step={0.05}
              suffix="m"
              onChange={(hipDrop) => update({ hipDrop: clamp(hipDrop, 0, 1.5) })}
            />
          </div>
          <p className="panel-hint">
            How far the body may come down so the lower foot can reach. Capped, or a character
            standing astride a gap puts its pelvis at the bottom of it.
          </p>

          <div className="param-row">
            <span>Settling</span>
            <NumberField
              label="Settling"
              value={ik.smoothing}
              step={1}
              onChange={(smoothing) => update({ smoothing: clamp(smoothing, 0, 30) })}
            />
          </div>
          <p className="panel-hint">
            Higher settles faster. Zero snaps, which pops at a stair edge — and a pop is what makes
            people switch this off.
          </p>

          {problems.length > 0 && (
            <div className="joint-problems" role="status" aria-label="Foot placement problems">
              {problems.map((problem) => (
                <p key={problem}>{problem}</p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}
