import fs from 'node:fs/promises';
import { z } from 'zod';
import {
  AssetCategorySchema,
  ColliderTypeSchema,
  HexColorSchema,
  Vec3Schema,
} from '@helaengine/schema';

/**
 * Per-asset facts that cannot be read out of a GLB — what kind of thing it is, how it should
 * collide, how it should be tagged for search. Kept beside the pipeline rather than inside the
 * manifest because the manifest is generated output.
 */
const AssetMetadataFileSchema = z.record(
  z.object({
    name: z.string().min(1).max(200),
    category: AssetCategorySchema,
    tags: z.array(z.string().max(64)).default([]),
    colliderType: ColliderTypeSchema.default('box'),
    defaultScale: Vec3Schema.default([1, 1, 1]),
    placeholderColor: HexColorSchema.default('#b0b0b0'),
  }),
);

export type AssetMetadata = z.infer<typeof AssetMetadataFileSchema>[string] & {
  /** False when the asset had no entry and fell back to defaults — the caller warns about it. */
  declared: boolean;
};

export interface AssetMetadataLookup {
  get(assetId: string): AssetMetadata;
}

/** Turns an asset id into a readable fallback name: `tree_pine_01` -> `Tree Pine 01`. */
function humanize(assetId: string): string {
  return assetId
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/** Guesses a category from the id prefix, so an undeclared asset still lands somewhere sensible. */
function guessCategory(assetId: string): z.infer<typeof AssetCategorySchema> {
  const prefix = assetId.split('_')[0] ?? '';
  const byPrefix: Record<string, z.infer<typeof AssetCategorySchema>> = {
    tree: 'trees',
    rock: 'rocks',
    building: 'buildings',
    enemy: 'enemies',
    prop: 'props',
    terrain: 'terrain',
  };
  return byPrefix[prefix] ?? 'props';
}

export async function readAssetMetadata(filePath: string): Promise<AssetMetadataLookup> {
  const raw: unknown = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const parsed = AssetMetadataFileSchema.parse(raw);

  return {
    get(assetId: string): AssetMetadata {
      const declared = parsed[assetId];
      if (declared) return { ...declared, declared: true };

      return {
        name: humanize(assetId),
        category: guessCategory(assetId),
        tags: [],
        colliderType: 'box',
        defaultScale: [1, 1, 1],
        placeholderColor: '#b0b0b0',
        declared: false,
      };
    },
  };
}
