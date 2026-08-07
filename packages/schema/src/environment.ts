import { z } from 'zod';
import { HexColorSchema } from './primitives.js';
import { PostProcessingSchema, ShadowSchema, ToneMappingSchema } from './rendering.js';

export const FogSchema = z.object({
  color: HexColorSchema.default('#a0c8ff'),
  near: z.number().min(0).default(20),
  far: z.number().min(0).default(400),
});
export type Fog = z.infer<typeof FogSchema>;

export const LightingSchema = z.object({
  sun: z
    .object({
      color: HexColorSchema.default('#ffffff'),
      intensity: z.number().min(0).max(10).default(1.2),
      /** Elevation above the horizon, degrees. */
      elevation: z.number().min(-90).max(90).default(45),
      /** Compass rotation around Y, degrees. */
      azimuth: z.number().default(135),
    })
    .default({}),
  ambient: z.number().min(0).max(10).default(0.4),
  /**
   * Colour of the ambient fill.
   *
   * Added beside `ambient` rather than folded into it, because `ambient` is a *number* in every
   * scene saved so far and turning it into an object would break all of them. White keeps the
   * existing look exactly, and the interesting values are not white: a cool sky-blue fill against
   * a warm sun is most of what makes a low-poly scene look lit rather than flat.
   */
  ambientColor: HexColorSchema.default('#ffffff'),
  /**
   * A second ambient term coming from below, or null for none.
   *
   * A hemisphere light tints upward-facing surfaces with the sky and downward-facing ones with the
   * ground, which is the cheapest approximation of bounced light there is — and at low-poly
   * densities it does more for a scene's look than any amount of shadow tuning. Null by default so
   * nothing changes for an existing scene.
   */
  hemisphere: z
    .object({
      skyColor: HexColorSchema.default('#a0c8ff'),
      groundColor: HexColorSchema.default('#4a4a3a'),
      intensity: z.number().min(0).max(5).default(0.5),
    })
    .nullable()
    .default(null),
  shadows: ShadowSchema.default({}),
});
export type Lighting = z.infer<typeof LightingSchema>;

export const EnvironmentSchema = z.object({
  background: HexColorSchema.default('#a0c8ff'),
  fog: FogSchema.nullable().default(null),
  lighting: LightingSchema.default({}),
  toneMapping: ToneMappingSchema.default('none'),
  /** Overall brightness, applied by the tone mapper. Ignored when tone mapping is `none`. */
  exposure: z.number().min(0.1).max(4).default(1),
  postProcessing: PostProcessingSchema.default({}),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
