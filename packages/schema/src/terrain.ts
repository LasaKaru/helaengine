import { z } from 'zod';
import { HexColorSchema } from './primitives.js';

/**
 * Terrain v0: flat only. Heightmap sculpting lands in Sprint 7 — the discriminant is here from
 * the start so adding `heightmap` later is an additive schema change, not a breaking one.
 */
export const TerrainSchema = z.object({
  type: z.literal('flat').default('flat'),
  /** World size in metres, [x, z]. */
  size: z.tuple([z.number().positive(), z.number().positive()]).default([256, 256]),
  /** Plane subdivisions per axis. Kept low while terrain is flat. */
  segments: z.number().int().min(1).max(1024).default(32),
  material: z
    .object({
      color: HexColorSchema.default('#6a8f4f'),
    })
    .default({}),
});
export type Terrain = z.infer<typeof TerrainSchema>;
