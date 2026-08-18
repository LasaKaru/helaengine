import type { Water } from '@helaengine/schema';

/**
 * What water does to something moving through it.
 *
 * ## Floating is an equilibrium, not a state
 *
 * There is no "in the water" flag here. Everything is driven by *how much* of the body is below the
 * surface, and the lift is proportional to that fraction — which is the whole of Archimedes and, it
 * turns out, the whole of the behaviour anyone wants. A crate dropped in sinks past the surface,
 * the lift grows as more of it goes under, and it settles at the depth where lift equals weight. It
 * bobs on the way there because it overshoots, and it stops bobbing because of drag. Nobody wrote
 * "bob"; it is what the two forces do.
 *
 * The alternative — snap the object to the surface when it touches water — is a line of code and
 * looks like a line of code: things teleport, a wave does not lift them, and a heavy object floats
 * exactly as high as a light one.
 *
 * ## Strength is a multiple of weight, so 1 is neutral
 *
 * `buoyancyStrength` is how hard a *fully submerged* body is pushed up, as a multiple of its own
 * weight. At 1 the two cancel and the body hangs wherever it is left, which is what a diver's
 * weight belt is for. Above 1 it rises, below 1 it sinks — a stone is 0.4, not a special case.
 *
 * At the default 1.15 a body settles with about an eighth of itself above the water, because that
 * is the fraction at which `strength × submersion` reaches 1. That number is not written down
 * anywhere; it falls out.
 *
 * ## Drag is damped implicitly where it can be
 *
 * For the character controller — which integrates its own velocity — drag divides rather than
 * subtracts: `v / (1 + drag·step)`. Subtracting `v·drag·step` is the obvious form and is unstable
 * once `drag·step` passes 2, at which point the swimmer oscillates with growing amplitude and then
 * leaves the level. Dividing cannot overshoot zero however large the coefficient gets.
 *
 * Rigid bodies cannot use that form: their velocity belongs to Rapier's own integrator, so they get
 * an impulse of `-v·drag·submersion·mass·step` and the same explicit behaviour it implies. What
 * bounds them is the schema — `drag` caps at 10 against a fixed sixtieth-of-a-second step, so the
 * product is 0.17 where trouble starts at 2.
 */

/**
 * How much of an upright body of `height` sits below `surfaceY`, from 0 to 1.
 *
 * `baseY` is the bottom, matching the pivot convention used everywhere else in the engine — a scene
 * object's transform is at its feet, not its middle.
 */
export function submergedFraction(baseY: number, height: number, surfaceY: number): number {
  if (height <= 0) return surfaceY >= baseY ? 1 : 0;
  const depth = surfaceY - baseY;
  if (depth <= 0) return 0;
  if (depth >= height) return 1;
  return depth / height;
}

/**
 * Net upward acceleration, in metres per second squared, on a body this far submerged.
 *
 * Net: gravity is already subtracted, so this is the whole vertical story and the caller does not
 * apply gravity twice. Negative for a dense body, which is a sinking object rather than an error.
 */
export function buoyantAcceleration(submersion: number, gravity: number, water: Water): number {
  return gravity * water.buoyancyStrength * submersion - gravity;
}

/**
 * The factor a velocity is multiplied by after one step of drag.
 *
 * Always between 0 and 1, whatever the coefficient — see the note above about why this divides
 * instead of subtracting.
 */
export function dragFactor(submersion: number, water: Water, step: number): number {
  if (submersion <= 0 || water.drag <= 0 || step <= 0) return 1;
  return 1 / (1 + water.drag * submersion * step);
}

/**
 * How deep a swimmer has to be before they are swimming rather than wading.
 *
 * Roughly chest height. Below this the character keeps walking on the bottom, which is what a
 * player expects of a shallow ford — swimming across a stream that comes up to your knees reads as
 * a bug, and a threshold at the feet would trigger it every time somebody stepped in a puddle.
 */
export const SWIM_SUBMERSION = 0.6;

export function isSwimming(submersion: number): boolean {
  return submersion >= SWIM_SUBMERSION;
}

/**
 * One step of a swimmer's vertical velocity.
 *
 * `ascend` is the swim-up input — the jump button, underwater. There is no matching descend: a
 * player who wants to go down stops pressing up and sinks, which is both true and one fewer key to
 * explain.
 */
export function swimVerticalVelocity(
  velocity: number,
  submersion: number,
  gravity: number,
  water: Water,
  step: number,
  ascend: boolean,
): number {
  const stroke = ascend ? gravity * 0.55 : 0;
  const next = velocity + (buoyantAcceleration(submersion, gravity, water) + stroke) * step;
  return next * dragFactor(submersion, water, step);
}

/**
 * How much of their walking speed a swimmer keeps.
 *
 * Water is not a slow-walk modifier — it is the same drag acting on the same body, so the number
 * comes from the same coefficient rather than from a second slider nobody would know to keep in
 * step with the first.
 */
export function swimSpeedFactor(submersion: number, water: Water): number {
  return 1 / (1 + water.drag * submersion * 0.25);
}
