import {
  EMITTER_KINDS,
  EMITTER_LABELS,
  EMITTER_PRESETS,
  defaultEmitter,
  emitterCapacity,
  emitterProblems,
  type Emitter,
  type EmitterKind,
  type SceneObject,
  type Vec3,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * Particles thrown out by one object.
 *
 * The panel is scales rather than absolutes — `rateScale`, `sizeScale` — because the presets are
 * chosen so that ticking `fire` and changing nothing gives fire. A panel of raw numbers would ask
 * every author to rediscover what fire looks like, and most of them would stop at "orange dots".
 */

const AXES: Array<{ index: 0 | 1 | 2; label: string }> = [
  { index: 0, label: 'X' },
  { index: 1, label: 'Y' },
  { index: 2, label: 'Z' },
];

export function EmitterPanel({ object }: { object: SceneObject }): React.JSX.Element {
  const setEmitter = useSceneStore((state) => state.setEmitter);
  const emitter = object.emitter;
  const problems = emitter ? emitterProblems(emitter) : [];

  const update = (patch: Partial<Emitter>): void => {
    if (emitter) setEmitter(object.id, { ...emitter, ...patch });
  };

  return (
    <section className="panel" aria-label="Particles">
      <h2>Particles</h2>

      <label className="param-check">
        <input
          type="checkbox"
          aria-label="Particles"
          checked={emitter !== null}
          onChange={(event) =>
            setEmitter(object.id, event.target.checked ? defaultEmitter() : null)
          }
        />
        This throws out particles
      </label>

      {emitter === null && (
        <p className="panel-hint">
          Smoke off a chimney, fire in a brazier, sparks off a broken wire — or a puff that only
          appears when something asks for it.
        </p>
      )}

      {emitter && (
        <>
          <label className="param-row">
            <span>Kind</span>
            <select
              aria-label="Particle kind"
              value={emitter.kind}
              onChange={(event) => update({ kind: event.target.value as EmitterKind })}
            >
              {EMITTER_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {EMITTER_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>

          <label className="param-check">
            <input
              type="checkbox"
              aria-label="Continuous"
              checked={emitter.continuous}
              onChange={(event) => update({ continuous: event.target.checked })}
            />
            Runs continuously
          </label>
          {!emitter.continuous && (
            <p className="panel-hint">
              A chimney is continuous. A footstep puff is not — it exists to be triggered, and a
              continuous one would be a permanent cloud round the character&rsquo;s ankles.
            </p>
          )}

          {emitter.continuous && (
            <div className="param-row">
              <span>Rate</span>
              <NumberField
                label="Rate scale"
                scrubLabel=""
                value={emitter.rateScale}
                step={0.1}
                suffix="×"
                onChange={(rateScale) => update({ rateScale: Math.max(0, rateScale) })}
              />
            </div>
          )}

          <div className="param-row">
            <span>Burst size</span>
            <NumberField
              label="Burst size"
              scrubLabel=""
              value={emitter.burst}
              step={4}
              onChange={(burst) => update({ burst: Math.round(Math.max(0, burst)) })}
            />
          </div>

          <label className="param-row">
            <span>Burst on event</span>
            <input
              type="text"
              aria-label="Burst event"
              placeholder="none"
              value={emitter.burstEvent}
              onChange={(event) => update({ burstEvent: event.target.value.slice(0, 64) })}
            />
          </label>
          <p className="panel-hint">
            The same names everything else raises. Bind a dust puff to{' '}
            <code>destructibleBroken</code> and one emitter covers every crate in the level.
          </p>

          <div className="param-row">
            <span>Size</span>
            <NumberField
              label="Size scale"
              scrubLabel=""
              value={emitter.sizeScale}
              step={0.1}
              suffix="×"
              onChange={(sizeScale) => update({ sizeScale: Math.max(0.05, sizeScale) })}
            />
          </div>
          <div className="param-row">
            <span>Lifetime</span>
            <NumberField
              label="Life scale"
              scrubLabel=""
              value={emitter.lifeScale}
              step={0.1}
              suffix="×"
              onChange={(lifeScale) => update({ lifeScale: Math.max(0.05, lifeScale) })}
            />
          </div>
          <div className="param-row">
            <span>Speed</span>
            <NumberField
              label="Speed scale"
              scrubLabel=""
              value={emitter.speedScale}
              step={0.1}
              suffix="×"
              onChange={(speedScale) => update({ speedScale: Math.max(0, speedScale) })}
            />
          </div>

          <div className="vector-row" role="group" aria-label="Emitter offset">
            <span className="vector-title">Offset</span>
            <div className="vector-fields">
              {AXES.map(({ index, label }) => (
                <NumberField
                  key={label}
                  label={`Emitter offset ${label}`}
                  scrubLabel={label}
                  value={emitter.offset[index]}
                  step={0.1}
                  onChange={(next) => {
                    const offset: Vec3 = [...emitter.offset];
                    offset[index] = next;
                    update({ offset });
                  }}
                />
              ))}
            </div>
          </div>

          <label className="param-row">
            <span>Colour</span>
            <input
              type="color"
              aria-label="Particle colour"
              value={emitter.color ?? EMITTER_PRESETS[emitter.kind].color}
              onChange={(event) => update({ color: event.target.value })}
            />
          </label>
          {emitter.color !== null && (
            <button type="button" onClick={() => update({ color: null })}>
              Back to the {EMITTER_LABELS[emitter.kind].toLowerCase()} colour
            </button>
          )}

          <p className="panel-hint">
            Room for {emitterCapacity(emitter)} particles at once, fixed when the level loads —
            growing a GPU buffer mid-frame is a hitch, so a full pool drops the newest instead.
          </p>

          {problems.length > 0 && (
            <div className="joint-problems" role="status" aria-label="Particle problems">
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
