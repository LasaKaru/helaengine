import { z } from 'zod';
import { UnsetIdSchema } from './primitives.js';

/**
 * Things that break.
 *
 * A crate that bursts when you shoot it, a fence that comes apart when a car drives through it, a
 * barrel that explodes and knocks over what was standing near it. All of them are the same three
 * questions: how much can it take, what counts as taking it, and what is left afterwards.
 *
 * ## Why fragments are an asset rather than a mesh cut at runtime
 *
 * The tempting version of this feature slices the model into convex pieces when it breaks. Doing it
 * honestly needs a convex decomposition, which is a heavy offline step belonging in the asset
 * pipeline rather than in a frame — and doing it dishonestly, by chopping the bounding box, looks
 * worse than not breaking at all.
 *
 * So a destructible names a *debris asset* it scatters. That is a decision an artist makes once and
 * a level designer reuses, which is the same shape every other asset choice in this engine has. It
 * also keeps the whole feature inside the closed vocabulary: nothing is generated, everything is
 * named.
 */

/**
 * What damages a thing.
 *
 * Separate flags rather than one "destructible" switch, because the two have genuinely different
 * failure modes. A crate that only breaks when shot is a puzzle piece; a crate that also breaks on
 * impact is a hazard, and a bridge railing that breaks on impact but shrugs off bullets is a set
 * piece. Getting the wrong one is the difference between a level that works and one that
 * disassembles itself while the player walks past.
 */
export const DamageSourceSchema = z.enum(['weapons', 'impact']);
export type DamageSource = z.infer<typeof DamageSourceSchema>;

/**
 * What is left when a thing breaks.
 *
 * - `vanish` — it disappears. A pane of glass, a rotten plank, anything whose point is to stop
 *   being in the way.
 * - `swap` — it is replaced by another asset, in place. A wall becoming a broken wall: one model
 *   swapped for another, which is the cheapest convincing break there is.
 * - `fragments` — it is replaced by several dynamic copies of a debris asset, thrown outward. The
 *   expensive one, and the only one that keeps simulating afterwards.
 */
export const BreakEffectSchema = z.enum(['vanish', 'swap', 'fragments']);
export type BreakEffect = z.infer<typeof BreakEffectSchema>;

/**
 * The most fragments one object may leave behind.
 *
 * Twelve, not because the solver cannot hold more but because a level designer who types 200 into a
 * field means "lots" rather than "two hundred rigid bodies with mesh colliders". A cap that bites
 * visibly at authoring time is kinder than a frame rate that collapses in play.
 */
export const MAX_FRAGMENTS = 12;

export const DestructibleSchema = z.object({
  /**
   * How much damage it takes to break.
   *
   * Not called `health`, because it is not a creature and the distinction matters at the call site:
   * a destructible does not heal, does not respawn, and has no notion of being hurt.
   */
  hitPoints: z.number().min(1).max(100_000).default(20),
  /**
   * What can damage it. Empty means nothing can, which is a destructible switched off.
   *
   * Weapons alone by default: impact damage on by default would mean every crate in every existing
   * level started disintegrating the first time something bumped it.
   */
  damagedBy: z.array(DamageSourceSchema).max(2).default(['weapons']),
  /**
   * Impact speed below which a collision does nothing, in metres per second.
   *
   * Without a floor, resting contact registers as a continuous stream of tiny impacts and anything
   * standing on anything else grinds itself to nothing over a few seconds. This is the field that
   * makes `impact` usable at all.
   */
  impactThreshold: z.number().min(0).max(200).default(4),
  /** Damage per metre-per-second of impact above the threshold. */
  impactDamageScale: z.number().min(0).max(1000).default(2),

  effect: BreakEffectSchema.default('vanish'),
  /**
   * The asset that replaces it, for `swap`, or that each fragment is made of, for `fragments`.
   *
   * Empty is legal to store and an error to run — the same treatment a graph node's unchosen
   * dropdown gets. A field that could not be empty would mean the editor had to invent a choice the
   * moment somebody ticked the box, and an invented choice is one nobody reviews.
   */
  debrisAssetId: UnsetIdSchema.default(''),
  fragmentCount: z.number().int().min(1).max(MAX_FRAGMENTS).default(5),
  /** How hard fragments are thrown apart, in metres per second. */
  fragmentSpeed: z.number().min(0).max(50).default(3),
  /** Seconds before fragments are removed, or 0 to leave them. */
  fragmentLifetime: z.number().min(0).max(120).default(8),
  /** Scale applied to each fragment, relative to the debris asset's own size. */
  fragmentScale: z.number().min(0.01).max(10).default(0.4),

  /**
   * An event raised on the bus when it breaks, or empty for none.
   *
   * This is the whole of how a destructible talks to the rest of the game: a graph `On event` node
   * listens for it, a crate that opens a door is a break event and a wire, and a sound is a binding
   * in the Audio panel against this name. Nothing here knows what a door is.
   *
   * There is deliberately no `sfxAssetId` beside it. Every other sound in the engine is a binding
   * from an event to a clip, and a second per-object path would be one the mixer, the rate limiter
   * and the positional logic would each have to learn about separately. `destructibleBroken` is
   * raised for every break, so one binding covers a whole level's worth of crates.
   */
  breakEvent: z.string().max(64).default(''),
});
export type Destructible = z.infer<typeof DestructibleSchema>;

/**
 * Problems that would make a destructible do nothing, or something surprising.
 *
 * Reported rather than thrown, and checked in the editor rather than only at play time: a crate
 * that silently refuses to break is indistinguishable from a crate somebody forgot to set up.
 */
export function destructibleProblems(
  destructible: Destructible,
  knownAssets: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];

  if (destructible.damagedBy.length === 0) {
    problems.push('nothing can damage this — tick weapons, impact, or both');
  }

  if (destructible.effect !== 'vanish') {
    if (destructible.debrisAssetId === '') {
      problems.push(
        destructible.effect === 'swap'
          ? 'no asset chosen to replace it with'
          : 'no asset chosen for the fragments',
      );
    } else if (!knownAssets.has(destructible.debrisAssetId)) {
      problems.push(`"${destructible.debrisAssetId}" is not an asset this project has`);
    }
  }

  if (destructible.damagedBy.includes('impact') && destructible.impactThreshold === 0) {
    // Resting contact registers as a stream of tiny impacts, so anything standing on anything else
    // grinds itself to nothing within seconds — and it looks like a bug in the physics, not a
    // setting somebody chose.
    problems.push('an impact threshold of zero means resting on the ground breaks it');
  }

  return problems;
}

/**
 * Damage a collision does, or zero for one too gentle to count.
 *
 * Speed rather than momentum: mass is often unset and derived from the collider's volume, so
 * scaling by it would make an identical crash do different damage depending on whether somebody had
 * filled in a field. Speed is the quantity the author can see.
 */
export function impactDamage(destructible: Destructible, speed: number): number {
  if (!destructible.damagedBy.includes('impact')) return 0;
  const over = speed - destructible.impactThreshold;
  return over <= 0 ? 0 : over * destructible.impactDamageScale;
}

/** Asset ids a destructible needs the project to have, so a preload can fetch them. */
export function destructibleAssets(destructible: Destructible): string[] {
  const wanted: string[] = [];
  if (destructible.effect !== 'vanish' && destructible.debrisAssetId !== '') {
    wanted.push(destructible.debrisAssetId);
  }
  return wanted;
}

export const OptionalDestructibleSchema = DestructibleSchema.nullable().default(null);

/** A convenience for the editor's "make this breakable" button. */
export function defaultDestructible(): Destructible {
  return DestructibleSchema.parse({});
}
