import { z } from 'zod';
import { IdSchema, TransformSchema } from './primitives.js';

/**
 * A placed instance in the world.
 *
 * `assetId` points at an asset manifest entry, never a file path — that indirection is what lets
 * assets be re-versioned, recompressed or relocated without rewriting every saved scene.
 */
export const SceneObjectSchema = z.object({
  id: IdSchema,
  assetId: IdSchema,
  /**
   * Parent object id, or null for a root object.
   *
   * A nested object's `transform` is expressed in its parent's space, exactly as in a Three.js
   * scene graph — moving a building carries its attached props along.
   */
  parentId: IdSchema.nullable().default(null),
  transform: TransformSchema.default({}),
  metadata: z
    .object({
      label: z.string().max(200).optional(),
      layer: z.string().max(64).optional(),
    })
    .default({}),
});
export type SceneObject = z.infer<typeof SceneObjectSchema>;
