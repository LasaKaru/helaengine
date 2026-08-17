import * as THREE from 'three';
import { boundLegs, type FootIk as FootIkSettings } from '@helaengine/schema';

/**
 * Feet placed on the ground that is actually beneath them.
 *
 * Runs **after** the animation mixer, every frame, and overwrites what the clip said about three
 * bones per leg. That order is the whole design: the clip decides where the foot is going, and this
 * decides what height it arrives at. Running before the mixer would have the mixer overwrite it,
 * which is the version of this feature that silently does nothing.
 *
 * ## The solve, per leg
 *
 * 1. Ask what the ground is under the animated ankle.
 * 2. Work out how far each ankle needs to move to sit on it.
 * 3. Drop the hips by the larger of the two requirements, capped — a leg has a finite length, and
 *    on a tall step the lower foot cannot reach without the pelvis coming down.
 * 4. Bend the knee so the ankle lands on its target: two bones and a law of cosines.
 *
 * ## Why analytic and not iterative
 *
 * A two-bone chain has a closed-form answer. FABRIK and CCD are for chains where it does not, and
 * they cost iterations per frame to converge on what a cosine gives exactly. The one thing the
 * closed form needs care with is the degenerate case — a perfectly straight leg has no plane to
 * bend in — and that is handled explicitly below rather than left to produce a NaN quaternion, which
 * propagates through the skeleton and makes the whole character vanish.
 */

/** What the solver needs to know about the world. Returns the ground height, or null for a void. */
export type GroundProbe = (x: number, y: number, z: number, reach: number) => number | null;

interface Leg {
  thigh: THREE.Bone;
  shin: THREE.Bone;
  foot: THREE.Bone;
  /** Smoothed vertical offset applied to this ankle, in metres. */
  offset: number;
}

const hipWorld = new THREE.Vector3();
const kneeWorld = new THREE.Vector3();
const footWorld = new THREE.Vector3();
const target = new THREE.Vector3();
const toFoot = new THREE.Vector3();
const toTarget = new THREE.Vector3();
const thighDirection = new THREE.Vector3();
const shinDirection = new THREE.Vector3();
const bendAxis = new THREE.Vector3();
const parentQuaternion = new THREE.Quaternion();
const inverseParent = new THREE.Quaternion();
const localDelta = new THREE.Quaternion();
const rotation = new THREE.Quaternion();
const hipShift = new THREE.Vector3();
const parentBasis = new THREE.Matrix4();
const fallbackAxis = new THREE.Vector3(1, 0, 0);

export class FootIk {
  readonly #legs: Leg[] = [];
  readonly #hips: THREE.Bone | null;
  readonly #settings: FootIkSettings;
  /** Smoothed hip drop, in metres. Kept between frames so a stair edge does not pop. */
  #hipOffset = 0;
  /** The hips bone's authored local position, so the drop is applied to the clip, not accumulated. */
  readonly #hipRest = new THREE.Vector3();

