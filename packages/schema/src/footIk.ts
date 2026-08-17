import { z } from 'zod';
import { guessBoneNames } from './bones.js';

/**
 * Feet that stand on what is actually under them.
 *
 * ## The problem
 *
 * An animation clip is authored on a flat floor. Play it on a staircase and both feet stay in the
 * plane the animator drew them in: the leading foot hangs in the air above the next step, the
 * trailing one sinks through the one below. On a slope the whole character skates along a surface
 * it is not touching. Nothing about the clip is wrong — it simply has no idea what it is standing
 * on, and no amount of blending gives it one.
 *
 * So the ankle is moved after the clip has had its say: each foot is dropped onto the ground beneath
 * it, the hips come down far enough that the lower foot can reach, and the knee is bent to match.
 * Two bones and a law of cosines.
 *
 * ## Why the hips move at all
 *
 * A leg has a finite length. On a step tall enough, planting the upper foot means the lower leg
 * cannot reach its own ground without the pelvis coming down — and a solver that refuses ends up
 * straightening one leg into a stilt. Dropping the hips to the lowest foot's requirement is what
 * every engine does, and it is why a character on stairs looks like it is crouching slightly rather
 * than levitating.
 *
 * `hipDrop` caps it, because the same rule applied to a character standing astride a chasm would put
 * its pelvis at the bottom of the chasm.
 *
 * ## What this is not
 *
 * It is not full-body IK, and it does not touch the arms, the spine or the direction the foot points
 * in. A foot planted at the right height on a steep slope still meets it at the wrong angle — that
 * needs the ankle rotated to the surface normal, which is a further step and a further thing to get
 * wrong. Recorded here rather than implied by the word "IK".
 */

export const FOOT_IK_BONES = [
  'hips',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR',
] as const;
export const FootIkBoneSchema = z.enum(FOOT_IK_BONES);
export type FootIkBone = z.infer<typeof FootIkBoneSchema>;

export const FOOT_IK_BONE_LABELS: Readonly<Record<FootIkBone, string>> = {
  hips: 'Hips',
  thighL: 'Left thigh',
  shinL: 'Left shin',
  footL: 'Left foot',
  thighR: 'Right thigh',
  shinR: 'Right shin',
  footR: 'Right foot',
};

/** Naming patterns per bone, lowercased, most specific first. Shared with the ragdoll binder. */
const PATTERNS: Readonly<Record<FootIkBone, readonly string[]>> = {
  // `hip` before `root` because a rig with both means the hip: `_rootJoint` is the armature's
  // origin, and dropping *that* moves the whole character rather than its pelvis.
  hips: ['hips', 'pelvis', 'hip', 'root'],
  /**
   * `leftleg01` before the generic patterns, and it is not a guess.
   *
   * The one rigged asset this engine ships is a quadruped whose hind legs are named
   * `b_LeftLeg01 → b_LeftLeg02 → b_LeftFoot01`: the segment is distinguished by a number rather
   * than by the words "upper" and "lower". Without this the thigh matched nothing, the leg was
   * never fully bound, and the solver was inert — correctly reported by the panel, and completely
   * useless. Real rigs are the only source of naming patterns worth having.
   */
  thighL: ['leftupleg', 'upperleg_l', 'upper_leg_l', 'thigh_l', 'leftleg01', 'leg01_l', 'leg_l'],
  shinL: ['leftleg02', 'leg02_l', 'leftleg', 'lowerleg_l', 'shin_l', 'calf_l', 'knee_l'],
  footL: ['leftfoot', 'foot_l', 'ankle_l'],
  thighR: ['rightupleg', 'upperleg_r', 'upper_leg_r', 'thigh_r', 'rightleg01', 'leg01_r', 'leg_r'],
  shinR: ['rightleg02', 'leg02_r', 'rightleg', 'lowerleg_r', 'shin_r', 'calf_r', 'knee_r'],
  footR: ['rightfoot', 'foot_r', 'ankle_r'],
};

