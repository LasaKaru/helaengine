import { z } from 'zod';
import { HexColorSchema } from './primitives.js';

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
});
export type Lighting = z.infer<typeof LightingSchema>;

export const EnvironmentSchema = z.object({
  background: HexColorSchema.default('#a0c8ff'),
  fog: FogSchema.nullable().default(null),
  lighting: LightingSchema.default({}),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
