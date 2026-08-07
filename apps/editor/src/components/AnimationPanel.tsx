import {
  ANIMATION_STATES,
  ObjectAnimationSchema,
  STATE_PLAYBACK,
  type AnimationState,
  type AssetManifest,
  type SceneObject,
} from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';
import { NumberField } from './NumberField';

/**
 * Binds a rigged object's animation states to the clips inside its model.
 *
 * Dropdowns rather than text fields, populated from `AssetManifestEntry.animations` — which the
 * ingest pipeline measured from the source file. Typing a clip name is the version of this panel
 * where every second binding is a typo the author only discovers when the enemy stands still, and
 * the manifest already knows the answer.
 */

const STATE_LABEL: Record<AnimationState, string> = {
  idle: 'Idle',
  walk: 'Walk',
  run: 'Run',
  attack: 'Attack',
  hit: 'Hit reaction',
  die: 'Death',
};

const STATE_HINT: Record<AnimationState, string> = {
  idle: 'Standing still.',
  walk: 'Patrolling a route.',
  run: 'Chasing the player.',
  attack: 'In range and swinging. Loops while it keeps swinging.',
  hit: 'Plays over whatever is running, then hands back.',
  die: 'Plays once and stays on its last frame.',
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

export function AnimationPanel({
  object,
  manifest,
}: {
  object: SceneObject;
  manifest: AssetManifest;
}): React.JSX.Element | null {
  const setAnimation = useSceneStore((state) => state.setAnimation);
  const entry = manifest.assets.find((asset) => asset.id === object.assetId);
  const clips = entry?.animations ?? [];

  // A model with no clips has nothing to bind, and a panel of six empty dropdowns would suggest
  // otherwise. The message says what to do about it rather than just being absent, because
  // "why can't I animate this?" is the question it is standing in for.
  if (clips.length === 0) {
    return (
      <section className="panel" aria-label="Animation">
        <h2>Animation</h2>
        <p className="panel-hint">
          {entry
            ? `${entry.name} has no animation clips. Import a rigged model — a Mixamo character, or any glTF with animations — to animate this.`
            : 'This object has no asset in the library.'}
        </p>
      </section>
    );
  }

  const animation = object.animation;

  return (
    <section className="panel" aria-label="Animation">
      <h2>Animation</h2>

      <label className="param-check">
        <input
          type="checkbox"
          checked={animation !== null}
          onChange={(event) =>
            setAnimation(
              object.id,
              event.target.checked
                ? // Guessed on the way in, because a rig whose clips are called `Idle`, `Walk` and
                  // `Run` should not need six dropdowns set by hand. A guess that misses costs one
                  // correction; no guess costs six.
                  ObjectAnimationSchema.parse({ clips: guessBindings(clips) })
                : null,
            )
          }
        />
        Animate this object
      </label>

      {animation && (
        <>
          {ANIMATION_STATES.map((state) => (
            <label className="param-row" key={state}>
              <span title={STATE_HINT[state]}>
                {STATE_LABEL[state]}
                {STATE_PLAYBACK[state] === 'loop' ? '' : ' (once)'}
              </span>
              <select
                aria-label={`${STATE_LABEL[state]} clip`}
                value={animation.clips[state] ?? ''}
                onChange={(event) =>
                  setAnimation(object.id, {
                    ...animation,
                    clips: {
                      ...animation.clips,
                      // Cleared rather than set to an empty string: the schema treats a missing
                      // state as "this model does not do that", which is what an empty choice means.
                      ...{ [state]: event.target.value || undefined },
                    },
                  })
                }
              >
                <option value="">— none —</option>
                {clips.map((clip) => (
                  <option key={clip} value={clip}>
                    {clip}
                  </option>
                ))}
              </select>
            </label>
          ))}

          <NumberField
            label="Playback speed"
            scrubLabel="Speed"
            value={animation.speed}
            step={0.02}
            // Clamped here as well as in the schema: a scrub drag produces a stream of values, and
            // one out-of-range value would throw on parse rather than simply stopping at the limit.
            onChange={(speed) =>
              setAnimation(object.id, { ...animation, speed: clamp(speed, 0.05, 8) })
            }
          />
          <NumberField
            label="Blend seconds"
            scrubLabel="Blend"
            value={animation.crossfadeSeconds}
            step={0.01}
            suffix="s"
            onChange={(crossfadeSeconds) =>
              setAnimation(object.id, {
                ...animation,
                crossfadeSeconds: clamp(crossfadeSeconds, 0, 2),
              })
            }
          />

          <p className="panel-hint">
            States are driven by the object&rsquo;s behaviours: an enemy&rsquo;s AI supplies idle,
            walk, run, attack and death. A state with no clip is skipped rather than played empty.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * A first guess at which clip belongs to which state.
 *
 * Substring matching on lower-cased names, in a deliberate order: the longest and most specific
 * words first, so `walk` does not claim a clip called `sidewalk_run`. It is allowed to be wrong —
 * every choice is a dropdown the author can change — and being wrong is much cheaper than making
 * somebody bind six states by hand on every character they import.
 *
 * The vocabularies it covers are the ones people actually meet: Mixamo (`Idle`, `Walking`,
 * `Running`, `Punching`, `Hit Reaction`, `Death`), Quaternius (`Idle`, `Walk`, `Run`, `Attack`),
 * and glTF samples (`Survey`, `Walk`, `Gallop`).
 */
export function guessBindings(clips: readonly string[]): Record<string, string> {
  const patterns: [AnimationState, string[]][] = [
    ['die', ['death', 'die', 'dead']],
    ['hit', ['hit', 'flinch', 'impact', 'damage']],
    ['attack', ['attack', 'punch', 'kick', 'swing', 'shoot', 'melee']],
    ['run', ['run', 'sprint', 'gallop']],
    ['walk', ['walk', 'patrol']],
    ['idle', ['idle', 'survey', 'stand', 'rest']],
  ];

  const bindings: Record<string, string> = {};
  const taken = new Set<string>();

  for (const [state, words] of patterns) {
    const match = clips.find(
      (clip) => !taken.has(clip) && words.some((word) => clip.toLowerCase().includes(word)),
    );
    if (match) {
      bindings[state] = match;
      taken.add(match);
    }
  }

  // A rig whose clips are named nothing recognisable still gets an idle, because standing in a
  // rest pose is the one state a character must not be missing.
  if (!bindings['idle'] && clips[0] && !taken.has(clips[0])) bindings['idle'] = clips[0];

  return bindings;
}
