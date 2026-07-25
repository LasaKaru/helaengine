import { z } from 'zod';
import { IdSchema, Vec3Schema } from './primitives.js';

export const AssetCategorySchema = z.enum([
  'trees',
  'rocks',
  'buildings',
  'enemies',
  'props',
  'terrain',
]);
export type AssetCategory = z.infer<typeof AssetCategorySchema>;

/**
 * One entry in the asset manifest. v0 carries only what the engine needs to resolve an `assetId`
 * to something renderable; the ingest pipeline (Sprint 2) fills in glb/thumbnail/polyCount.
 */
export const AssetManifestEntrySchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(200),
  category: AssetCategorySchema,
  tags: z.array(z.string().max(64)).default([]),
  /** Manifest-relative path to the compressed GLB. Absent while an asset is still a placeholder. */
  glbPath: z.string().min(1).optional(),
  thumbnailPath: z.string().min(1).optional(),
  defaultScale: Vec3Schema.default([1, 1, 1]),
  /** Approximate bounding size in metres, used to draw placeholders before GLBs exist. */
  placeholderSize: Vec3Schema.default([1, 1, 1]),
  /** Placeholder tint, also used as a fallback material colour. */
  placeholderColor: z
    .string()
    .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
    .default('#b0b0b0'),
});
export type AssetManifestEntry = z.infer<typeof AssetManifestEntrySchema>;

export const AssetManifestSchema = z.object({
  version: z.literal(1),
  assets: z.array(AssetManifestEntrySchema).default([]),
});
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export function parseAssetManifest(input: unknown): AssetManifest {
  return AssetManifestSchema.parse(input);
}
