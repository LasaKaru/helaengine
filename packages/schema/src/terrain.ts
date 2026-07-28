import { z } from 'zod';
import { HexColorSchema } from './primitives.js';

/** One blend layer of the terrain material. Four are packed into the splat map's RGBA channels. */
export const TerrainLayerSchema = z.object({
  name: z.string().min(1).max(64),
  color: HexColorSchema,
});
export type TerrainLayer = z.infer<typeof TerrainLayerSchema>;

export const DEFAULT_TERRAIN_LAYERS: TerrainLayer[] = [
  { name: 'Grass', color: '#6a8f4f' },
  { name: 'Rock', color: '#7c7a74' },
  { name: 'Sand', color: '#c2ad7c' },
  { name: 'Dirt', color: '#6d5540' },
];

/**
 * Sculpted height and paint data, stored inline as base64.
 *
 * Inline because a scene has exactly one terrain and it is meaningless without it — round-tripping
 * through asset storage would mean a scene document that cannot be opened offline, and an export
 * that needs a second fetch to show the ground. At the default 64 segments this costs roughly 8 KB
 * of heights and 22 KB of weights; `MAX_INLINE_SEGMENTS` caps it before that becomes unreasonable,
 * and Phase 4 moves anything larger to object storage behind an asset reference.
 */
export const TerrainDataSchema = z.object({
  encoding: z.literal('base64'),
  data: z.string(),
});
export type TerrainData = z.infer<typeof TerrainDataSchema>;

/** Beyond this, inline base64 stops being a sensible way to carry a heightmap. */
export const MAX_INLINE_SEGMENTS = 256;

export const TerrainSchema = z.object({
  /** `flat` skips the heightmap entirely; `heightmap` displaces vertices from stored data. */
  type: z.enum(['flat', 'heightmap']).default('flat'),
  /** World size in metres, [x, z]. */
  size: z.tuple([z.number().positive(), z.number().positive()]).default([128, 128]),
  /** Grid subdivisions per axis. Vertex count per axis is this plus one. */
  segments: z.number().int().min(1).max(MAX_INLINE_SEGMENTS).default(64),
  /** World height that a normalised height of 1 corresponds to. */
  maxHeight: z.number().positive().max(500).default(20),
  material: z
    .object({
      color: HexColorSchema.default('#6a8f4f'),
    })
    .default({}),
  layers: z.array(TerrainLayerSchema).length(4).default(DEFAULT_TERRAIN_LAYERS),
  /** Absent on a freshly created terrain, and on any terrain the user never sculpted. */
  heightmap: TerrainDataSchema.nullable().default(null),
  splatmap: TerrainDataSchema.nullable().default(null),
});
export type Terrain = z.infer<typeof TerrainSchema>;
