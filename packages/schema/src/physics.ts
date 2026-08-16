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
    /** Multiplier applied to `moveSpeed` while sprinting. */
    sprintMultiplier: z.number().min(1).max(5).default(1.7),
    /** Multiplier applied to `moveSpeed` while crouched. */
    crouchMultiplier: z.number().min(0.05).max(1).default(0.45),
    /** Fraction of full height the capsule shrinks to when crouched. */
    crouchHeightRatio: z.number().min(0.3).max(1).default(0.6),
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
    /**
     * Seconds after walking off an edge during which a jump still works.
     *
     * Named after Wile E. Coyote, and it is the single largest difference between a character that
     * feels responsive and one that feels like it is arguing with you. A player who presses jump at
     * the lip of a platform is almost always a frame or two late — the character has already left
     * the ground — and without this their jump is silently eaten. They do not conclude they mistimed
     * it; they conclude the controls are unreliable.
     *
     * Zero is the old behaviour exactly, which is why it is the default: every scene saved before
     * this existed keeps the movement it was tuned against.
     */
    coyoteSeconds: z.number().min(0).max(1).default(0),
    /**
     * Seconds before landing during which a jump press is remembered.
     *
     * The same mistake from the other side: a player falling towards the ground presses jump a
     * fraction early, the press lands while they are still airborne, and nothing happens. Buffering
     * it means the jump fires on the frame they touch down. Zero is the old behaviour.
     */
    jumpBufferSeconds: z.number().min(0).max(1).default(0),
    /**
     * How much steering the player has in mid-air, as a fraction of ground control.
     *
     * One is full control and the old behaviour — a character who can turn on a sixpence while
     * falling, which reads as floaty and makes a jump a decision that can be taken twice. Lower
     * values commit the player to the direction they left the ground in. Zero is a pure ballistic
     * arc, which is precise and unforgiving.
     */
    airControl: z.number().min(0).max(1).default(1),
    /**
     * Tallest ledge the player pulls themselves onto, in metres, or 0 for none.
     *
     * A step is walked over without noticing; a mantle is a deliberate haul over something at chest
     * height. The gap between `stepHeight` and here is what separates "the geometry is rough" from
     * "that is a wall I can climb", and it is worth a great deal in a level built out of crates.
     */
    mantleHeight: z.number().min(0).max(4).default(0),
    /**
     * Seconds face-down before respawning at the spawn point.
     *
     * A stub in the honest sense: Sprint 18 replaces "the spawn point" with "the last checkpoint"
     * and nothing here changes shape. Zero means respawn on the next frame.
     */
    respawnSeconds: z.number().min(0).max(60).default(2),
    /**
     * Seconds after taking a hit during which further damage is ignored.
     *
     * Without it, two enemies swinging in the same frame do double damage and a crowd kills the
     * player faster than any of them individually could — which reads as a bug rather than a fight.
     */
    damageCooldown: z.number().min(0).max(10).default(0.4),
  })
  .default({});
export type Player = z.infer<typeof PlayerSchema>;
