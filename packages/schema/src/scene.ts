import { z } from 'zod';
import { EnvironmentSchema } from './environment.js';
import { SceneObjectSchema } from './object.js';
import { GameConfigSchema } from './game.js';
import { InventorySchema } from './inventory.js';
import { PlayerSchema } from './physics.js';
import { UiConfigSchema } from './ui.js';
import { IdSchema } from './primitives.js';
import { TerrainSchema } from './terrain.js';

/**
 * Current scene document version. Bump this whenever a change to `SceneSchema` cannot read an
 * older document as-is, and register a migration in `migrations.ts` in the same commit.
 */
export const CURRENT_SCENE_VERSION = 1;

export const SceneSchema = z
  .object({
    sceneId: IdSchema,
    version: z.literal(CURRENT_SCENE_VERSION),
    name: z.string().min(1).max(200).default('Untitled scene'),
    terrain: TerrainSchema.default({}),
    environment: EnvironmentSchema.default({}),
    objects: z.array(SceneObjectSchema).default([]),
    player: PlayerSchema,
    inventory: InventorySchema,
    gameConfig: GameConfigSchema,
    uiConfig: UiConfigSchema,
  })
  .superRefine((scene, ctx) => {
    const seen = new Set<string>();
    for (const [index, object] of scene.objects.entries()) {
      if (seen.has(object.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['objects', index, 'id'],
          message: `duplicate object id "${object.id}"`,
        });
      }
      seen.add(object.id);
    }

    const parentById = new Map(scene.objects.map((object) => [object.id, object.parentId]));

    for (const [index, object] of scene.objects.entries()) {
      if (object.parentId === null) continue;

      if (!seen.has(object.parentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['objects', index, 'parentId'],
          message: `object "${object.id}" has parentId "${object.parentId}", which does not exist`,
        });
        continue;
      }

      // A cycle would make the scene graph unbuildable and hang any naive traversal, so it is
      // rejected at the boundary rather than defended against in every consumer.
      const visited = new Set<string>([object.id]);
      let ancestor: string | null | undefined = object.parentId;
      while (ancestor != null) {
        if (visited.has(ancestor)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['objects', index, 'parentId'],
            message: `object "${object.id}" is part of a parent cycle`,
          });
          break;
        }
        visited.add(ancestor);
        ancestor = parentById.get(ancestor);
      }
    }
  });

export type Scene = z.infer<typeof SceneSchema>;

/** Throws a ZodError describing every problem found. Use at every trust boundary. */
export function parseScene(input: unknown): Scene {
  return SceneSchema.parse(input);
}

export function safeParseScene(input: unknown): z.SafeParseReturnType<unknown, Scene> {
  return SceneSchema.safeParse(input);
}
