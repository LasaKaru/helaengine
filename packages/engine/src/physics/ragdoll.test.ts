import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  RagdollSchema,
  guessRagdollBones,
  ragdollProblems,
  type Ragdoll,
} from '@helaengine/schema';
import { PhysicsWorld } from './PhysicsWorld.js';
import { RagdollBody } from './Ragdoll.js';
import { initPhysics, type RapierModule } from './rapier.js';

/**
 * A skeleton handed over to physics.
 *
 * The claims worth pinning are the ones a document cannot express: that the bones actually move,
 * that the character falls *over* rather than apart, and that the corpse ends up on the floor rather
 * than through it. All of them are read off a real skeleton after stepping a real solver.
 */

let rapier: RapierModule;

beforeAll(async () => {
  rapier = await initPhysics();
}, 30_000);

const settings = (input: Record<string, unknown> = {}): Ragdoll => RagdollSchema.parse(input);

/** Bone names in the Mixamo convention, which is what most downloaded characters use. */
const MIXAMO = [
  'mixamorig:Hips',
  'mixamorig:Spine',
  'mixamorig:Spine1',
  'mixamorig:Spine2',
  'mixamorig:Neck',
  'mixamorig:Head',
  'mixamorig:LeftShoulder',
  'mixamorig:LeftArm',
  'mixamorig:LeftForeArm',
  'mixamorig:LeftHand',
  'mixamorig:RightShoulder',
  'mixamorig:RightArm',
  'mixamorig:RightForeArm',
  'mixamorig:RightHand',
  'mixamorig:LeftUpLeg',
  'mixamorig:LeftLeg',
  'mixamorig:LeftFoot',
  'mixamorig:RightUpLeg',
  'mixamorig:RightLeg',
  'mixamorig:RightFoot',
];

/**
 * A standing figure, roughly human-proportioned, as a real bone hierarchy.
 *
 * Built rather than loaded, because a `.glb` fixture would make these tests depend on an asset
 * pipeline they are not testing — and the thing under test is the arithmetic between bones and
 * bodies, which does not care where the bones came from.
 */
function skeleton(): { root: THREE.Object3D; bones: Map<string, THREE.Bone> } {
  const root = new THREE.Object3D();
  const bones = new Map<string, THREE.Bone>();

  const add = (
    name: string,
    parent: THREE.Object3D,
    offset: [number, number, number],
  ): THREE.Bone => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(...offset);
    parent.add(bone);
    bones.set(name, bone);
    return bone;
  };

  const hips = add('mixamorig:Hips', root, [0, 1, 0]);
  const spine = add('mixamorig:Spine', hips, [0, 0.25, 0]);
  const spine2 = add('mixamorig:Spine2', spine, [0, 0.25, 0]);
  const neck = add('mixamorig:Neck', spine2, [0, 0.2, 0]);
  add('mixamorig:Head', neck, [0, 0.15, 0]);

  for (const [side, x] of [
    ['Left', 1],
    ['Right', -1],
  ] as const) {
    const arm = add(`mixamorig:${side}Arm`, spine2, [x * 0.2, 0.1, 0]);
    const fore = add(`mixamorig:${side}ForeArm`, arm, [x * 0.28, 0, 0]);
    add(`mixamorig:${side}Hand`, fore, [x * 0.25, 0, 0]);

    const upLeg = add(`mixamorig:${side}UpLeg`, hips, [x * 0.1, -0.05, 0]);
    const leg = add(`mixamorig:${side}Leg`, upLeg, [0, -0.45, 0]);
    add(`mixamorig:${side}Foot`, leg, [0, -0.42, 0]);
  }

  root.updateMatrixWorld(true);
  return { root, bones };
}

/** A world with a floor, and the figure standing on it. */
function rig(input: Record<string, unknown> = {}): {
  world: PhysicsWorld;
  root: THREE.Object3D;
  bones: Map<string, THREE.Bone>;
  ragdoll: Ragdoll;
} {
  const world = new PhysicsWorld(rapier, { gravity: 9.81 });

  const ground = new THREE.Object3D();
  ground.position.set(0, -1, 0);
  ground.updateMatrixWorld(true);
  world.addObject({
    objectId: 'ground',
    node: ground,
    shape: 'box',
    body: 'static',
    size: [100, 1, 100],
  });

  const { root, bones } = skeleton();
  const ragdoll = settings({ bones: guessRagdollBones(MIXAMO), ...input });
  return { world, root, bones, ragdoll };
}

