import { z } from 'zod';

/**
 * Wind, as a property of the level rather than of each plant.
 *
 * One field the whole world reads. The alternative — a sway setting per object — makes a forest
 * where every tree moves to its own rhythm, which reads as broken rather than as varied. Real
 * variation comes from *phase*, and phase comes free from where a thing is standing.
 *
 * Nothing here animates by itself. `strength` at zero is not a wind blowing nothing, it is the
 * absence of one: no shader is patched and no uniform is updated, so a level that does not want
 * wind pays for none of it.
 */

export const SWAY_GROUPS = ['trees', 'plants', 'grass'] as const;
export const SwayGroupSchema = z.enum(SWAY_GROUPS);
export type SwayGroup = z.infer<typeof SwayGroupSchema>;

export const WindSchema = z.object({
  /**
   * How far a two-metre plant leans at the top, in metres.
   *
   * A distance in the world rather than a 0–1 dial, because a dial would move a blade of grass and
   * an oak by the same fraction of nothing. Zero switches the whole system off.
   */
  strength: z.number().min(0).max(4).default(0),
  /** Where it blows *towards*, in degrees clockwise from north. */
  direction: z.number().min(0).max(360).default(45),
  /** Sways per second. Slow reads as a breeze; fast reads as a storm, or as a bug. */
  speed: z.number().min(0.05).max(4).default(0.6),
  /**
   * How much the strength varies over time, 0–1.
   *
   * Zero is an electric fan: a perfectly even sway the eye picks out as artificial within seconds.
   * The default breaks the rhythm without making the world look unstable.
   */
  gustiness: z.number().min(0).max(1).default(0.4),
  /** Which groups of vegetation move. See `swayGroupFor` for how a model lands in a group. */
  affects: z
    .array(SwayGroupSchema)
    .max(3)
    .default([...SWAY_GROUPS]),
});
export type Wind = z.infer<typeof WindSchema>;

export const NO_WIND: Wind = {
  strength: 0,
  direction: 45,
  speed: 0.6,
  gustiness: 0.4,
  affects: [...SWAY_GROUPS],
};

/** Whether the wind does anything at all. */
export function windIsActive(wind: Wind): boolean {
  return wind.strength > 0 && wind.affects.length > 0;
}

/**
 * The wind direction as a unit vector on the ground plane.
 *
 * Compass degrees in, three.js axes out. An author saying "the wind blows north-east" should not
 * have to know which way this engine points z. North is -z — the direction a default camera looks
 * — and the angle runs clockwise from there, which is what a compass does.
 */
export function windVector(wind: Wind): [number, number] {
  const radians = (wind.direction * Math.PI) / 180;
  return [Math.sin(radians), -Math.cos(radians)];
}

/**
 * How hard each group moves, relative to `strength`.
 *
 * Grass whips and trees lean: giving them the same amplitude makes either the grass look frozen or
 * the trees look like they are made of rubber. These are the numbers that make one wind setting
 * look right across a whole scene, which is the entire reason wind is one field and not four
 * hundred.
 */
export const SWAY_AMPLITUDE: Readonly<Record<SwayGroup, number>> = {
  grass: 1.6,
  plants: 1.0,
  trees: 0.55,
};

/** Word fragments in an asset id that mean "this is dead wood and does not wave". */
const RIGID_PARTS = ['trunk', 'stump', 'log', 'plank', 'resource_wood', 'workbench'];

/** Fragments that mean grass-like: thin, light, and moves a lot. */
const GRASS_PARTS = [
  'grass',
  'flower',
  'crop',
  'wheat',
  'leafs',
  'lily',
  'moss',
  'plant_flat',
  'bamboo',
];

/** Fragments that mean a shrub or a stalk: some give, but not much. */
const PLANT_PARTS = ['bush', 'mushroom', 'cactus', 'plant', 'hanging'];

/**
 * Which sway group a model belongs to, or null for "does not move".
 *
 * A rule over the asset id rather than its category, because the categories cannot answer this.
 * `trees` holds grass, flowers, crops and mushrooms as well as oaks — and it also holds `log` and
 * `tree_trunk`, which are felled wood and must stand perfectly still. Reading the id is not elegant,
 * but it is honest about where the information actually is, and every case it gets wrong is fixable
 * with the per-object override rather than by editing this list.
 *
 * Order matters: rigid wins over everything, then grass, then plants, then trees. `tree_trunk`
 * contains both `trunk` and `tree`, and the first answer is the right one.
 */
export function swayGroupFor(assetId: string, category: string): SwayGroup | null {
  if (category !== 'trees' && category !== 'plants' && category !== 'grass') return null;

  const id = assetId.toLowerCase();
  if (RIGID_PARTS.some((part) => id.includes(part))) return null;
  if (GRASS_PARTS.some((part) => id.includes(part))) return 'grass';
  if (PLANT_PARTS.some((part) => id.includes(part))) return 'plants';
  return 'trees';
}

/** The sway group actually used for an object, honouring its override. */
export function resolveSway(
  wind: Wind,
  override: SwayOverride,
  assetId: string,
  category: string,
): SwayGroup | null {
  if (!windIsActive(wind)) return null;
  if (override === 'none') return null;

  const group = override === 'auto' ? swayGroupFor(assetId, category) : override;
  if (group === null) return null;
  return wind.affects.includes(group) ? group : null;
}

/**
 * A per-object answer to "does this move, and how much".
 *
 * `auto` is the rule above, and is what every object gets unless somebody says otherwise. The rest
 * exist because a rule over asset ids will be wrong sometimes — a potted plant indoors should not
 * sway, and a prop somebody imported as `decor_042` should be allowed to.
 */
export const SWAY_OVERRIDES = ['auto', 'none', ...SWAY_GROUPS] as const;
export const SwayOverrideSchema = z.enum(SWAY_OVERRIDES);
export type SwayOverride = z.infer<typeof SwayOverrideSchema>;