  constructor(root: THREE.Object3D, settings: FootIkSettings) {
    this.#settings = settings;

    const bone = (name: string): THREE.Bone | null =>
      name === '' ? null : ((root.getObjectByName(name) as THREE.Bone | undefined) ?? null);

    this.#hips = bone(settings.bones.hips);
    if (this.#hips) this.#hipRest.copy(this.#hips.position);

    for (const side of boundLegs(settings)) {
      const thigh = bone(settings.bones[`thigh${side}`]);
      const shin = bone(settings.bones[`shin${side}`]);
      const foot = bone(settings.bones[`foot${side}`]);
      // A binding that names bones this model does not have is a binding that solves nothing. It is
      // dropped here rather than guarded at every step below, and the editor reports the mismatch.
      if (thigh && shin && foot) this.#legs.push({ thigh, shin, foot, offset: 0 });
    }
  }

  /** Legs this rig actually resolved. Zero means the solver is inert, which the editor reports. */
  get legCount(): number {
    return this.#legs.length;
  }

  /** How far the hips are currently dropped, in metres. Read by the tests and the statistics. */
  get hipOffset(): number {
    return this.#hipOffset;
  }

  /**
   * Places both feet for this frame.
   *
   * `deltaSeconds` drives the smoothing only. The solve itself is stateless — it reads where the
   * clip has just put the bones and writes where they should be, so a paused game holds its pose
   * rather than drifting.
   */
  solve(deltaSeconds: number, ground: GroundProbe): void {
    if (this.#legs.length === 0) return;
    const { reach, hipDrop, ankleHeight, smoothing } = this.#settings;

    // The clip has just moved the bones; their world matrices are still last frame's until this.
    this.#legs[0]!.thigh.updateWorldMatrix(true, false);

    let deepest = 0;
    const wanted: Array<number | null> = [];

    for (const leg of this.#legs) {
      leg.foot.updateWorldMatrix(true, false);
      leg.foot.getWorldPosition(footWorld);
      const height = ground(footWorld.x, footWorld.y, footWorld.z, reach);
      if (height === null) {
        // No ground within reach: a foot over a ledge keeps whatever the animation said, which is
        // the honest answer. Pulling it to the nearest surface would snap a walking character's
        // trailing foot backwards onto the step it just left.
        wanted.push(null);
        continue;
      }
      const desired = height + ankleHeight - footWorld.y;
      wanted.push(desired);
      // The most negative requirement, which is the foot standing on the lowest ground. A positive
      // requirement is a foot that has sunk *into* a step and needs lifting, and lifting is free.
      deepest = Math.min(deepest, desired);
    }

    // Capped, or a character standing astride a chasm puts its pelvis at the bottom of it.
    const hipTarget = Math.max(-hipDrop, deepest);
    this.#hipOffset = approach(this.#hipOffset, hipTarget, smoothing, deltaSeconds);
    if (this.#hips) {
      /**
       * The drop is metres of *world* height, and a bone's position is in its parent's space.
       *
       * For an upright character those coincide, which is why writing straight to `position.y`
       * looked right — and why the error only appears on a character that is leaning: a rig tilted
       * twenty degrees moved its feet by the cosine of the tilt and landed short. Converted as a
       * direction rather than a point, so the parent's translation is not counted.
       */
      hipShift.set(0, this.#hipOffset, 0);
      if (this.#hips.parent) {
        this.#hips.parent.updateWorldMatrix(true, false);
        parentBasis.extractRotation(this.#hips.parent.matrixWorld).invert();
        hipShift.applyMatrix4(parentBasis);
      }
      // Written against the clip's own value rather than added to the current one, so the drop does
      // not accumulate a little further every frame until the character is underground.
      this.#hips.position.copy(this.#hipRest).add(hipShift);
      this.#hips.updateWorldMatrix(true, true);
    }

    for (const [index, leg] of this.#legs.entries()) {
      const desired = wanted[index];
      // Towards zero for a foot with no ground: it returns to the clip's pose rather than holding
      // whatever offset it had when it walked off the edge.
      leg.offset = approach(leg.offset, desired ?? 0, smoothing, deltaSeconds);
      /**
       * Nothing to move means nothing is touched, and that is a promise rather than an optimisation.
       *
       * The two-bone solve clamps its target just short of a straight leg, so asking it to put the
       * ankle exactly where it already is still bends the knee by a fraction of a degree. Over a
       * level of flat ground that is every character being quietly re-posed by a solver with no work
       * to do — a visible change for no benefit, which is the worst kind.
       */
      if (Math.abs(leg.offset) < 1e-4) continue;

      leg.foot.getWorldPosition(footWorld);
      target.copy(footWorld);
      // Relative to where the clip put the ankle *after* the hips moved, so the hip drop is not
      // counted twice.
      target.y = footWorld.y + leg.offset - this.#hipOffset;
      solveTwoBone(leg.thigh, leg.shin, leg.foot, target);
    }
  }
}

/** Moves `value` a fraction of the way to `goal`. Rate 0 is a snap, which is what a test wants. */
function approach(value: number, goal: number, rate: number, deltaSeconds: number): number {
  if (rate <= 0) return goal;
  // Exponential rather than linear, so the result does not depend on the frame rate — a linear step
  // per frame settles twice as fast at 120fps as at 60, and the feet visibly lag on a slow machine.
  return goal + (value - goal) * Math.exp(-rate * deltaSeconds);
}

/**
 * Bends a two-bone chain so its end lands on `target`.
 *
 * Rotations are computed in world space and written in the bone's parent space, because that is
 * where a bone's own transform lives — writing a world rotation onto a bone whose parent is rotated
 * gives a leg that is right only when the character faces down the negative Z axis, which is exactly
 * the bug that survives testing on a character that never turns round.
 */
function solveTwoBone(
  thigh: THREE.Bone,
  shin: THREE.Bone,
  foot: THREE.Bone,
  goal: THREE.Vector3,
): void {
  thigh.getWorldPosition(hipWorld);
  shin.getWorldPosition(kneeWorld);
  foot.getWorldPosition(footWorld);

  const upper = hipWorld.distanceTo(kneeWorld);
  const lower = kneeWorld.distanceTo(footWorld);
  if (upper < 1e-5 || lower < 1e-5) return;

  toTarget.subVectors(goal, hipWorld);
  const wantedLength = toTarget.length();
  if (wantedLength < 1e-5) return;

  /**
   * The bend plane's normal.
   *
   * A perfectly straight leg has no plane — the cross product is zero and normalising it is a NaN
   * that propagates through every child bone and makes the character disappear. Clips almost never
   * hold a leg exactly straight, which is precisely why this case survives to production: it turns
   * up on the one frame of the one clip that does.
   */
  thighDirection.subVectors(kneeWorld, hipWorld).normalize();
  shinDirection.subVectors(footWorld, kneeWorld).normalize();
  bendAxis.crossVectors(thighDirection, shinDirection);
  if (bendAxis.lengthSq() < 1e-8) {
    // Sideways relative to the leg, so the knee bends the way a knee bends rather than sideways.
    bendAxis.crossVectors(thighDirection, fallbackAxis);
    if (bendAxis.lengthSq() < 1e-8) return;
  }
  bendAxis.normalize();

  // Just short of straight, and just outside folded: at exactly the limits the cosine is ±1 and the
  // arithmetic is fine, but the leg is then in the degenerate pose above on the *next* frame.
  const span = Math.min(
    Math.max(wantedLength, Math.abs(upper - lower) + 1e-3),
    upper + lower - 1e-3,
  );

  const currentThighAngle = angleAt(upper, footWorld.distanceTo(hipWorld), lower);
  const wantedThighAngle = angleAt(upper, span, lower);
  const currentKneeAngle = angleAt(upper, lower, footWorld.distanceTo(hipWorld));
  const wantedKneeAngle = angleAt(upper, lower, span);

  applyWorldRotation(thigh, bendAxis, wantedThighAngle - currentThighAngle);
  applyWorldRotation(shin, bendAxis, wantedKneeAngle - currentKneeAngle);

  // Now the chain is the right *length*; aim it at the target. Second, because aiming first and
  // bending after would swing the bent leg away from where it was just pointed.
  thigh.updateWorldMatrix(true, true);
  foot.getWorldPosition(footWorld);
  thigh.getWorldPosition(hipWorld);
  toFoot.subVectors(footWorld, hipWorld);
  toTarget.subVectors(goal, hipWorld);
  if (toFoot.lengthSq() < 1e-10 || toTarget.lengthSq() < 1e-10) return;
  rotation.setFromUnitVectors(toFoot.normalize(), toTarget.normalize());
  applyWorldQuaternion(thigh, rotation);
  thigh.updateWorldMatrix(true, true);
}

/** The angle at the corner opposite `opposite`, in a triangle with the other two sides given. */
function angleAt(a: number, b: number, opposite: number): number {
  const cosine = (a * a + b * b - opposite * opposite) / (2 * a * b);
  return Math.acos(Math.min(1, Math.max(-1, cosine)));
}

/** Rotates a bone by an angle about a world-space axis. */
function applyWorldRotation(bone: THREE.Bone, axis: THREE.Vector3, angle: number): void {
  if (Math.abs(angle) < 1e-6) return;
  rotation.setFromAxisAngle(axis, angle);
  applyWorldQuaternion(bone, rotation);
}

/**
 * Pre-multiplies a world-space rotation onto a bone's local orientation.
 *
 * The parent's world rotation is taken out and put back, which is what makes this work on a
 * character facing any direction. Without it the leg is solved in the model's own axes and is
 * correct only while the character faces the way it was authored.
 */
function applyWorldQuaternion(bone: THREE.Bone, delta: THREE.Quaternion): void {
  if (bone.parent) bone.parent.getWorldQuaternion(parentQuaternion);
  else parentQuaternion.identity();

  // Scratch rather than `clone()`: this runs twice per leg per frame, and a quaternion allocated
  // sixty times a second is garbage the collector has to come back for during gameplay.
  inverseParent.copy(parentQuaternion).invert();
  localDelta.copy(inverseParent).multiply(delta).multiply(parentQuaternion);
  bone.quaternion.premultiply(localDelta);
}