const BoneBindingSchema = z.object(
  Object.fromEntries(FOOT_IK_BONES.map((bone) => [bone, z.string().default('')])) as Record<
    FootIkBone,
    z.ZodDefault<z.ZodString>
  >,
);

export const FootIkSchema = z.object({
  bones: BoneBindingSchema.default({}),
  /**
   * How far above and below the animated foot the ground is looked for, in metres.
   *
   * Both directions, and the upward half is the one that matters: a foot that has sunk into a step
   * needs the ground *above* it to be found, and a downward-only search reports the floor under the
   * step instead. Half a metre covers a normal stair riser without letting a foot snap to a table.
   */
  reach: z.number().min(0.05).max(3).default(0.5),
  /**
   * How far the hips may come down so the lower foot can reach, in metres.
   *
   * Capped, because the rule that plants a foot on a step would otherwise put a pelvis at the bottom
   * of a chasm the character is standing astride.
   */
  hipDrop: z.number().min(0).max(1.5).default(0.45),
  /**
   * Distance from the ankle joint to the sole, in metres.
   *
   * The solver aims the *ankle*, and the ankle is not the part that touches the ground. Without this
   * every foot is planted with its joint on the floor and the character walks on its shins.
   */
  ankleHeight: z.number().min(0).max(0.5).default(0.1),
  /**
   * How quickly a foot settles onto a new height, as a fraction closed per second.
   *
   * Smoothed rather than snapped, because ground under a walking foot changes in steps: a hard
   * snap at a stair edge is a visible pop, and a pop is what makes people turn foot placement off.
   * Zero is a snap, which is what a test wants and what nobody else does.
   */
  smoothing: z.number().min(0).max(30).default(12),
});
export type FootIk = z.infer<typeof FootIkSchema>;

export const OptionalFootIkSchema = FootIkSchema.nullable().default(null);

export function defaultFootIk(boneNames: readonly string[] = []): FootIk {
  return FootIkSchema.parse({ bones: guessFootIkBones(boneNames) });
}

/**
 * Guesses which bone is which from the names a rig contains.
 *
 * A starting point, overridable field by field, not a rule the runtime trusts. Every exporter names
 * things differently, and a wrong guess here is a knee that bends backwards — visible immediately,
 * which is exactly why the editor shows what it matched rather than applying it silently.
 */
export function guessFootIkBones(boneNames: readonly string[]): Record<FootIkBone, string> {
  return guessBoneNames(FOOT_IK_BONES, PATTERNS, boneNames);
}

/** Which of the two legs have every bone they need. A one-legged binding solves one leg. */
export function boundLegs(ik: FootIk): Array<'L' | 'R'> {
  const legs: Array<'L' | 'R'> = [];
  for (const side of ['L', 'R'] as const) {
    if (ik.bones[`thigh${side}`] && ik.bones[`shin${side}`] && ik.bones[`foot${side}`]) {
      legs.push(side);
    }
  }
  return legs;
}

/** What is wrong with a binding, in the author's terms. */
export function footIkProblems(ik: FootIk): string[] {
  const problems: string[] = [];
  const legs = boundLegs(ik);

  if (legs.length === 0) {
    problems.push(
      'no leg has all three of its bones bound, so nothing will be placed — check the names ' +
        'against the list of bones in this model',
    );
  } else if (legs.length === 1) {
    problems.push(
      `only the ${legs[0] === 'L' ? 'left' : 'right'} leg is bound, so the other foot will keep ` +
        'doing whatever the animation says',
    );
  }

  if (ik.bones.hips === '') {
    problems.push(
      'no hips bone, so the body cannot come down for a foot that is out of reach — a tall step ' +
        'will straighten one leg into a stilt instead',
    );
  }

  if (ik.ankleHeight === 0) {
    problems.push(
      'the ankle height is zero, so the ankle joint itself is planted on the ground and the ' +
        'character walks on its shins',
    );
  }

  return problems;
}
