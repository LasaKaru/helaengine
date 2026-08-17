import * as THREE from 'three';
import { FootIkSchema, guessFootIkBones } from '@helaengine/schema';
import { describe, expect, it } from 'vitest';
import { FootIk } from './FootIk.js';

/**
 * The foot placer, against a rig built here rather than loaded from a file.
 *
 * A synthetic skeleton is the point, not a shortcut: it has known bone lengths, so "the ankle landed
 * where it was asked to" is a number rather than an impression. A test against a real character
 * could only assert that something moved.
 *
 * What a browser has to prove instead — that this runs after the mixer rather than being overwritten
 * by it — is in `apps/editor/e2e/foot-ik.spec.ts`.
 */

/**
 * A two-legged rig, one metre of thigh and one of shin, feet at the origin's height.
 *
 * Bone names follow Mixamo's convention, so the binder is exercised on the naming that most imported
 * characters actually use rather than on names invented to suit it.
 */
function rig(): { root: THREE.Object3D; bones: Record<string, THREE.Bone> } {
  const bones: Record<string, THREE.Bone> = {};
  const make = (name: string, parent: THREE.Object3D, y: number): THREE.Bone => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(0, y, 0);
    parent.add(bone);
    bones[name] = bone;
    return bone;
  };

  const root = new THREE.Group();
  const hips = make('mixamorig:Hips', root, 2);

  for (const [side, offset] of [
    ['Left', -0.2],
    ['Right', 0.2],
  ] as const) {
    const thigh = make(`mixamorig:${side}UpLeg`, hips, 0);
    thigh.position.x = offset;
    const shin = make(`mixamorig:${side}Leg`, thigh, -1);
    make(`mixamorig:${side}Foot`, shin, -1);
  }

  root.updateMatrixWorld(true);
  return { root, bones };
}

function settings(overrides: Record<string, unknown> = {}) {
  return FootIkSchema.parse({
    bones: guessFootIkBones(Object.keys(rig().bones)),
    // Zero smoothing: a test wants the answer, not the answer approached over half a second.
    smoothing: 0,
    ankleHeight: 0,
    ...overrides,
  });
}

/** Ground everywhere at one height. */
const level = (height: number) => (): number => height;

function footY(bones: Record<string, THREE.Bone>, side: 'Left' | 'Right'): number {
  const foot = bones[`mixamorig:${side}Foot`]!;
  foot.updateWorldMatrix(true, false);
  return foot.getWorldPosition(new THREE.Vector3()).y;
}

describe('guessFootIkBones', () => {
  it('binds a Mixamo rig, and does not cross the sides over', () => {
    const bound = guessFootIkBones(Object.keys(rig().bones));
    expect(bound.hips).toBe('mixamorig:Hips');
    expect(bound.thighL).toBe('mixamorig:LeftUpLeg');
    expect(bound.shinL).toBe('mixamorig:LeftLeg');
    expect(bound.footL).toBe('mixamorig:LeftFoot');
    expect(bound.thighR).toBe('mixamorig:RightUpLeg');
    expect(bound.footR).toBe('mixamorig:RightFoot');
  });

  it('leaves a bone it cannot find empty rather than guessing wildly', () => {
    // An empty binding is a leg that is not solved, which the panel reports. A wrong one is a knee
    // that bends backwards, which nothing reports.
    const bound = guessFootIkBones(['Armature', 'Bone', 'Bone.001']);
    expect(Object.values(bound).every((name) => name === '')).toBe(true);
  });
});

