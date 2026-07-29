import { z } from 'zod';
import { ColliderTypeSchema } from './asset.js';
import { Vec3Schema } from './primitives.js';

/**
 * How the physics world treats a placed object.
 *
 * - `static` never moves. Buildings, rocks, trees — the overwhelming majority of a scene, and the
 *   cheapest thing a solver can hold.
 * - `dynamic` is pushed around by gravity and contacts.
 * - `kinematic` is moved by gameplay (a behaviour, a character controller) and pushes others
 *   without being pushed back.
 */
export const BodyTypeSchema = z.enum(['static', 'dynamic', 'kinematic']);
export type BodyType = z.infer<typeof BodyTypeSchema>;

/**
 * Per-instance collider choice. `auto` defers to the asset manifest's `colliderType`, which is
 * where the answer usually belongs — the shape of a tree is a property of the tree, not of the
 * fourteenth copy of it. The override exists for the cases where placement changes the answer:
 * a building the player must walk inside needs `mesh` where the manifest says `box`.
 */
export const ColliderChoiceSchema = z.enum(['auto', ...ColliderTypeSchema.options]);
export type ColliderChoice = z.infer<typeof ColliderChoiceSchema>;

export const ObjectPhysicsSchema = z
  .object({
    body: BodyTypeSchema.default('static'),
    collider: ColliderChoiceSchema.default('auto'),
    /** Kilograms, for dynamic bodies. Omitted means Rapier derives it from the collider volume. */
    mass: z.number().positive().max(100_000).optional(),
  })
  .default({});
export type ObjectPhysics = z.infer<typeof ObjectPhysicsSchema>;

/**
 * The playable character the scene spawns in Play Preview and in an exported build.
 *
 * It lives in the document rather than in editor state because an export needs it: "where does the
 * player start and how tall are they" is a property of the world, not of the tool that built it.
 * There is exactly one, which is the honest shape of the thing today — multiplayer would be a
 * schema change and a migration, not a field quietly reinterpreted.
 */
export const PlayerSchema = z
  .object({
    spawn: Vec3Schema.default([0, 0, 0]),
    /** Total capsule height in metres, feet to crown. */
    height: z.number().min(0.5).max(5).default(1.8),
    radius: z.number().min(0.1).max(2).default(0.4),
    /** Ground speed in metres per second. */
    moveSpeed: z.number().min(0.5).max(50).default(6),
    /** Launch speed of a jump in metres per second. */
    jumpSpeed: z.number().min(0).max(50).default(6),
    /** Downward acceleration in metres per second squared. */
    gravity: z.number().min(0).max(100).default(24),
    /** Starting and maximum health. Damage comes from gameplay; the schema only sets the ceiling. */
    health: z.number().min(1).max(10_000).default(100),
    /** Steepest ground the player can walk up, in degrees. */
    maxSlopeDegrees: z.number().min(0).max(89).default(50),
    /** Tallest ledge the player steps over without jumping, in metres. */
    stepHeight: z.number().min(0).max(2).default(0.4),
  })
  .default({});
export type Player = z.infer<typeof PlayerSchema>;
