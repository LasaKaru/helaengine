import { z } from 'zod';
import { HexColorSchema } from './primitives.js';

/**
 * Water: a surface at a height, and what the ground does when it meets it.
 *
 * ## One plane, not a mesh you draw
 *
 * Water here is a horizontal plane at a height, not a shape somebody paints. That sounds like a
 * limitation and is mostly a description of what water does: a pond, a lake and a sea are all a
 * level surface, and the interesting part is not the outline — it is where the terrain rises
 * through it. Sculpt a hollow and it fills; raise a bank and the water stops at it. The shoreline
 * is a *consequence* of the ground rather than a second thing to keep in step with it, which is
 * what stops a lake and the hill it sits in drifting apart every time somebody sculpts.
 *
 * A river running downhill is the case this cannot do, and it is the honest limit: a sloped or
 * flowing surface is a different feature, not a parameter of this one.
 *
 * ## Depth comes from the heightfield, not from a render pass
 *
 * How deep the water is at a point is the surface height minus the ground height, and the ground
 * height is already in memory for the collider. So shallows can read differently from deep water
 * and the shore can fade rather than cutting a hard line, for the cost of a subtraction — no depth
 * buffer, no second render, nothing that a browser renderer has to be careful about.
 *
 * ## Off by default
 *
 * `WaterSchema` is nullable on the environment and null is the absence of the system: no plane
 * built, no shader compiled, no per-frame work. Every scene saved before this existed renders
 * exactly as it did.
 */

export const WATER_KINDS = ['pond', 'lake', 'sea'] as const;
export const WaterKindSchema = z.enum(WATER_KINDS);
export type WaterKind = z.infer<typeof WaterKindSchema>;

export const WATER_LABELS: Readonly<Record<WaterKind, string>> = {
  pond: 'Pond',
  lake: 'Lake',
  sea: 'Sea',
};

export const WATER_HINTS: Readonly<Record<WaterKind, string>> = {
  pond: 'Small and still. Fine ripples, and you can see the bottom.',
  lake: 'Wider, with slower waves and water that goes green with depth.',
  sea: 'Long swells and deep blue. Nothing is visible more than a metre down.',
};

/**
 * What each kind looks like before anybody touches a slider.
 *
 * A table rather than a branch in the shader: the shader has one code path and the kind chooses its
 * constants, so switching from a pond to a sea does not recompile anything.
 *
 * `clarity` is how far light gets down, in metres — it is what separates a pond you can see the
 * bottom of from a sea you cannot, and it is the single strongest cue that water has depth at all.
 */
export interface WaterPreset {
  readonly color: string;
  readonly clarity: number;
  readonly waveHeight: number;
  readonly waveScale: number;
  readonly waveSpeed: number;
}

export const WATER_PRESETS: Readonly<Record<WaterKind, WaterPreset>> = {
  pond: { color: '#3d6b5c', clarity: 3.5, waveHeight: 0.02, waveScale: 1.4, waveSpeed: 0.5 },
  lake: { color: '#2f5f7a', clarity: 2.2, waveHeight: 0.06, waveScale: 4, waveSpeed: 0.7 },
  sea: { color: '#17415e', clarity: 1, waveHeight: 0.22, waveScale: 12, waveSpeed: 1 },
};

export const WaterSchema = z.object({
  kind: WaterKindSchema.default('pond'),
  /** The surface height in metres. Terrain above it is dry land; below it is underwater. */
  height: z.number().min(-500).max(500).default(0),
  /** Null takes the kind's own colour, so changing kind changes the look until somebody overrides it. */
  color: HexColorSchema.nullable().default(null),
  /**
   * How far down light reaches, in metres. Below this the water reads as opaque.
   *
   * Zero would be a mirror with nothing under it, which is not a thing water does — the minimum is
   * a hand's width rather than nothing.
   */
  clarity: z.number().min(0.1).max(30).default(3.5),
  waveHeight: z.number().min(0).max(2).default(0.06),
  waveScale: z.number().min(0.2).max(60).default(4),
  waveSpeed: z.number().min(0).max(4).default(0.7),
  /**
   * Whether things float and the player swims.
   *
   * Separate from the surface, because the two are genuinely independent: a decorative moat around
   * a level the player never enters wants the look and none of the cost, and a level about swimming
   * wants both. Off by default so adding water to an existing scene cannot change how it plays.
   */
  buoyancy: z.boolean().default(false),
  /** How strongly a submerged body is pushed up, as a multiple of its weight. 1 is neutral. */
  buoyancyStrength: z.number().min(0).max(4).default(1.15),
  /** How much water slows what moves through it. Zero is a body that falls through as if in air. */
  drag: z.number().min(0).max(10).default(3),
});
export type Water = z.infer<typeof WaterSchema>;

export const OptionalWaterSchema = WaterSchema.nullable().default(null);

export function defaultWater(kind: WaterKind = 'pond'): Water {
  const preset = WATER_PRESETS[kind];
  return WaterSchema.parse({
    kind,
    clarity: preset.clarity,
    waveHeight: preset.waveHeight,
    waveScale: preset.waveScale,
    waveSpeed: preset.waveSpeed,
  });
}

/** The colour this water actually draws with: its override, or its kind's. */
export function waterColor(water: Water): string {
  return water.color ?? WATER_PRESETS[water.kind].color;
}

/**
 * How deep the water is at a point, in metres, given the ground height there.
 *
 * Negative is dry land — the ground is above the surface — and callers want that rather than a
 * clamp to zero: the shoreline fade needs to know how far *above* the water the bank has risen, and
 * a clamped value makes every point on land look identical to the waterline.
 */
export function waterDepthAt(water: Water, groundHeight: number): number {
  return water.height - groundHeight;
}

/**
 * What is wrong with a water setting, in the author's terms.
 *
 * The first one is the one that matters. A surface below every piece of ground in the level is
 * invisible — the plane is built, the shader runs, and there is nothing to see — and an author
 * reads that as the feature being broken rather than as their own number.
 */
export function waterProblems(
  water: Water,
  terrain: { lowest: number; highest: number } | null,
): string[] {
  const problems: string[] = [];

  if (terrain && water.height <= terrain.lowest) {
    problems.push(
      `the surface is at ${water.height.toFixed(1)}m and the lowest ground in this level is at ` +
        `${terrain.lowest.toFixed(1)}m, so the water is under all of it and nothing will show — ` +
        'raise it, or sculpt a hollow for it to sit in',
    );
  }

  if (terrain && water.height >= terrain.highest) {
    problems.push(
      'the surface is above every piece of ground here, so the whole level is underwater',
    );
  }

  if (water.buoyancy && water.drag === 0) {
    problems.push(
      'things float but nothing slows them down, so a crate dropped in will bob forever — give it ' +
        'some drag',
    );
  }

  return problems;
}