function run(world: PhysicsWorld, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) world.step(1 / 60);
}

describe('binding bones', () => {
  it('recognises the Mixamo convention', () => {
    const bound = guessRagdollBones(MIXAMO);

    expect(bound.hips).toBe('mixamorig:Hips');
    expect(bound.head).toBe('mixamorig:Head');
    expect(bound.legUpperL).toBe('mixamorig:LeftUpLeg');
    expect(bound.legLowerR).toBe('mixamorig:RightLeg');
    expect(bound.armLowerL).toBe('mixamorig:LeftForeArm');
  });

  it('does not cross the sides over', () => {
    /**
     * The trap this exists for.
     *
     * Half the bones in a rig contain the letter L — `Shoulder`, `Pelvis`, `Clavicle` — so a side
     * marker matched as a bare letter binds the left forearm to the pelvis with total confidence,
     * and the corpse folds inside out in a way that looks like a solver bug.
     */
    const bound = guessRagdollBones(MIXAMO);
    expect(bound.armUpperL).toContain('Left');
    expect(bound.armUpperR).toContain('Right');
    expect(bound.legUpperL).toContain('Left');
    expect(bound.legUpperR).toContain('Right');
  });

  it('reads an underscore convention too', () => {
    // Quaternius and most Blender exports, which never agree with Mixamo about anything.
    const bound = guessRagdollBones([
      'Pelvis',
      'Chest',
      'Head',
      'Upper_Arm_L',
      'Lower_Arm_L',
      'Upper_Arm_R',
      'Lower_Arm_R',
      'Thigh_L',
      'Shin_L',
      'Thigh_R',
      'Shin_R',
    ]);

    expect(bound.hips).toBe('Pelvis');
    expect(bound.armUpperL).toBe('Upper_Arm_L');
    expect(bound.legLowerR).toBe('Shin_R');
  });

  it('binds nothing it cannot recognise, rather than guessing wildly', () => {
    // A wrong binding is worse than none: it produces a corpse that folds the wrong way, which
    // looks like the ragdoll being broken rather than like the rig being unusual.
    const bound = guessRagdollBones(['b0', 'b1', 'b2']);
    expect(Object.values(bound).every((name) => name === '')).toBe(true);
  });

  it('never binds one bone to two parts', () => {
    const bound = guessRagdollBones(MIXAMO);
    const used = Object.values(bound).filter((name) => name !== '');
    expect(new Set(used).size).toBe(used.length);
  });
});

