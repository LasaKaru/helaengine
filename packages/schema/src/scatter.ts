import { z } from 'zod';
import { IdSchema } from './primitives.js';

/**
 * Vegetation placed by rule rather than by hand.
 *
 * A field of grass is tens of thousands of blades. Placing them as scene objects would mean tens of
 * thousands of ids, transforms and physics settings in the document — megabytes to describe
 * something nobody positioned individually and nobody will ever edit individually.
 *
 * A scatter layer is the rule instead: an asset, a density, a seed, and the limits on where it may
 * land. A few hundred bytes. The engine expands it at load into the same instanced meshes the
 * placed-object path produces, so everything downstream — wind, culling, the draw-call budget —
 * treats it identically.
 *
 * ## Why a seed and not a stored list of positions
 *
 * Determinism is what makes the rule a *description* rather than a compression scheme. The same
 * document produces the same field in the editor, in an export, and on a teammate's machine, so a
 * level looks the same everywhere without the positions ever being written down. Change the seed
 * and you get a different field; change nothing and nothing moves.
 *
 * The cost is that individual blades cannot be nudged. That is the right trade: an author who wants
 * a specific plant in a specific spot places an object, which is what objects are for.
 */

/** Instances per 100 m² before any filter rejects them. */
export const DENSITY_UNIT_AREA = 100;

/**
 * The most instances one layer may produce, however large the world or high the density.
 *
 * A hard stop rather than a warning. Density is per unit area, so growing the terrain grows the
 * count with it — a setting that looked fine on a 128 m map becomes two million instances on a
 * 2 km one, and the failure mode is a tab that never finishes loading. The cap turns that into a
 * thinner field and a message.
 */
export const MAX_SCATTER_INSTANCES = 40_000;

export const ScatterLayerSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(64).default('Grass'),
  assetId: IdSchema,
  enabled: z.boolean().default(true),

  /** Instances per 100 m² of terrain. */
  density: z.number().min(0).max(400).default(20),
  /**
   * Chooses the field.
   *
   * Any integer gives a different arrangement; the same integer always gives the same one. It is
   * the only part of the layer an author changes when they simply do not like the result.
   */
  seed: z.number().int().min(0).max(2_147_483_647).default(1),

  /** Uniform scale range. Jitter is what stops a field reading as wallpaper. */
  scaleMin: z.number().min(0.05).max(20).default(0.8),
  scaleMax: z.number().min(0.05).max(20).default(1.3),

  /**
   * Steepest ground this will grow on, in degrees.
   *
   * Grass on a cliff face looks wrong in a way that is hard to name and impossible to unsee, and
   * the models are built to stand on flat ground — on a slope they intersect it.
   */
  slopeMax: z.number().min(0).max(90).default(35),

  /** Height band it grows in. The default spans anything the terrain can reach. */
  heightMin: z.number().min(-1000).max(1000).default(-1000),
  heightMax: z.number().min(-1000).max(1000).default(1000),

  /**
   * Restricts it to one painted terrain layer, or null for anywhere.
   *
   * This is what makes scatter answer to the brush: paint sand and the grass retreats from it,
   * without a second mask to maintain. The terrain's four layers are the vocabulary already.
   */
  terrainLayer: z.number().int().min(0).max(3).nullable().default(null),
  /** How dominant that layer must be, 0–1. */
  layerThreshold: z.number().min(0).max(1).default(0.5),

  /**
   * Tilts each instance to match the ground.
   *
   * Off by default, and deliberately so: grass grows upward whatever it is standing on, and tilting
   * it makes a hillside look like it has been combed. Worth it for rocks and debris.
   */
  alignToSlope: z.boolean().default(false),
  /** Random tilt in degrees, for a field that has not been ironed. */
  tiltJitter: z.number().min(0).max(45).default(6),
});
export type ScatterLayer = z.infer<typeof ScatterLayerSchema>;

export const ScatterSchema = z.array(ScatterLayerSchema).max(8).default([]);

/**
 * How many instances a layer will try to make over a given area, before filters.
 *
 * Exposed because the editor has to show it: density is per unit area, so the number that matters —
 * "this is forty thousand blades" — is not visible in any field the author is editing.
 */
export function plannedCount(layer: ScatterLayer, area: number): number {
  if (!layer.enabled) return 0;
  return Math.min(MAX_SCATTER_INSTANCES, Math.floor((layer.density * area) / DENSITY_UNIT_AREA));
}

/** True when the cap is what decided the count, so the editor can say so rather than lie. */
export function isCapped(layer: ScatterLayer, area: number): boolean {
  if (!layer.enabled) return false;
  return Math.floor((layer.density * area) / DENSITY_UNIT_AREA) > MAX_SCATTER_INSTANCES;
}

/**
 * A small deterministic generator, seeded per layer.
 *
 * `Math.random` would make the field different every load — different in the editor from the export,
 * and different for every person opening the same file. Mulberry32 is thirty-two bits of state and
 * good enough for scattering plants, which is a job where "looks unpatterned" is the entire bar.
 */
export function makeRandom(seed: number): () => number {
  let state = (seed + 0x6d2b79f5) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A layer whose limits can never accept anything.
 *
 * Reported rather than left to produce an empty field, because "I set the density to 200 and see no
 * grass" is otherwise a silent mystery. Every one of these is a pair of numbers the author can see
 * and did not mean.
 */
export function scatterProblems(layer: ScatterLayer): string[] {
  const problems: string[] = [];
  if (layer.scaleMin > layer.scaleMax) {
    problems.push(`"${layer.name}": smallest scale is larger than the largest`);
  }
  if (layer.heightMin > layer.heightMax) {
    problems.push(`"${layer.name}": lowest height is above the highest`);
  }
  if (layer.enabled && layer.density === 0) {
    problems.push(`"${layer.name}": density is zero, so nothing will grow`);
  }
  return problems;
}
