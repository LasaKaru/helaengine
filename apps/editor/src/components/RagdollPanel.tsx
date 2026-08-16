import { useMemo, useState } from 'react';
import {
  RAGDOLL_LABELS,
  RAGDOLL_PARTS,
  defaultRagdoll,
  guessRagdollBones,
  ragdollProblems,
  type Ragdoll,
  type SceneObject,
} from '@helaengine/schema';
import { boneNamesFor } from '../engine/liveScene';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * What happens to a character's skeleton when physics takes it over.
 *
 * The panel is mostly a bone binding, and the binding is mostly done by the Detect button — eleven
 * dropdowns is a lot to fill in by hand, and every rig this engine has seen uses one of two naming
 * conventions. What the button does *not* do is apply silently: a wrong binding folds a corpse
 * inside out, and that is much easier to fix while looking at the list than after seeing it happen.
 */
export function RagdollPanel({ object }: { object: SceneObject }): React.JSX.Element {
  const setRagdoll = useSceneStore((state) => state.setRagdoll);
  const ragdoll = object.ragdoll;
  const [detected, setDetected] = useState<number | null>(null);

  // Read from the model the viewport built, because the document does not know what is inside a
  // `.glb` and the manifest does not carry bone names.
  const bones = useMemo(() => boneNamesFor(object.id), [object.id]);
  const problems = ragdoll ? ragdollProblems(ragdoll) : [];

  const update = (patch: Partial<Ragdoll>): void => {
    if (ragdoll) setRagdoll(object.id, { ...ragdoll, ...patch });
  };

  const detect = (): void => {
    if (!ragdoll) return;
    const guessed = guessRagdollBones(bones);
    update({ bones: guessed });
    setDetected(Object.values(guessed).filter((name) => name !== '').length);
  };

  return (
    <section className="panel" aria-label="Ragdoll">
      <h2>Ragdoll</h2>

      <label className="param-check">
        <input
          type="checkbox"
          aria-label="Ragdoll"
          checked={ragdoll !== null}
          onChange={(event) =>
            setRagdoll(object.id, event.target.checked ? defaultRagdoll() : null)
          }
        />
        Goes limp when it dies
      </label>

      {ragdoll === null && (
        <p className="panel-hint">
          {bones.length === 0
            ? 'This model has no skeleton, so there is nothing to go limp. Import a rigged character to use this.'
            : `This model has ${bones.length} bones. Turning this on hands eleven of them to physics on death.`}
        </p>
      )}

      {ragdoll && (
        <>
          <button type="button" disabled={bones.length === 0} onClick={detect}>
            Detect bones
          </button>
          {detected !== null && (
            <p className="panel-hint" role="status">
              Matched {detected} of {RAGDOLL_PARTS.length}. Check them — a wrong binding folds the
              corpse inside out, and that is easier to spot here than in play.
            </p>
          )}
          {bones.length === 0 && (
            <p className="panel-hint">
              No skeleton found in this model, so there is nothing to detect.
            </p>
          )}

          {RAGDOLL_PARTS.map((part) => (
            <label key={part} className="param-row">
              <span>{RAGDOLL_LABELS[part]}</span>
              <select
                aria-label={RAGDOLL_LABELS[part]}
                value={ragdoll.bones[part]}
                onChange={(event) =>
                  update({ bones: { ...ragdoll.bones, [part]: event.target.value } })
                }
              >
                <option value="">Not bound</option>
                {bones.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
                {/* A bone the current model does not have, kept so swapping models does not
                    silently drop a binding somebody made against the old one. */}
                {ragdoll.bones[part] !== '' && !bones.includes(ragdoll.bones[part]) && (
                  <option value={ragdoll.bones[part]}>{ragdoll.bones[part]} (missing)</option>
                )}
              </select>
            </label>
          ))}

          <div className="param-row">
            <span>Body mass</span>
            <NumberField
              label="Ragdoll mass"
              scrubLabel=""
              value={ragdoll.mass}
              step={5}
              suffix="kg"
              onChange={(mass) => update({ mass: Math.max(1, mass) })}
            />
          </div>

          <div className="param-row">
            <span>Keeps momentum</span>
            <NumberField
              label="Inherit velocity"
              scrubLabel=""
              value={ragdoll.inheritVelocity}
              step={0.05}
              onChange={(value) => update({ inheritVelocity: Math.min(1, Math.max(0, value)) })}
            />
          </div>
          <p className="panel-hint">
            How much of the character&rsquo;s motion the corpse carries into the fall. Zero drops
            them on the spot, which reads as the animation having been switched off.
          </p>

          <div className="param-row">
            <span>Limb thickness</span>
            <NumberField
              label="Limb thickness"
              scrubLabel=""
              value={ragdoll.thickness}
              step={0.02}
              onChange={(value) => update({ thickness: Math.min(1, Math.max(0.05, value)) })}
            />
          </div>

          <div className="param-row">
            <span>Clear after</span>
            <NumberField
              label="Corpse lifetime"
              scrubLabel=""
              value={ragdoll.lifetime}
              step={1}
              suffix="s"
              onChange={(value) => update({ lifetime: Math.max(0, value) })}
            />
          </div>
          {ragdoll.lifetime === 0 && (
            <p className="panel-hint">
              Zero leaves the body for good. Eleven rigid bodies per kill adds up in a level with a
              lot of them.
            </p>
          )}

          <p className="panel-hint">
            Joints are unlimited ball sockets, so limbs can bend further than a real one would. Cone
            limits are a project of their own and this is honestly a rag doll.
          </p>

          {problems.length > 0 && (
            <div className="joint-problems" role="status" aria-label="Ragdoll problems">
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
