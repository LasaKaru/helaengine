import { z } from 'zod';
import { HexColorSchema, IdSchema, Vec3Schema } from './primitives.js';

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
 * Collider shape the physics world generates for this asset (Sprint 10).
 * Declared per asset rather than per placement so a scene gets sane physics by default.
 */
export const ColliderTypeSchema = z.enum(['box', 'capsule', 'sphere', 'mesh', 'none']);
export type ColliderType = z.infer<typeof ColliderTypeSchema>;

/**
 * One entry in the asset manifest — everything needed to place, draw and collide an asset.
 *
 * Written by the ingest pipeline, never by hand: `glbPath`, `thumbnailPath`, `polyCount` and
 * `bounds` are measured from the source file, while `category`, `tags`, `colliderType` and
 * `defaultScale` come from the pipeline's per-asset metadata file.
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
  colliderType: ColliderTypeSchema.default('box'),

  /** Triangle count of the ingested mesh, used for budget warnings and LOD decisions. */
  polyCount: z.number().int().nonnegative().optional(),
  /** Measured bounding size in metres. Also the placeholder box size before a GLB exists. */
  bounds: Vec3Schema.default([1, 1, 1]),
  /** Placeholder tint, and the fallback material colour when a model fails to load. */
  placeholderColor: HexColorSchema.default('#b0b0b0'),
});
export type AssetManifestEntry = z.infer<typeof AssetManifestEntrySchema>;

export const AssetManifestSchema = z.object({
  version: z.literal(1),
  /** ISO timestamp written by the ingest pipeline, for cache-busting and debugging. */
  generatedAt: z.string().datetime().optional(),
  assets: z.array(AssetManifestEntrySchema).default([]),
});
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export function parseAssetManifest(input: unknown): AssetManifest {
  return AssetManifestSchema.parse(input);
}
