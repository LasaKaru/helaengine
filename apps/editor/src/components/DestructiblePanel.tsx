import { useMemo } from 'react';
import {
  defaultDestructible,
  destructibleProblems,
  MAX_FRAGMENTS,
  type AssetManifest,
  type BreakEffect,
  type DamageSource,
  type Destructible,
  type SceneObject,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * What happens when this object takes enough damage.
 *
 * The panel is arranged around the one thing an author gets wrong: choosing an effect and never
 * choosing what it leaves behind. A `swap` with no replacement and a `fragments` with no debris
 * both look completely configured and do nothing at all, so the asset picker appears immediately
 * under the effect and the problem list says so until it is filled in.
 */

const EFFECTS: Array<{ value: BreakEffect; label: string; hint: string }> = [
  {
    value: 'vanish',
    label: 'Vanish',
    hint: 'It disappears. Glass, rotten planks, anything in the way.',
  },
  {
    value: 'swap',
    label: 'Swap',
    hint: 'Replaced by another model in place — the cheapest convincing break.',
  },
  {
    value: 'fragments',
    label: 'Fragments',
    hint: 'Replaced by several dynamic pieces, thrown outward. The expensive one.',
  },
];

const SOURCES: Array<{ value: DamageSource; label: string; hint: string }> = [
  { value: 'weapons', label: 'Weapons', hint: 'Shooting it.' },
  { value: 'impact', label: 'Impact', hint: 'Being hit hard enough by something moving.' },
];

export function DestructiblePanel({
  object,
  manifest,
}: {
  object: SceneObject;
  manifest: AssetManifest;
}): React.JSX.Element {
  const setDestructible = useSceneStore((state) => state.setDestructible);
  const destructible = object.destructible;

  const knownAssets = useMemo(
    () => new Set(manifest.assets.map((asset) => asset.id)),
    [manifest.assets],
  );
  const models = useMemo(
    () => manifest.assets.filter((asset) => asset.category !== 'audio'),
    [manifest.assets],
  );

  const problems = destructible ? destructibleProblems(destructible, knownAssets) : [];
  const update = (patch: Partial<Destructible>): void => {
    if (destructible) setDestructible(object.id, { ...destructible, ...patch });
  };

  return (
    <section className="panel" aria-label="Breakable">
      <h2>Breakable</h2>

      <label className="param-check">
        <input
          type="checkbox"
          aria-label="Breakable"
          checked={destructible !== null}
          onChange={(event) =>
            setDestructible(object.id, event.target.checked ? defaultDestructible() : null)
          }
        />
        This can be broken
      </label>

      {destructible === null && (
        <p className="panel-hint">
          Nothing breaks it. Turning this on gives it hit points and something to leave behind.
        </p>
      )}

      {destructible && (
        <>
          <div className="param-row">
            <span>Hit points</span>
            <NumberField
              label="Hit points"
              scrubLabel=""
              value={destructible.hitPoints}
              step={5}
              onChange={(hitPoints) => update({ hitPoints: Math.max(1, hitPoints) })}
            />
          </div>

          <div className="gizmo-modes" role="group" aria-label="Damaged by">
            {SOURCES.map((source) => {
              const on = destructible.damagedBy.includes(source.value);
              return (
                <button
                  key={source.value}
                  type="button"
                  title={source.hint}
                  className={on ? 'active' : ''}
                  aria-pressed={on}
                  onClick={() =>
                    update({
                      damagedBy: on
                        ? destructible.damagedBy.filter((entry) => entry !== source.value)
                        : [...destructible.damagedBy, source.value],
                    })
                  }
                >
                  {source.label}
                </button>
              );
            })}
          </div>

          {destructible.damagedBy.includes('impact') && (
            <>
              <div className="param-row">
                <span>Impact from</span>
                <NumberField
                  label="Impact threshold"
                  scrubLabel=""
                  value={destructible.impactThreshold}
                  step={0.5}
                  suffix="m/s"
                  onChange={(impactThreshold) =>
                    update({ impactThreshold: Math.max(0, impactThreshold) })
                  }
                />
              </div>
              <div className="param-row">
                <span>Damage per m/s</span>
                <NumberField
                  label="Impact damage scale"
                  scrubLabel=""
                  value={destructible.impactDamageScale}
                  step={0.5}
                  onChange={(impactDamageScale) =>
                    update({ impactDamageScale: Math.max(0, impactDamageScale) })
                  }
                />
              </div>
            </>
          )}

          <label className="param-row">
            <span>When it breaks</span>
            <select
              aria-label="Break effect"
              value={destructible.effect}
              title={EFFECTS.find((entry) => entry.value === destructible.effect)?.hint}
              onChange={(event) => update({ effect: event.target.value as BreakEffect })}
            >
              {EFFECTS.map((entry) => (
                <option key={entry.value} value={entry.value}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <p className="panel-hint">
            {EFFECTS.find((entry) => entry.value === destructible.effect)?.hint}
          </p>

          {destructible.effect !== 'vanish' && (
            <label className="param-row">
              <span>{destructible.effect === 'swap' ? 'Replace with' : 'Made of'}</span>
              <select
                aria-label="Debris model"
                value={destructible.debrisAssetId}
                onChange={(event) => update({ debrisAssetId: event.target.value })}
              >
                <option value="">Choose a model…</option>
                {models.map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {destructible.effect === 'fragments' && (
            <>
              <div className="param-row">
                <span>Pieces</span>
                <NumberField
                  label="Fragment count"
                  scrubLabel=""
                  value={destructible.fragmentCount}
                  step={1}
                  onChange={(count) =>
                    update({
                      // Capped here as well as in the schema, so the field stops rather than
                      // silently refusing the parse and reverting to what it was.
                      fragmentCount: Math.round(Math.min(MAX_FRAGMENTS, Math.max(1, count))),
                    })
                  }
                />
              </div>
              <div className="param-row">
                <span>Thrown at</span>
                <NumberField
                  label="Fragment speed"
                  scrubLabel=""
                  value={destructible.fragmentSpeed}
                  step={0.5}
                  suffix="m/s"
                  onChange={(fragmentSpeed) =>
                    update({ fragmentSpeed: Math.max(0, fragmentSpeed) })
                  }
                />
              </div>
              <div className="param-row">
                <span>Piece size</span>
                <NumberField
                  label="Fragment scale"
                  scrubLabel=""
                  value={destructible.fragmentScale}
                  step={0.05}
                  onChange={(fragmentScale) =>
                    update({ fragmentScale: Math.max(0.01, fragmentScale) })
                  }
                />
              </div>
              <div className="param-row">
                <span>Clear after</span>
                <NumberField
                  label="Fragment lifetime"
                  scrubLabel=""
                  value={destructible.fragmentLifetime}
                  step={1}
                  suffix="s"
                  onChange={(fragmentLifetime) =>
                    update({ fragmentLifetime: Math.max(0, fragmentLifetime) })
                  }
                />
              </div>
              {destructible.fragmentLifetime === 0 && (
                <p className="panel-hint">
                  Zero leaves the pieces in the world for good. A level where a hundred crates are
                  broken then simulates several hundred pieces nobody can see.
                </p>
              )}
            </>
          )}

          <label className="param-row">
            <span>Raise event</span>
            <input
              type="text"
              aria-label="Break event"
              placeholder="none"
              value={destructible.breakEvent}
              onChange={(event) => update({ breakEvent: event.target.value.slice(0, 64) })}
            />
          </label>
          <p className="panel-hint">
            A graph <em>On event</em> node listening for this name runs when it breaks — which is
            how a crate opens a door without either of them knowing about the other. A sound is a
            binding against this name in the Audio panel, or against <code>destructibleBroken</code>{' '}
            for every break in the level.
          </p>

          {problems.length > 0 && (
            <div className="joint-problems" role="status" aria-label="Breakable problems">
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