describe('FootIk', () => {
  it('lands the ankle on ground below the animated pose', () => {
    const { root, bones } = rig();
    const ik = new FootIk(root, settings());
    expect(ik.legCount).toBe(2);

    // Feet start at y = 0. The ground is 30cm lower.
    expect(footY(bones, 'Left')).toBeCloseTo(0, 5);
    ik.solve(1 / 60, level(-0.3));
    expect(footY(bones, 'Left')).toBeCloseTo(-0.3, 2);
    expect(footY(bones, 'Right')).toBeCloseTo(-0.3, 2);
  });

  it('lifts an ankle that has sunk into a step', () => {
    /**
     * The other direction, and the one a downward-only search gets wrong. A foot inside a stair
     * riser has to come *up* to the tread — and looking only downwards finds the floor beneath the
     * step, which puts the foot further in.
     */
    const { root, bones } = rig();
    const ik = new FootIk(root, settings());
    ik.solve(1 / 60, level(0.25));
    expect(footY(bones, 'Left')).toBeCloseTo(0.25, 2);
  });

  it('leaves the pose alone when the ground is exactly where the clip put the foot', () => {
    /**
     * The control. Ground at the animated height must produce the animated pose, bone for bone —
     * otherwise every character on flat ground is being subtly re-posed by a solver that had nothing
     * to do, and the feature costs a visible change for no benefit.
     */
    const { root, bones } = rig();
    const before = bones['mixamorig:LeftUpLeg']!.quaternion.clone();

    new FootIk(root, settings()).solve(1 / 60, level(0));

    expect(bones['mixamorig:LeftUpLeg']!.quaternion.angleTo(before)).toBeLessThan(1e-3);
    expect(footY(bones, 'Left')).toBeCloseTo(0, 4);
  });

  it('drops the hips for ground the leg cannot reach, and no further than the cap', () => {
    const { root, bones } = rig();
    const ik = new FootIk(root, settings({ hipDrop: 0.4 }));

    // A metre down is well beyond a two-metre leg's remaining slack from a straight-ish pose.
    ik.solve(1 / 60, level(-1));
    expect(ik.hipOffset).toBeCloseTo(-0.4, 3);
    expect(bones['mixamorig:Hips']!.position.y).toBeCloseTo(1.6, 3);
  });

  it('does not let the hip drop accumulate frame after frame', () => {
    // Written against the clip's own value rather than added to the current one. Adding is the bug
    // that walks a character into the ground over a few seconds, and it looks like a physics fault.
    const { root } = rig();
    const ik = new FootIk(root, settings({ hipDrop: 0.4 }));
    for (let frame = 0; frame < 60; frame += 1) ik.solve(1 / 60, level(-1));
    expect(ik.hipOffset).toBeCloseTo(-0.4, 3);
  });

  it('leaves a foot over a void where the animation put it', () => {
    // Pulling it to the nearest surface would snap a walking character's trailing foot backwards
    // onto the step it just left.
    const { root, bones } = rig();
    new FootIk(root, settings()).solve(1 / 60, () => null);
    expect(footY(bones, 'Left')).toBeCloseTo(0, 4);
  });

  it('works on a character facing any direction', () => {
    /**
     * The bug this exists to catch: rotations computed in world space and written straight onto a
     * bone are correct only while the character faces the way it was authored. Turn it round and the
     * leg swings sideways.
     */
    const { root, bones } = rig();
    // Tilted as well as turned. A turn about Y alone is not enough: with a vertical target and an
    // upright character the world-space and parent-space answers happen to agree, and a solver that
    // skipped the conversion entirely still passed. Leaning the rig is what separates them.
    root.rotation.set(0.35, Math.PI / 3, 0.4);
    root.updateMatrixWorld(true);

    new FootIk(root, settings()).solve(1 / 60, level(-0.3));
    expect(footY(bones, 'Left')).toBeCloseTo(-0.3, 2);
    expect(footY(bones, 'Right')).toBeCloseTo(-0.3, 2);
  });

  it('bends one knee more than the other on a slope', () => {
    /**
     * The case that exercises the *solver* rather than the hip drop. On level ground both feet want
     * the same offset, the hips take all of it, and the two-bone solve has nothing left to do — so a
     * test on flat ground proves nothing about the knees. A slope gives the two legs different work.
     */
    const { root, bones } = rig();
    // Ground falling away to the left: the left foot is at x ≈ -0.2, the right at x ≈ +0.2.
    const slope = (x: number): number => x * 0.75;
    new FootIk(root, settings()).solve(1 / 60, slope);

    expect(footY(bones, 'Left')).toBeCloseTo(-0.15, 2);
    expect(footY(bones, 'Right')).toBeCloseTo(0.15, 2);

    // And the knees are genuinely doing different amounts: the downhill leg is the straighter one.
    const bend = (side: 'Left' | 'Right'): number =>
      Math.abs(bones[`mixamorig:${side}Leg`]!.quaternion.angleTo(new THREE.Quaternion()));
    expect(Math.abs(bend('Left') - bend('Right'))).toBeGreaterThan(0.01);
  });

  it('survives a perfectly straight leg', () => {
    /**
     * A straight leg has no bend plane — the cross product is zero, normalising it is NaN, and a NaN
     * quaternion propagates through every child bone and makes the character disappear. Clips almost
     * never hold a leg exactly straight, which is exactly why this survives to production: it turns
     * up on the one frame of the one clip that does.
     */
    const { root, bones } = rig();
    new FootIk(root, settings()).solve(1 / 60, level(-0.2));
    const quaternion = bones['mixamorig:LeftUpLeg']!.quaternion;
    expect(Number.isFinite(quaternion.x + quaternion.y + quaternion.z + quaternion.w)).toBe(true);
    expect(footY(bones, 'Left')).toBeCloseTo(-0.2, 2);
  });

  it('smooths towards the new height rather than snapping to it', () => {
    // A hard snap at a stair edge is a visible pop, and a pop is what makes people switch foot
    // placement off. One frame at a realistic rate covers part of the way, not all of it.
    const { root, bones } = rig();
    new FootIk(root, settings({ smoothing: 12 })).solve(1 / 60, level(-0.3));
    const after = footY(bones, 'Left');
    expect(after).toBeLessThan(-0.02);
    expect(after).toBeGreaterThan(-0.28);
  });

  it('solves nothing when no leg is bound', () => {
    const { root, bones } = rig();
    const ik = new FootIk(root, FootIkSchema.parse({ smoothing: 0 }));
    expect(ik.legCount).toBe(0);
    ik.solve(1 / 60, level(-0.5));
    expect(footY(bones, 'Left')).toBeCloseTo(0, 5);
  });
});
