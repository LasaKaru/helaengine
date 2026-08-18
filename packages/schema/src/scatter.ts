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

  /**
   * How much this gathers into patches, 0–1.
   *
   * Zero is a jittered grid — evenly spread, nothing clumping, which is the right answer for a
   * mown lawn and the wrong one for everything else. Real ground is patchy: grass thickens where
   * the soil is good and thins where it is not, and the eye reads that unevenness as *growth*
   * rather than as placement. A perfectly even field is the single strongest tell that a meadow was
   * generated.
   *
   * Zero by default, so every layer authored before this looks exactly as it did.
   */
  clumping: z.number().min(0).max(1).default(0),
  /** How wide a patch is, in metres, from the middle of a thick part to the middle of a thin one. */
  clumpSize: z.number().min(0.5).max(40).default(4),

  /**
   * How much each instance's colour varies from its neighbours', 0–1.
   *
   * A field where every blade is exactly the same green reads as one object repeated, because it
   * is. A few percent of variation in brightness is enough to break that up completely, and it
   * costs one colour per instance rather than one material per plant.
   *
   * Zero by default — no instance colours are written at all, so the batch is the same batch it was.
   */
  colorJitter: z.number().min(0).max(1).default(0),
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

/**
 * A deterministic value in [0, 1) for a point on the grid, without touching the random sequence.
 *
 * This is the whole reason clumping and colour variation could be added at all.
 *
 * `buildScatter` draws a fixed run of numbers per candidate, and every one of those draws is load-
 * bearing: the sequence is what makes the field the same in the editor, in an export and on a
 * teammate's machine. Adding a sixth draw would shift every candidate after the first — every
 * existing meadow in every existing project would rearrange itself, silently, on the load after
 * this shipped. Drawing it only when the feature is switched on is no better: it makes the field
 * jump the moment somebody nudges a slider off zero.
 *
 * Hashing the cell coordinates instead consumes nothing. A layer with clumping at zero produces the
 * identical sequence of identical instances it always did, and a layer that turns it on gets a
 * stable answer per cell that does not depend on what any other cell decided.
 *
 * `salt` separates independent questions asked about the same cell — "is this a thick patch" and
 * "what shade is this one" must not be the same number, or every plant in a thick patch would also
 * be the same colour.
 */
export function cellHash(seed: number, cx: number, cz: number, salt: number): number {
  let hash = (seed ^ 0x9e3779b9) >>> 0;
  hash = Math.imul(hash ^ (cx + 0x85ebca6b), 0xcc9e2d51) >>> 0;
  hash = Math.imul(hash ^ (cz + 0xc2b2ae35), 0x1b873593) >>> 0;
  hash = Math.imul(hash ^ (salt + 0x27d4eb2f), 0x85ebca6b) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491) >>> 0;
  return ((hash ^ (hash >>> 13)) >>> 0) / 4294967296;
}

/**
 * How thick the patch is at a point, 0–1, over a lattice of `size` metres.
 *
 * Smooth value noise rather than a per-cell hash, and the difference is the entire effect: a hash
 * gives every cell an independent answer, which is not patchiness — it is the uniform field again
 * with a random subset removed. A patch has to be *wide*, so neighbouring points must agree, which
 * means interpolating between lattice corners.
 *
 * Smoothstepped between corners rather than lerped, because a linear blend leaves visible creases
 * along the lattice lines — a meadow with a faint grid in it, which is precisely the artefact
 * clumping exists to remove.
 */
export function clumpDensity(seed: number, x: number, z: number, size: number): number {
  const span = Math.max(0.5, size);
  const gx = x / span;
  const gz = z / span;
  const x0 = Math.floor(gx);
  const z0 = Math.floor(gz);
  const fx = gx - x0;
  const fz = gz - z0;

  const ease = (t: number): number => t * t * (3 - 2 * t);
  const ex = ease(fx);
  const ez = ease(fz);

  const c00 = cellHash(seed, x0, z0, 101);
  const c10 = cellHash(seed, x0 + 1, z0, 101);
  const c01 = cellHash(seed, x0, z0 + 1, 101);
  const c11 = cellHash(seed, x0 + 1, z0 + 1, 101);

  const top = c00 + (c10 - c00) * ex;
  const bottom = c01 + (c11 - c01) * ex;
  return top + (bottom - top) * ez;
}

/**
 * Whether a candidate at this point survives the layer's clumping.
 *
 * At zero the threshold is 1 and everything survives, which is what makes an existing layer
 * identical. At 1 it is the noise itself, so the field follows the patches exactly.
 */
export function clumpAccepts(layer: ScatterLayer, x: number, z: number, roll: number): boolean {
  if (layer.clumping <= 0) return true;
  const density = clumpDensity(layer.seed, x, z, layer.clumpSize);
  return roll <= 1 - layer.clumping + layer.clumping * density;
}

/**
 * How much to over-plan so clumping thins the field without emptying it.
 *
 * Clumping rejects candidates, and an author moving the slider does not expect the meadow to lose
 * half its plants — they expect the same amount of grass, gathered differently. The noise averages
 * a half, so the acceptance rate averages `1 - clumping/2`, and planning that many more candidates
 * puts the count back where it was.
 */
export function clumpDensityScale(layer: ScatterLayer): number {
  return 1 / (1 - layer.clumping * 0.5);
}
