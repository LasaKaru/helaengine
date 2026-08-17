import { z } from 'zod';

/**
 * Level of detail: drawing distant things with fewer triangles.
 *
 * ## Why it is off by default
 *
 * Because every new field has to leave old documents rendering exactly as they did, and level of
 * detail changes the picture — subtly, at distance, but it changes it. A scene saved before this
 * existed opens drawing every triangle it always drew.
 *
 * That is a rule about defaults rather than a judgement about the feature. On a level with real
 * geometry in it, `balanced` is the setting to use.
 *
 * ## Why the levels are generated rather than authored
 *
 * The alternative is asking artists for three versions of every model, which is the industry
 * standard and is also why most hobby projects have no level of detail at all. Generating them at
 * load costs a few milliseconds per distinct mesh, applies to models imported from somebody's own
 * machine — which no pipeline step could — and adds nothing whatsoever to the download.
 *
 * The trade, stated rather than hidden: a generated coarse mesh is worse than one an artist made.
 * Vertex clustering does not know that a silhouette matters more than an interior, so a decimated
 * cylinder becomes a lumpy prism. The distances below are set so that happens where it is a few
 * pixels wide.
 *
 * ## Why distance is derived rather than authored
 *
 * A switching distance in metres is meaningless without knowing how big the object is: forty metres
 * is far away for a crate and close for a cathedral. So the numbers here are multiples of the
 * object's own radius, and every object gets the distance that suits its size without anybody
 * typing one.
 */

export const LOD_MODES = ['off', 'balanced', 'aggressive'] as const;
export const LodModeSchema = z.enum(LOD_MODES);
export type LodMode = z.infer<typeof LodModeSchema>;

export const LOD_MODE_LABELS: Readonly<Record<LodMode, string>> = {
  off: 'Off',
  balanced: 'Balanced',
  aggressive: 'Aggressive',
};

export const LOD_MODE_HINTS: Readonly<Record<LodMode, string>> = {
  off: 'Every object draws every triangle at every distance. What this engine did before.',
  balanced:
    'Two coarser copies of each model, swapped in far enough away that the change is hard to see.',
  aggressive:
    'The same two copies, swapped in about twice as close. Noticeable on large smooth shapes; ' +
    'the setting for a big level on a weak machine.',
};

export interface LodProfile {
  /** Share of each mesh's vertices aimed for at each level, nearest first. */
  readonly ratios: readonly number[];
  /** Multiples of the object's radius at which each level takes over. */
  readonly distances: readonly number[];
}

/**
 * What each mode actually does.
 *
 * Two extra levels rather than three or four. Each level is a decimation pass at load and a buffer
 * on the GPU, and the third one saves a fraction of what the first two already saved — at the
 * distances where it would apply, the object is a handful of pixels and the triangles are not what
 * is costing anything.
 */
export const LOD_PROFILES: Readonly<Record<LodMode, LodProfile>> = {
  off: { ratios: [], distances: [] },
  balanced: { ratios: [0.45, 0.15], distances: [14, 34] },
  aggressive: { ratios: [0.35, 0.1], distances: [7, 17] },
};

export const LodSchema = z.object({
  mode: LodModeSchema.default('off'),
});
export type Lod = z.infer<typeof LodSchema>;

/**
 * Whether an object should get generated levels of detail.
 *
 * `auto` follows the level's setting; `never` keeps this one object at full detail always. The
 * escape hatch exists because clustering is bad at silhouettes, and the one object it makes a mess
 * of should not force the whole level back to `off`.
 */
export const LOD_OVERRIDES = ['auto', 'never'] as const;
export const LodOverrideSchema = z.enum(LOD_OVERRIDES);
export type LodOverride = z.infer<typeof LodOverrideSchema>;

/**
 * The distance at which each level takes over, in metres, for an object of this radius.
 *
 * A floor of a few metres, because a small object's radius times fourteen is closer than the camera
 * usually gets — and an object that swaps to its coarse mesh while you are looking straight at it is
 * the failure mode that makes people turn level of detail off and never turn it back on.
 */
export function lodDistances(mode: LodMode, radius: number): number[] {
  return LOD_PROFILES[mode].distances.map((multiple) => Math.max(6, radius * multiple));
}
