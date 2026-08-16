import { z } from 'zod';

/**
 * A character that goes limp.
 *
 * On death the animator stops driving the skeleton and physics takes it over: eleven capsules, one
 * per limb, held together by ball joints and seeded from the pose the character died in. The bones
 * are then written *from* the bodies each frame, which is the same relationship the animator had to
 * them, from the other direction.
 *
 * ## Why a fixed set of parts
 *
 * A closed vocabulary of eleven, not "every bone in the rig". A hand has twenty bones and simulating
 * them buys nothing a viewer can see, while costing twenty bodies and twenty joints per corpse — and
 * a level where six enemies die is then simulating a hundred and twenty bodies to animate fingers
 * nobody is looking at. Eleven is where a ragdoll stops reading as a mannequin and more stops being
 * visible.
 *
 * It is also what makes the feature *authorable*. Eleven named parts is a form somebody can fill in;
 * "map your skeleton" is not.
 *
 * ## Why bones are bound by name, like animation clips
 *
 * The same reasoning as `animation.ts`: two rigs from different packs never agree on names. Mixamo
 * calls it `mixamorig:LeftUpLeg`, Quaternius calls it `Upper_Leg_L`. Binding per asset means
 * swapping a model is a manifest change rather than a search through every scene.
 */

export const RAGDOLL_PARTS = [
  'hips',
  'spine',
  'head',
  'armUpperL',
  'armLowerL',
  'armUpperR',
  'armLowerR',
  'legUpperL',
  'legLowerL',
  'legUpperR',
  'legLowerR',
] as const;
export const RagdollPartSchema = z.enum(RAGDOLL_PARTS);
export type RagdollPart = (typeof RAGDOLL_PARTS)[number];

/**
 * What each part hangs from. `hips` is the root and hangs from nothing.
 *
 * A tree rather than a list, because a ragdoll *is* the tree: every entry here becomes one ball
 * joint at runtime, and a part with no parent would be a limb that falls off.
 */
export const RAGDOLL_PARENT: Readonly<Record<RagdollPart, RagdollPart | null>> = {
  hips: null,
  spine: 'hips',
  head: 'spine',
  armUpperL: 'spine',
  armLowerL: 'armUpperL',
  armUpperR: 'spine',
  armLowerR: 'armUpperR',
  legUpperL: 'hips',
  legLowerL: 'legUpperL',
  legUpperR: 'hips',
  legLowerR: 'legUpperR',
};

export const RAGDOLL_LABELS: Readonly<Record<RagdollPart, string>> = {
  hips: 'Hips',
  spine: 'Spine',
  head: 'Head',
  armUpperL: 'Left upper arm',
  armLowerL: 'Left forearm',
  armUpperR: 'Right upper arm',
  armLowerR: 'Right forearm',
  legUpperL: 'Left thigh',
  legLowerL: 'Left shin',
  legUpperR: 'Right thigh',
  legLowerR: 'Right shin',
};

/**
 * Roughly what fraction of body mass each part carries.
 *
 * Anthropometric rather than uniform, and it matters more than it sounds: equal masses give a
 * corpse that pivots around its chest like a starfish, because the head weighs as much as a thigh.
 * A heavy pelvis and light forearms are most of what makes a fall read as a body falling.
 */
export const RAGDOLL_MASS_SHARE: Readonly<Record<RagdollPart, number>> = {
  hips: 0.26,
  spine: 0.2,
  head: 0.08,
  armUpperL: 0.03,
  armLowerL: 0.02,
  armUpperR: 0.03,
  armLowerR: 0.02,
  legUpperL: 0.12,
  legLowerL: 0.05,
  legUpperR: 0.12,
  legLowerR: 0.05,
};

export const RagdollSchema = z.object({
  /** Bone name per part. An empty string means "this rig has no such bone", and the part is skipped. */
  bones: z
    .object(
      Object.fromEntries(RAGDOLL_PARTS.map((part) => [part, z.string().max(120).default('')])) as {
        [K in RagdollPart]: z.ZodDefault<z.ZodString>;
      },
    )
    .default({}),
  /** Total mass of the character in kilograms, shared out over the parts. */
  mass: z.number().min(1).max(1000).default(70),
  /**
   * How much of the character's motion the corpse inherits, as a fraction.
   *
   * One is "keep everything", which sends a sprinting enemy tumbling forward — correct, and
   * occasionally comic. Zero drops them on the spot. The default keeps most of it, because a body
   * that stops dead the instant it dies reads as the animation having been switched off, which is
   * exactly what happened and exactly what should not be visible.
   */
  inheritVelocity: z.number().min(0).max(1).default(0.8),
  /** Seconds before the corpse is removed, or 0 to leave it. */
  lifetime: z.number().min(0).max(300).default(0),
  /** Radius of the limb capsules as a fraction of their length. */
  thickness: z.number().min(0.05).max(1).default(0.28),
});
export type Ragdoll = z.infer<typeof RagdollSchema>;

export const OptionalRagdollSchema = RagdollSchema.nullable().default(null);

export function defaultRagdoll(): Ragdoll {
  return RagdollSchema.parse({});
}

