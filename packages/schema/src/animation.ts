import { z } from 'zod';

/**
 * What a character can be doing, as a closed vocabulary.
 *
 * The design decision here is that a scene names **states**, not clips. An object says "my `run`
 * state is the clip called `Gallop`"; nothing in a document ever says "play frame 40 of clip 3".
 * Three things follow from that, and they are why it is worth the indirection:
 *
 * - **The engine drives animation, not the author.** The AI already has an `idle | patrol | chase |
 *   attack | dead` state machine and the player controller already knows whether it is walking.
 *   Mapping those onto named states means an enemy animates correctly the moment it is given a
 *   rigged model, with no extra authoring.
 * - **Models are swappable.** Two rigs from different packs never share clip names — Mixamo calls
 *   it `mixamo.com`, Quaternius calls it `Run`, the Khronos fox calls it `Gallop`. The binding is
 *   per asset, so replacing a model is a manifest change rather than a scene-wide search.
 * - **It stays data.** A state name from a fixed list and a clip name that is looked up, not
 *   executed. The same property every other part of this schema has.
 *
 * Six states rather than twenty: these are the ones the runtime can actually infer today. A state
 * nothing drives is a field authors have to fill in for no effect.
 */
export const ANIMATION_STATES = ['idle', 'walk', 'run', 'attack', 'hit', 'die'] as const;
export const AnimationStateSchema = z.enum(ANIMATION_STATES);
export type AnimationState = z.infer<typeof AnimationStateSchema>;

/**
 * How each state behaves once started. Three kinds, because they are genuinely different.
 *
 * - `loop` — plays until something else is asked for. Idle, walk, run, and **attack**: an enemy
 *   stays in its attack state for as long as it is swinging, so a looping swing matches the
 *   attack cadence. A one-shot attack would play once and freeze mid-blow while the enemy carried
 *   on hitting.
 * - `interrupt` — plays over the top and hands back to whatever was looping. This is what makes
 *   `hit` usable at all: a flinch that ended by leaving the character frozen mid-flinch would be
 *   worse than no flinch.
 * - `terminal` — plays once and holds the last frame, permanently. Only death. A death that
 *   loops is a corpse standing back up.
 */
export const STATE_PLAYBACK: Readonly<Record<AnimationState, 'loop' | 'interrupt' | 'terminal'>> = {
  idle: 'loop',
  walk: 'loop',
  run: 'loop',
  attack: 'loop',
  hit: 'interrupt',
  die: 'terminal',
};

export function isLoopingState(state: AnimationState): boolean {
  return STATE_PLAYBACK[state] === 'loop';
}

/**
 * How long a change of state takes to blend, in seconds.
 *
 * Not zero, and the reason is visible rather than theoretical: cutting between two clips snaps
 * every joint at once, which reads as a glitch even at 60fps. A fifth of a second is the usual
 * default in engines that expose this at all.
 */
export const DEFAULT_CROSSFADE_SECONDS = 0.2;

/**
 * Which clip in the model plays for each state.
 *
 * Every entry optional, and a missing one is not an error: a model with only an idle animation is a
 * perfectly good prop, and the runtime holds the last state it could play rather than snapping to
 * a rest pose. `AssetManifestEntry.animations` lists what a given model actually offers, so the
 * editor can present this as a set of dropdowns instead of free text.
 */
export const AnimationClipBindingSchema = z.object({
  idle: z.string().max(200).optional(),
  walk: z.string().max(200).optional(),
  run: z.string().max(200).optional(),
  attack: z.string().max(200).optional(),
  hit: z.string().max(200).optional(),
  die: z.string().max(200).optional(),
});
export type AnimationClipBinding = z.infer<typeof AnimationClipBindingSchema>;

export const ObjectAnimationSchema = z.object({
  clips: AnimationClipBindingSchema.default({}),
  /** Playback rate multiplier. Slows a sprint cycle down for a lumbering enemy. */
  speed: z.number().min(0.05).max(8).default(1),
  crossfadeSeconds: z.number().min(0).max(2).default(DEFAULT_CROSSFADE_SECONDS),
  /**
   * The state to hold when nothing is driving this object.
   *
   * Scenery — a torch, a flag, a waterfall — has no AI and no controller, so without this it would
   * stand still. With it, an animated prop is a model plus one line of scene document.
   */
  defaultState: AnimationStateSchema.default('idle'),
});
export type ObjectAnimation = z.infer<typeof ObjectAnimationSchema>;

/**
 * Maps the enemy AI's own state machine onto animation states.
 *
 * Kept here rather than inside the behaviour so that the two vocabularies are visibly related and
 * a new AI state cannot quietly gain no animation. `patrol` is a walk and `chase` is a run, which
 * is the whole reason the animation vocabulary distinguishes them.
 */
export const AI_STATE_ANIMATION: Readonly<Record<string, AnimationState>> = {
  idle: 'idle',
  patrol: 'walk',
  chase: 'run',
  attack: 'attack',
  dead: 'die',
};
