import { z } from 'zod';
import { HexColorSchema, IdSchema, Vec3Schema } from './primitives.js';

export const AssetCategorySchema = z.enum([
  'trees',
  'rocks',
  'buildings',
  'enemies',
  'props',
  'terrain',
  // Not a visual asset at all: trigger volumes and other world logic, which the editor lists
  // alongside props because "place it in the world" is the same gesture.
  'logic',
  // Nor is this: music and sound effects, referenced by id from `audioConfig` rather than placed.
  // Sharing the manifest keeps one answer to "what assets does this project have".
  'audio',
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
  /** Manifest-relative path to the normalised audio file. Only for `category: 'audio'`. */
  audioPath: z.string().min(1).optional(),
  /** Length in seconds, measured at ingest. Lets the editor show it without decoding the file. */
  durationSeconds: z.number().positive().max(3600).optional(),
  /** Whether the ingest step judged this a music bed rather than a one-shot. */
  loop: z.boolean().optional(),

  defaultScale: Vec3Schema.default([1, 1, 1]),
  colliderType: ColliderTypeSchema.default('box'),

  /** Triangle count of the ingested mesh, used for budget warnings and LOD decisions. */
  polyCount: z.number().int().nonnegative().optional(),
  /** Measured bounding size in metres. Also the placeholder box size before a GLB exists. */
  bounds: Vec3Schema.default([1, 1, 1]),
  /** Placeholder tint, and the fallback material colour when a model fails to load. */
  placeholderColor: HexColorSchema.default('#b0b0b0'),

  /**
   * Attribution, for the CREDITS file an export generates.
   *
   * Optional because the stand-in assets are generated in code and have nobody to credit — but the
   * moment a real asset library exists, an export that could not say where its art came from would
   * be shipping somebody else's work with the attribution stripped.
   */
  license: z.string().max(120).optional(),
  author: z.string().max(200).optional(),
  sourceUrl: z.string().max(500).optional(),

  /**
   * Who this asset came from, as a closed vocabulary.
   *
   * The marketplace groundwork the plan asks for, and the reason it is a separate field rather than
   * something inferred: today "is it ours?" happens to equal "is `organization_id` null?" in the
   * database, and the day a third party contributes to the shared library that stops being true —
   * silently, with no schema change to notice. A row that says what it is cannot drift.
   *
   * - `first-party` — shipped with HelaEngine. Terms are the project's own.
   * - `customer` — uploaded by an organisation into its private library. The organisation warrants
   *   it has the rights; HelaEngine records what it was told.
   * - `third-party` — contributed to the shared library by somebody else. Not reachable yet, and
   *   defined now so the marketplace does not arrive needing a migration of every existing row.
   *
   * Defaulted rather than required, because every asset that exists today predates the field and a
   * required column would mean a migration that guesses.
   */
  origin: z.enum(['first-party', 'customer', 'third-party']).default('first-party'),
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