/**
 * Common naming patterns for each part, lowercased, in order of preference.
 *
 * Side markers are deliberately matched as separated tokens (`_l`, `.l`, `left`) rather than a bare
 * `l`, because half the bones in a rig contain the letter L — `Shoulder` and `Pelvis` among them —
 * and a naive match binds the left forearm to the pelvis with total confidence.
 */
const PATTERNS: Readonly<Record<RagdollPart, readonly string[]>> = {
  hips: ['hips', 'pelvis', 'root'],
  spine: ['spine2', 'spine1', 'chest', 'spine', 'torso'],
  head: ['head', 'neck'],
  armUpperL: ['leftarm', 'upperarm_l', 'upper_arm_l', 'arm_l', 'shoulder_l'],
  armLowerL: ['leftforearm', 'lowerarm_l', 'forearm_l', 'elbow_l'],
  armUpperR: ['rightarm', 'upperarm_r', 'upper_arm_r', 'arm_r', 'shoulder_r'],
  armLowerR: ['rightforearm', 'lowerarm_r', 'forearm_r', 'elbow_r'],
  legUpperL: ['leftupleg', 'upperleg_l', 'upper_leg_l', 'thigh_l', 'leg_l'],
  legLowerL: ['leftleg', 'lowerleg_l', 'shin_l', 'calf_l', 'knee_l'],
  legUpperR: ['rightupleg', 'upperleg_r', 'upper_leg_r', 'thigh_r', 'leg_r'],
  legLowerR: ['rightleg', 'lowerleg_r', 'shin_r', 'calf_r', 'knee_r'],
};

/** Bone name reduced to something the patterns can be compared against. */
function normalise(name: string): string {
  // `mixamorig:LeftUpLeg` and `Bone.Left.Up.Leg` both become `leftupleg`. Separators go because
  // every exporter picks a different one, and the tokens either side are what carry the meaning.
  return name
    .toLowerCase()
    .replace(/^.*[:|]/, '')
    .replace(/[\s._-]+/g, '');
}

/** True when a normalised bone name carries the given side marker. */
function sided(normalised: string, side: 'l' | 'r'): boolean {
  const other = side === 'l' ? 'r' : 'l';
  const word = side === 'l' ? 'left' : 'right';
  const otherWord = side === 'l' ? 'right' : 'left';

  if (normalised.includes(otherWord)) return false;
  if (normalised.includes(word)) return true;
  // A trailing marker, which is what survives normalising `Thigh_L`. Anchored to the end so
  // `Clavicle` does not read as a left-hand bone.
  if (normalised.endsWith(other)) return false;
  return normalised.endsWith(side);
}

/**
 * Guesses a bone binding from the names a rig actually contains.
 *
 * A guess, offered as a starting point and overridable field by field — not a rule the runtime
 * trusts. Every exporter names things differently and a wrong guess is visible the moment a corpse
 * folds the wrong way, so the editor shows what was matched rather than applying it silently.
 */
export function guessRagdollBones(boneNames: readonly string[]): Record<RagdollPart, string> {
  const bound = Object.fromEntries(RAGDOLL_PARTS.map((part) => [part, ''])) as Record<
    RagdollPart,
    string
  >;
  const taken = new Set<string>();

  for (const part of RAGDOLL_PARTS) {
    const wantsSide = part.endsWith('L') ? 'l' : part.endsWith('R') ? 'r' : null;

    for (const pattern of PATTERNS[part]) {
      const match = boneNames.find((name) => {
        if (taken.has(name)) return false;
        const flat = normalise(name);
        if (!flat.includes(pattern.replace(/[\s._-]+/g, ''))) return false;
        return wantsSide === null || sided(flat, wantsSide);
      });

      if (match) {
        bound[part] = match;
        // Claimed, so `spine` cannot also match the bone `hips` already took — the patterns overlap
        // deliberately, and first-come is what keeps the more specific pattern winning.
        taken.add(match);
        break;
      }
    }
  }

  return bound;
}

/** Parts that have a bone bound, in an order where a parent always precedes its children. */
export function boundParts(ragdoll: Ragdoll): RagdollPart[] {
  return RAGDOLL_PARTS.filter((part) => ragdoll.bones[part] !== '');
}

/**
 * Problems that would make a ragdoll collapse strangely, or not at all.
 *
 * Reported rather than thrown: a half-bound rig is what a character looks like mid-setup, and the
 * editor should say what is missing rather than refuse the document.
 */
export function ragdollProblems(ragdoll: Ragdoll): string[] {
  const problems: string[] = [];
  const bound = new Set(boundParts(ragdoll));

  if (bound.size === 0) {
    problems.push('no bones bound, so nothing will go limp');
    return problems;
  }

  if (!bound.has('hips')) {
    // Everything hangs from the hips. Without them each limb is its own island, and the character
    // comes apart into eleven pieces rather than falling over.
    problems.push('the hips are not bound — every other part hangs from them');
  }

  for (const part of bound) {
    const parent = RAGDOLL_PARENT[part];
    if (parent !== null && !bound.has(parent)) {
      problems.push(
        `${RAGDOLL_LABELS[part]} is bound but ${RAGDOLL_LABELS[parent]} is not, so it will fall off`,
      );
    }
  }

  return problems;
}
