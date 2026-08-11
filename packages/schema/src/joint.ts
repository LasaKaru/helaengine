import { z } from 'zod';
import { IdSchema, Vec3Schema } from './primitives.js';

/**
 * Constraints between two placed objects.
 *
 * A joint is what turns a pile of separate rigid bodies into a *thing*: a door that swings on its
 * frame, a bridge that sags, a chain that hangs, a lever that stops at the end of its travel. Every
 * one of them is a pair of bodies plus a rule about how they may move relative to each other.
 *
 * ## Why joints live on the scene rather than on an object
 *
 * A joint is a relationship, and both ends have to agree about it. Hanging it off one object would
 * make the other end a fact stored somewhere it cannot be seen — deleting the far object would
 * leave a joint pointing at nothing, and the document would have no natural place to notice.
 * `scene.joints` is a list of relationships, validated against the object list as a whole.
 *
 * ## Anchors are in each body's own space
 *
 * `anchorA` is where the joint attaches on A, measured in A's local space; `anchorB` likewise on B.
 * That is Rapier's own convention and it is the one that survives the objects being moved: a hinge
 * pinned to the *edge* of a door stays on the edge wherever the door is dragged to. Anchors in
 * world space would have to be recomputed every time either object moved, and would silently rot
 * the first time somebody nudged one.
 */

/**
 * How a joint's motor is driven, or `off` for a joint that only constrains.
 *
 * - `off` — no motor. The overwhelming majority: a hinge on a door is pushed by the player, not
 *   driven.
 * - `velocity` — spin at a target rate. Turntables, fans, conveyor wheels.
 * - `position` — hold a target angle or offset, springing back when pushed off it. Powered doors,
 *   suspension, a lever that returns to centre.
 */
export const MotorModeSchema = z.enum(['off', 'velocity', 'position']);
export type MotorMode = z.infer<typeof MotorModeSchema>;

export const JointMotorSchema = z
  .object({
    mode: MotorModeSchema.default('off'),
    /** Radians for angular joints, metres for a slider. Read only in `position` mode. */
    target: z.number().min(-1000).max(1000).default(0),
    /** Radians or metres per second. Read only in `velocity` mode. */
    velocity: z.number().min(-100).max(100).default(0),
    /** How hard the motor pulls toward `target`. Zero in `position` mode is a motor that does nothing. */
    stiffness: z.number().min(0).max(100_000).default(100),
    /** Resistance to motion. Zero oscillates forever; this is the field that stops a door flapping. */
    damping: z.number().min(0).max(10_000).default(10),
  })
  .default({});
export type JointMotor = z.infer<typeof JointMotorSchema>;

/**
 * How far a joint may travel, or null for free movement.
 *
 * Radians for a hinge, metres for a slider. A door that opens 100° and stops is a limit; a door
 * that spins freely through its own frame is what you get without one.
 */
export const JointLimitSchema = z
  .object({
    min: z.number().min(-1000).max(1000),
    max: z.number().min(-1000).max(1000),
  })
  .refine((limit) => limit.max >= limit.min, {
    message: 'a joint limit needs max to be at least min',
  });
export type JointLimit = z.infer<typeof JointLimitSchema>;

const base = {
  id: IdSchema,
  /** The two objects being joined. Both must exist, and they must be different. */
  objectA: IdSchema,
  objectB: IdSchema,
  anchorA: Vec3Schema.default([0, 0, 0]),
  anchorB: Vec3Schema.default([0, 0, 0]),
  /**
   * Whether the two joined bodies still collide with each other.
   *
   * Off by default, and that default matters: two bodies pinned together overlap by construction,
   * and leaving contacts on makes the solver fight its own constraint — the assembly jitters, then
   * throws itself across the level. Somebody wanting a hinged lid to rest *on* its box turns it on
   * deliberately.
   */
  collide: z.boolean().default(false),
  metadata: z.object({ label: z.string().max(200).optional() }).default({}),
};

/**
 * The joint vocabulary.
 *
 * Closed, like every other extensible thing here. Each variant is a shape Rapier implements
 * directly — nothing here is a composite this code assembles, because a composite would be a
 * behaviour and behaviours are engine code, not document data.
 */
