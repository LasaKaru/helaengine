import { z } from 'zod';
import { HexColorSchema } from './primitives.js';
import { SurfaceSchema } from './surface.js';

/**
 * How a scene is lit and graded, as data.
 *
 * The same closed-vocabulary rule as everything else: a fixed set of effects with typed
 * parameters, never a shader somebody pasted in. A scene document that could carry GLSL would be a
 * scene document that can crash a GPU driver in a collaborator's browser, and would put the
 * pre-delivery gate back to guessing.
 *
 * It is also why the effects here are the ones with a *parameter* worth exposing. A vignette has a
 * strength; a bloom has a threshold. "Arbitrary colour grading" does not fit in a closed
 * vocabulary, so what is offered instead is brightness, contrast and saturation — which is what
 * most grading amounts to and which can be validated.
 */

/**
 * Shadow quality, as three named steps rather than a pixel count.
 *
 * A number would be a number somebody has to know the meaning of, and the meaningful choice is a
 * trade rather than a value: `high` is four times the texture memory of `medium` for a difference
 * most low-poly scenes cannot show. `off` is a real option — a stylised flat-lit scene looks
 * deliberate, and shadows are the single most expensive thing in this renderer.
 */
export const SHADOW_QUALITY = ['off', 'low', 'medium', 'high'] as const;
export const ShadowQualitySchema = z.enum(SHADOW_QUALITY);
export type ShadowQuality = z.infer<typeof ShadowQualitySchema>;

/** Shadow-map resolution per quality step. `off` has none. */
export const SHADOW_MAP_SIZE: Readonly<Record<ShadowQuality, number>> = {
  off: 0,
  low: 1024,
  medium: 2048,
  high: 4096,
};

export const ShadowSchema = z.object({
  quality: ShadowQualitySchema.default('medium'),
  /**
   * How far from the camera shadows are drawn, in metres.
   *
   * The whole shadow map is stretched over this distance, so doubling it halves the effective
   * resolution everywhere. A large level does not want a large number here; it wants the same
   * number and shadows that fade out.
   */
  distance: z.number().min(20).max(1000).default(200),
  /**
   * Nudges a shadow away from the surface casting it.
   *
   * The only fix for shadow acne — the stippled self-shadowing that appears on gently sloped
   * ground — and the reason it is exposed at all. Too much and shadows detach from their objects,
   * so it is a small number with a small range.
   */
  bias: z.number().min(-0.01).max(0.01).default(-0.0005),
});
export type ShadowSettings = z.infer<typeof ShadowSchema>;

/**
 * Tone mapping, which decides how colours brighter than white are brought back into range.
 *
 * `none` clips them, which is what this engine did before this existed and what a flat, stylised
 * look wants. `aces` is the filmic curve most engines default to. Named rather than numbered
 * because the numbers are Three.js constants, and a document should not depend on a library's
 * internal enum.
 */
export const TONE_MAPPING = ['none', 'linear', 'reinhard', 'cineon', 'aces'] as const;
export const ToneMappingSchema = z.enum(TONE_MAPPING);
export type ToneMapping = z.infer<typeof ToneMappingSchema>;

export const BloomSchema = z.object({
  enabled: z.boolean().default(false),
  /** How bright a pixel has to be before it blooms. Above 1 only truly bright things glow. */
  threshold: z.number().min(0).max(2).default(0.85),
  strength: z.number().min(0).max(3).default(0.4),
  /** How far the glow spreads. */
  radius: z.number().min(0).max(1).default(0.3),
});

export const VignetteSchema = z.object({
  enabled: z.boolean().default(false),
  /** How dark the corners get. */
  strength: z.number().min(0).max(1).default(0.4),
  /** How far in from the corners it starts. */
  offset: z.number().min(0).max(1).default(0.5),
});

export const ColorGradeSchema = z.object({
  enabled: z.boolean().default(false),
  brightness: z.number().min(-1).max(1).default(0),
  contrast: z.number().min(-1).max(1).default(0),
  saturation: z.number().min(-1).max(1).default(0),
  /** Tints the whole image. White is no tint. */
  tint: HexColorSchema.default('#ffffff'),
});

export const PostProcessingSchema = z.object({
  /**
   * Off by default, and the default matters more than the feature.
   *
   * A post stack means rendering to a texture and running at least two extra full-screen passes.
   * On a low-poly scene at 60fps that is a real fraction of the frame budget, and on a phone it is
   * most of it. Somebody who has not asked for bloom should not pay for the machinery that would
   * deliver it — so with everything disabled the renderer draws straight to the canvas exactly as
   * it always has.
   */
  enabled: z.boolean().default(false),
  bloom: BloomSchema.default({}),
  vignette: VignetteSchema.default({}),
  colorGrade: ColorGradeSchema.default({}),
});
export type PostProcessing = z.infer<typeof PostProcessingSchema>;

/**
 * A material override for one placed object.
 *
 * Overrides rather than replaces: every field is optional and an absent one leaves whatever the
 * model shipped with. That is what makes it useful on a shared library — recolouring one crate red
 * should not mean re-authoring its roughness, and should certainly not mean recolouring every
 * other crate placed from the same asset.
 */
export const MaterialOverrideSchema = z.object({
  color: HexColorSchema.optional(),
  roughness: z.number().min(0).max(1).optional(),
  metalness: z.number().min(0).max(1).optional(),
  emissive: HexColorSchema.optional(),
  emissiveIntensity: z.number().min(0).max(10).optional(),
  /** Below 1 the object is see-through. Transparency is switched on automatically when it is. */
  opacity: z.number().min(0).max(1).optional(),
  /** Draw the model as edges only. Cheap, and the fastest way to make something look diagrammatic. */
  wireframe: z.boolean().optional(),
  /**
   * Draw the inside faces instead of the outside ones.
   *
   * The fix for a model that vanishes when you walk into it — a room built from an inverted box,
   * a skydome, a cave. Nothing else in the schema addresses it and it is a one-line property.
   */
  doubleSided: z.boolean().optional(),
  /**
   * A generated PBR surface — brick, tile, planks — bound as normal, roughness and occlusion maps.
   *
   * Lives inside the override rather than beside it because it is the same kind of thing and needs
   * exactly the same machinery: materials cloned per object so one brick wall is not every wall,
   * restored when it is cleared, and freed when the object goes. A parallel field would have been a
   * second copy of all of that, and a second thing for `setMaterial` to forget.
   */
  surface: SurfaceSchema.optional(),
});
export type MaterialOverride = z.infer<typeof MaterialOverrideSchema>;

/** Whether an override actually asks for anything. An empty one should not cost a material clone. */
export function isEmptyOverride(override: MaterialOverride): boolean {
  return Object.values(override).every((value) => value === undefined);
}
