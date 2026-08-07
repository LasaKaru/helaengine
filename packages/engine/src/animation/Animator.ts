import * as THREE from 'three';
import {
  DEFAULT_CROSSFADE_SECONDS,
  STATE_PLAYBACK,
  type AnimationState,
  type ObjectAnimation,
} from '@helaengine/schema';

/**
 * Plays one rigged object's animation, driven by a named state rather than by a clip.
 *
 * The whole point of the indirection is that callers say what the object is *doing* — the AI knows
 * it is chasing, the controller knows the player is walking — and this decides what that looks
 * like. Nothing outside here touches an `AnimationAction`.
 *
 * One of these exists per placed object, not per asset. Two skeletons sharing one mixer is the bug
 * that makes every enemy in a scene move in lockstep.
 */
export class Animator {
  readonly #mixer: THREE.AnimationMixer;
  readonly #actions = new Map<AnimationState, THREE.AnimationAction>();
  readonly #crossfade: number;

  /**
   * The looping state to return to after an interruption.
   *
   * Tracked separately from `#current` because a flinch is not a change of what the character is
   * doing — an enemy hit while running is still running, and has to still be running when the
   * flinch ends.
   */
  #base: AnimationState;
  /**
   * The last looping state that actually had a clip and played.
   *
   * Distinct from `#base`, which is what the object *is doing*. They differ whenever a state is
   * requested that the model has no clip for — and if an interruption handed back to `#base` in
   * that case, the transition would be refused and the character would stand frozen on the last
   * frame of its flinch. Which is the exact failure this class exists to avoid.
   */
  #resume: AnimationState | null = null;
  #current: AnimationState | null = null;
  #dead = false;

  /** Clip names asked for that the model does not contain. Surfaced rather than swallowed. */
  readonly missing: readonly string[];

  constructor(
    root: THREE.Object3D,
    clips: readonly THREE.AnimationClip[],
    config: ObjectAnimation,
  ) {
    this.#mixer = new THREE.AnimationMixer(root);
    this.#crossfade = config.crossfadeSeconds ?? DEFAULT_CROSSFADE_SECONDS;
    this.#base = config.defaultState;

    const missing: string[] = [];
    for (const [state, clipName] of Object.entries(config.clips)) {
      if (!clipName) continue;
      const clip = clips.find((candidate) => candidate.name === clipName);
      if (!clip) {
        missing.push(clipName);
        continue;
      }

      const action = this.#mixer.clipAction(clip);
      if (STATE_PLAYBACK[state as AnimationState] === 'loop') {
        action.setLoop(THREE.LoopRepeat, Infinity);
      } else {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.#actions.set(state as AnimationState, action);
    }

    this.missing = missing;
    this.#mixer.timeScale = config.speed;
    this.#mixer.addEventListener('finished', this.#onFinished);
    this.play(this.#base);
  }

  /** The state currently playing, or null if nothing has been played yet. */
  get state(): AnimationState | null {
    return this.#current;
  }

  /** The looping state an interruption will return to. */
  get baseState(): AnimationState {
    return this.#base;
  }

  /** Whether a state has a clip bound and present in the model. */
  has(state: AnimationState): boolean {
    return this.#actions.has(state);
  }

  /**
   * Switches to `state`.
   *
   * Two rules that are easier to state than to infer from the code:
   *
   * A state with no clip is **ignored rather than obeyed**. A model with only `idle` and `walk`
   * should keep walking when the AI starts an attack, not snap to a rest pose. Half-rigged models
   * are the normal case in a low-poly library, and continuing to move is the graceful answer.
   *
   * Once `die` has played, nothing else is accepted. Death arrives through the same channel as
   * every other state, and a corpse that gets told to walk because a stale behaviour ticked once
   * more would stand up — which is a bug seen in shipped games rather than a hypothetical.
   */
  play(state: AnimationState): void {
    if (this.#dead) return;
    if (STATE_PLAYBACK[state] === 'terminal') this.#dead = true;
    // Remembered even if there is no clip for it, so a model that gains a `run` clip later returns
    // to running rather than to whatever it could play at the time.
    else if (STATE_PLAYBACK[state] === 'loop') this.#base = state;

    this.#transitionTo(state);
  }

  #transitionTo(state: AnimationState): void {
    if (state === this.#current) return;
    const next = this.#actions.get(state);
    if (!next) return;

    const previous = this.#current === null ? undefined : this.#actions.get(this.#current);
    this.#current = state;
    if (STATE_PLAYBACK[state] === 'loop') this.#resume = state;

    // Reset before fading in, or a one-shot that already finished stays on its last frame and
    // never plays again — the second flinch of any enemy's life.
    next.reset().setEffectiveWeight(1).play();

    if (previous && previous !== next) previous.crossFadeTo(next, this.#crossfade, false);
    else next.fadeIn(previous ? this.#crossfade : 0);
  }

  /**
   * Hands control back to the looping state when an interruption ends.
   *
   * An arrow property rather than a method, because it is registered as a listener and `three`
   * calls it unbound.
   */
  readonly #onFinished = (event: { action: THREE.AnimationAction }): void => {
    if (this.#dead) return;
    const finished = this.#current;
    if (finished === null || STATE_PLAYBACK[finished] !== 'interrupt') return;
    if (this.#actions.get(finished) !== event.action) return;

    this.#transitionTo(this.#base);
    // Refused, because the base state has no clip in this model. Fall back to whatever was
    // visibly playing before the interruption rather than leaving the flinch clamped forever.
    if (this.#current === finished && this.#resume !== null) this.#transitionTo(this.#resume);
  };

  update(deltaSeconds: number): void {
    this.#mixer.update(deltaSeconds);
  }

  /**
   * Frees the mixer's own state.
   *
   * The clips and the object tree are not this class's to free — clips are shared across every
   * instance of an asset, and the tree belongs to the scene loader.
   */
  dispose(): void {
    this.#mixer.removeEventListener('finished', this.#onFinished);
    this.#mixer.stopAllAction();
    this.#mixer.uncacheRoot(this.#mixer.getRoot() as THREE.Object3D);
    this.#actions.clear();
    this.#current = null;
  }
}
