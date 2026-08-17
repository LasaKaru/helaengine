import { z } from 'zod';

/**
 * Surfaces: the detail a low-poly model does not carry in its geometry.
 *
 * ## Why this exists
 *
 * A wall in this engine is a box with about twelve triangles. Lighting it well makes it a
 * *convincingly lit* box, and nothing more — the thing that separates a wall from a slab is that a
 * wall has bricks in it, and bricks are a surface property rather than a shape. The realistic look
 * preset already says as much in its own documentation: no lighting preset can invent a roughness
 * map that the shipped models do not have.
 *
 * So a surface is a set of PBR maps — normal, roughness, metalness and ambient occlusion — applied
 * to a placed object, generated in code from a named kind. Brick, tile, planks, stone. The geometry
 * is untouched; what changes is how the light comes off it, which is where almost all of the
 * perceived detail in a modern game actually lives.
 *
 * ## Why the maps are generated rather than shipped
 *
 * A texture set per kind is a few megabytes of PNGs in every export, before anybody has placed
 * anything. Generated maps are a few hundred lines of arithmetic that produce identical bytes on
 * every machine, cost nothing to download, and — because they are functions of a kind and a scale
 * rather than files — can be shared by every object that asks for the same pair. Fifty brick walls
 * are one texture set.
 *
 * The trade is real and worth stating: these are procedural patterns, not photographs. Brick here
 * is a regular running bond, not a scanned Victorian wall. It reads correctly at gameplay distance
 * and it will not survive a close-up. An asset that ships its own scanned maps keeps them —
 * `materialMaps` on the manifest entry records which, and the editor says so before a surface
 * replaces them.
 *
 * ## Why scale is a word and not a number
 *
 * The obvious design is `tiling: number`, and it is a trap. Each distinct value needs its own
 * generated texture set, and a slider produces a new one every frame it is dragged — a minute of
 * fiddling with one wall leaves a hundred texture sets on the GPU, all but one of them unreachable.
 * Refcounting them would be a second answer to "who frees this", which this codebase deliberately
 * only ever has one of.
 *
 * Three named scales close the vocabulary, and the cache is then bounded by construction: kinds
 * times scales, generated once, freed with the scene. It also happens to be the better editor —
 * "coarse" is a decision an author can make, whereas 3.7 is a number they have to discover.
 */

export const SURFACE_KINDS = [
  'brick',
  'tile',
  'plank',
  'stone',
  'plaster',
  'concrete',
  'metal',
] as const;
export const SurfaceKindSchema = z.enum(SURFACE_KINDS);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const SURFACE_LABELS: Readonly<Record<SurfaceKind, string>> = {
  brick: 'Brick',
  tile: 'Tile',
  plank: 'Planks',
  stone: 'Stone',
  plaster: 'Plaster',
  concrete: 'Concrete',
  metal: 'Metal',
};

export const SURFACE_HINTS: Readonly<Record<SurfaceKind, string>> = {
  brick: 'Running bond with recessed mortar. Walls, chimneys, the base of a building.',
  tile: 'A square grid with grouted joints. Floors, bathrooms, plazas.',
  plank: 'Long boards with grain and gaps between them. Decking, crates, fences.',
  stone: 'Irregular blocks with deep joints. Castle walls, cliffs, foundations.',
  plaster: 'Fine render with a gentle unevenness. Interiors, rendered exteriors.',
  concrete: 'Coarse and pitted, with form marks. Bunkers, kerbs, industrial floors.',
  metal: 'Brushed and reflective. Machinery, containers, anything meant to be shiny.',
};

/**
 * How large the pattern is on the object.
 *
 * The multiplier is how many times the generated pattern repeats across the object's UVs, so a
 * kind's own tile density is baked into its generator and this only stretches it. Deliberately a
 * short list — see the header.
 */
export const SURFACE_SCALES = ['fine', 'normal', 'coarse'] as const;
export const SurfaceScaleSchema = z.enum(SURFACE_SCALES);
export type SurfaceScale = z.infer<typeof SurfaceScaleSchema>;

export const SURFACE_SCALE_LABELS: Readonly<Record<SurfaceScale, string>> = {
  fine: 'Fine',
  normal: 'Normal',
  coarse: 'Coarse',
};

/** How many times the generated pattern repeats across the object. */
export const SURFACE_SCALE_REPEAT: Readonly<Record<SurfaceScale, number>> = {
  fine: 3,
  normal: 1,
  coarse: 0.4,
};

/**
 * The shading a kind implies when nothing overrides it.
 *
 * Applied *before* the object's own roughness and metalness, so an author who has set either keeps
 * it: a surface says what brick is normally like, and an explicit number says what this brick is
 * like. Getting that order the other way round would make the roughness field silently stop working
 * the moment somebody ticked a surface.
 */
export interface SurfacePreset {
  readonly roughness: number;
  readonly metalness: number;
}

export const SURFACE_PRESETS: Readonly<Record<SurfaceKind, SurfacePreset>> = {
  brick: { roughness: 0.94, metalness: 0 },
  tile: { roughness: 0.35, metalness: 0 },
  plank: { roughness: 0.78, metalness: 0 },
  stone: { roughness: 0.92, metalness: 0 },
  plaster: { roughness: 0.88, metalness: 0 },
  concrete: { roughness: 0.96, metalness: 0 },
  metal: { roughness: 0.32, metalness: 1 },
};

export const SurfaceSchema = z.object({
  kind: SurfaceKindSchema,
  scale: SurfaceScaleSchema.default('normal'),
  /**
   * How deeply the pattern appears to be cut into the surface.
   *
   * A material float rather than a texture parameter — it scales the normal map on the way into the
   * shader — so it is free to change and needs nothing regenerated. Zero is flat: the maps are still
   * bound, and the surface still changes the roughness, but the light comes off it as though the
   * wall were smooth.
   */
  depth: z.number().min(0).max(2).default(1),
  /** How dark the creases go. The ambient-occlusion map's strength. */
  occlusion: z.number().min(0).max(1).default(1),
});
export type Surface = z.infer<typeof SurfaceSchema>;

export function defaultSurface(kind: SurfaceKind = 'brick'): Surface {
  return SurfaceSchema.parse({ kind });
}

/**
 * What is wrong with a surface, in the author's terms.
 *
 * `mapped` is what the asset's own material already carries, from the manifest. The overlap matters
 * because it is invisible otherwise: an asset that ships a scanned normal map loses it to a
 * generated one, and the only symptom is that the detail got worse.
 *
 * None of these stop anything working — they are the things an author cannot see from the document
 * and would otherwise have to deduce from a wall that came out wrong.
 */
export function surfaceProblems(
  surface: Surface,
  mapped: readonly string[] = [],
  projectedUvs = false,
): string[] {
  const problems: string[] = [];

  if (projectedUvs) {
    problems.push(
      'this model has no texture coordinates of its own, so the pattern is projected from its ' +
        'box — stretching the object unevenly will stretch the pattern with it',
    );
  }

  if (mapped.includes('normal')) {
    problems.push(
      `this asset ships its own normal map, which the ${SURFACE_LABELS[
        surface.kind
      ].toLowerCase()} surface replaces`,
    );
  }

  if (surface.depth === 0 && surface.occlusion === 0) {
    problems.push(
      'depth and occlusion are both zero, so the pattern is bound but invisible — ' +
        'only the roughness changes',
    );
  }

  return problems;
}