describe('going limp', () => {
  it('builds a body for every bound part', () => {
    const { world, root, ragdoll } = rig();
    const body = new RagdollBody(world, 'enemy', root, ragdoll);

    expect(body.limbCount).toBe(11);
    body.dispose();
    world.dispose();
  });

  it('moves the bones, where a standing figure would not', () => {
    // The control case: the same skeleton with no ragdoll built stays exactly where it was, so
    // "the bones moved" is a claim about physics rather than about floating-point noise.
    const still = rig();
    const before = still.bones.get('mixamorig:Head')!.getWorldPosition(new THREE.Vector3());
    run(still.world, 1);
    const after = still.bones.get('mixamorig:Head')!.getWorldPosition(new THREE.Vector3());
    expect(after.distanceTo(before)).toBeLessThan(1e-6);
    still.world.dispose();

    const limp = rig();
    const start = limp.bones.get('mixamorig:Head')!.getWorldPosition(new THREE.Vector3());
    const body = new RagdollBody(limp.world, 'enemy', limp.root, limp.ragdoll);
    limp.world.adoptRagdoll(body);
    run(limp.world, 1);
    limp.root.updateMatrixWorld(true);
    const end = limp.bones.get('mixamorig:Head')!.getWorldPosition(new THREE.Vector3());

    expect(end.distanceTo(start)).toBeGreaterThan(0.2);
    body.dispose();
    limp.world.dispose();
  });

  it('falls over rather than apart', () => {
    const { world, root, bones, ragdoll } = rig();
    const body = new RagdollBody(world, 'enemy', root, ragdoll);
    world.adoptRagdoll(body);
    run(world, 3);
    root.updateMatrixWorld(true);

    const at = (name: string): THREE.Vector3 =>
      bones.get(name)!.getWorldPosition(new THREE.Vector3());

    /**
     * Measured as *joint separation*, not as overall spread.
     *
     * The obvious assertion — "no limb drifted far from the hips" — is nearly vacuous: with the
     * joints removed the capsules simply collide into a pile roughly where the character stood, and
     * every distance stays small. What a joint actually guarantees is that two named bones stay a
     * fixed distance apart, and that is exact rather than approximate: the knee holds at the thigh's
     * own length to the millimetre, and collapses to about half of it when nothing is holding it.
     */
    expect(at('mixamorig:LeftUpLeg').distanceTo(at('mixamorig:LeftLeg'))).toBeCloseTo(0.45, 2);
    expect(at('mixamorig:LeftArm').distanceTo(at('mixamorig:LeftForeArm'))).toBeCloseTo(0.28, 2);
    expect(at('mixamorig:Hips').distanceTo(at('mixamorig:Spine'))).toBeCloseTo(0.25, 2);

    body.dispose();
    world.dispose();
  });

  it('lands on the floor rather than through it', () => {
    const { world, root, bones, ragdoll } = rig();
    const body = new RagdollBody(world, 'enemy', root, ragdoll);
    world.adoptRagdoll(body);
    run(world, 4);
    root.updateMatrixWorld(true);

    for (const name of ['mixamorig:Hips', 'mixamorig:Head', 'mixamorig:LeftLeg']) {
      const at = bones.get(name)!.getWorldPosition(new THREE.Vector3());
      // Ground top is y=0. A limb below it has been pushed through the floor by its own joints.
      expect(at.y).toBeGreaterThan(-0.5);
    }

    // And it is lying down rather than still standing: the hips started at y=1.
    expect(bones.get('mixamorig:Hips')!.getWorldPosition(new THREE.Vector3()).y).toBeLessThan(0.8);

    body.dispose();
    world.dispose();
  });

  it('carries the character’s motion into the fall', () => {
    const still = rig({ inheritVelocity: 0 });
    const stillBody = new RagdollBody(
      still.world,
      'enemy',
      still.root,
      still.ragdoll,
      new THREE.Vector3(6, 0, 0),
    );
    still.world.adoptRagdoll(stillBody);
    run(still.world, 1);
    still.root.updateMatrixWorld(true);
    const dropped = still.bones.get('mixamorig:Hips')!.getWorldPosition(new THREE.Vector3()).x;
    stillBody.dispose();
    still.world.dispose();

    const moving = rig({ inheritVelocity: 1 });
    const movingBody = new RagdollBody(
      moving.world,
      'enemy',
      moving.root,
      moving.ragdoll,
      new THREE.Vector3(6, 0, 0),
    );
    moving.world.adoptRagdoll(movingBody);
    run(moving.world, 1);
    moving.root.updateMatrixWorld(true);
    const thrown = moving.bones.get('mixamorig:Hips')!.getWorldPosition(new THREE.Vector3()).x;

    // A corpse that stops dead the instant it dies reads as the animation having been switched off,
    // which is exactly what happened and exactly what should not be visible.
    expect(Math.abs(dropped)).toBeLessThan(1);
    expect(thrown).toBeGreaterThan(2);
    movingBody.dispose();
    moving.world.dispose();
  });

  it('builds nothing when no bone matches', () => {
    const { world, root } = rig();
    const body = new RagdollBody(world, 'enemy', root, settings({ bones: {} }));

    // Reported to the caller as zero limbs rather than as a throw: a half-set-up character is a
    // normal state to be in mid-edit, and the runtime undoes the handover rather than freezing it.
    expect(body.limbCount).toBe(0);
    body.dispose();
    world.dispose();
  });
});

describe('ragdollProblems', () => {
  it('catches a rig with nothing bound', () => {
    expect(ragdollProblems(settings()).join('\n')).toContain('no bones bound');
  });

  it('catches a limb whose parent is missing', () => {
    const bound = guessRagdollBones(MIXAMO);
    const problems = ragdollProblems(settings({ bones: { ...bound, armUpperL: '' } }));

    // Everything hangs from something. A forearm bound with no upper arm is a limb with nothing to
    // hang from, and it falls off the moment the character does.
    expect(problems.join('\n')).toContain('Left forearm');
  });

  it('catches missing hips, which everything hangs from', () => {
    const bound = guessRagdollBones(MIXAMO);
    expect(ragdollProblems(settings({ bones: { ...bound, hips: '' } })).join('\n')).toContain(
      'hips are not bound',
    );
  });

  it('says nothing about a fully bound rig', () => {
    expect(ragdollProblems(settings({ bones: guessRagdollBones(MIXAMO) }))).toEqual([]);
  });
});