export const JointSchema = z.discriminatedUnion('type', [
  /** Welded. No relative movement at all — for assembling one rigid thing out of several models. */
  z.object({ ...base, type: z.literal('fixed') }),

  /**
   * A hinge: one axis of rotation. Doors, lids, wheels, levers.
   *
   * `axis` is in A's local space, for the same reason the anchors are.
   */
  z.object({
    ...base,
    type: z.literal('hinge'),
    axis: Vec3Schema.default([0, 1, 0]),
    /** Radians. Null swings freely. */
    limit: JointLimitSchema.nullable().default(null),
    motor: JointMotorSchema,
  }),

  /** A ball socket: rotation on all three axes, no translation. Chains, ropes of links, ragdolls. */
  z.object({ ...base, type: z.literal('ball') }),

  /** A slider: translation along one axis only. Pistons, drawers, lift platforms. */
  z.object({
    ...base,
    type: z.literal('slider'),
    axis: Vec3Schema.default([0, 1, 0]),
    /** Metres. Null slides without end, which is almost never what is wanted. */
    limit: JointLimitSchema.nullable().default(null),
    motor: JointMotorSchema,
  }),

  /** A spring: pulls toward a rest length rather than holding one. Suspension, bouncy platforms. */
  z.object({
    ...base,
    type: z.literal('spring'),
    restLength: z.number().min(0).max(1000).default(1),
    stiffness: z.number().min(0).max(100_000).default(100),
    damping: z.number().min(0).max(10_000).default(10),
  }),

  /**
   * A rope: a maximum distance, and nothing else.
   *
   * Unlike a spring it does nothing at all until it is taut, which is what a rope does. A hanging
   * sign, a tow line, a swinging lamp.
   */
  z.object({ ...base, type: z.literal('rope'), length: z.number().min(0).max(1000).default(2) }),
]);
export type Joint = z.infer<typeof JointSchema>;
export type JointType = Joint['type'];

export const JOINT_TYPES = [
  'fixed',
  'hinge',
  'ball',
  'slider',
  'spring',
  'rope',
] as const satisfies readonly JointType[];

/** What each joint type is for, in the language of the thing being built rather than the solver. */
export const JOINT_LABELS: Record<JointType, string> = {
  fixed: 'Fixed',
  hinge: 'Hinge',
  ball: 'Ball socket',
  slider: 'Slider',
  spring: 'Spring',
  rope: 'Rope',
};

export const JOINT_HINTS: Record<JointType, string> = {
  fixed: 'Welded solid. Assembles one rigid thing out of several models.',
  hinge: 'Turns on one axis. Doors, lids, levers, wheels.',
  ball: 'Turns freely in every direction. Chains and hanging things.',
  slider: 'Slides along one axis. Pistons, drawers, lift platforms.',
  spring: 'Pulls toward a rest length. Suspension and bouncy platforms.',
  rope: 'Does nothing until taut. Hanging signs and tow lines.',
};

/** Whether a joint type has an axis, a limit and a motor — what the inspector should offer. */
export function jointHasAxis(type: JointType): boolean {
  return type === 'hinge' || type === 'slider';
}

export const JointsSchema = z.array(JointSchema).max(2000).default([]);

/**
 * Problems that would make a joint do nothing, or do something destructive.
 *
 * Reported rather than thrown: a joint naming a deleted object is a level in mid-edit, not a
 * corrupt document, and the editor should say so in a panel rather than refuse to open the file.
 * The runtime skips exactly the joints listed here, so what the panel warns about and what fails to
 * build cannot disagree.
 */
export function jointProblems(
  joints: readonly Joint[],
  objectIds: ReadonlySet<string>,
): Array<{ jointId: string; reason: string }> {
  const problems: Array<{ jointId: string; reason: string }> = [];
  const seen = new Set<string>();

  for (const joint of joints) {
    if (seen.has(joint.id)) {
      problems.push({ jointId: joint.id, reason: `duplicate joint id "${joint.id}"` });
    }
    seen.add(joint.id);

    if (joint.objectA === joint.objectB) {
      // Rapier will happily create it and then chew a solver island trying to satisfy a body
      // against itself. Nothing visible happens; the frame rate just falls.
      problems.push({ jointId: joint.id, reason: 'both ends are the same object' });
      continue;
    }
    if (!objectIds.has(joint.objectA)) {
      problems.push({ jointId: joint.id, reason: `"${joint.objectA}" is not in this level` });
    }
    if (!objectIds.has(joint.objectB)) {
      problems.push({ jointId: joint.id, reason: `"${joint.objectB}" is not in this level` });
    }
  }

  return problems;
}

/**
 * Whether a joint between these two body types can move at all.
 *
 * Two static bodies joined together is the single most common way to build a door that does not
 * open: the hinge is right, the axis is right, and neither end can be moved by anything, so the
 * assembly is a very expensive way to describe a wall. Worth warning about, because everything
 * about the document says it should work.
 */
export function jointIsInert(bodyA: string, bodyB: string): boolean {
  return bodyA !== 'dynamic' && bodyB !== 'dynamic';
}
