import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { JointSchema, jointProblems, type Joint } from '@helaengine/schema';
import { PhysicsWorld } from './PhysicsWorld.js';
import { jointDataFor } from './joints.js';
import { initPhysics, type RapierModule } from './rapier.js';

/**
 * Joints, against a real solver.
 *
 * Every claim here is made by stepping the world and looking at where things ended up. A joint that
 * parses, exports and round-trips perfectly while constraining nothing is the exact failure this
 * codebase keeps being bitten by, and a document-shaped assertion cannot tell the difference.
 */

let rapier: RapierModule;

beforeAll(async () => {
  rapier = await initPhysics();
}, 30_000);

const joint = (input: Record<string, unknown>): Joint => JointSchema.parse(input);

/** A world with two boxes: `anchor` fixed in the air, `swing` dynamic and one metre to its right. */
function rig(options: { gravity?: number } = {}): {
  world: PhysicsWorld;
  anchor: THREE.Object3D;
  swing: THREE.Object3D;
} {
  const world = new PhysicsWorld(rapier, { gravity: options.gravity ?? 9.81 });

  const anchor = new THREE.Object3D();
  anchor.position.set(0, 5, 0);
  anchor.updateMatrixWorld(true);
  world.addObject({
    objectId: 'anchor',
    node: anchor,
    shape: 'box',
    body: 'static',
    size: [0.5, 0.5, 0.5],
  });

  const swing = new THREE.Object3D();
  swing.position.set(1, 5, 0);
  swing.updateMatrixWorld(true);
  world.addObject({
    objectId: 'swing',
    node: swing,
    shape: 'box',
    body: 'dynamic',
    size: [0.5, 0.5, 0.5],
    mass: 1,
  });

  return { world, anchor, swing };
}

/** Steps for `seconds` of simulated time at the fixed rate, in frame-sized bites. */
function run(world: PhysicsWorld, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1 / 60) world.step(1 / 60);
}

describe('holding two bodies together', () => {
  it('a fixed joint stops a body falling', () => {
    const { world, swing } = rig();

    // The control case. Without it "the box is still up there" is a claim about gravity, not about
    // the joint, and would pass just as well against a world that never stepped.
    run(world, 1);
    const unheld = swing.position.y;
    world.dispose();

    const held = rig();
    held.world.addJoint(joint({ id: 'weld', type: 'fixed', objectA: 'anchor', objectB: 'swing' }));
    run(held.world, 1);

    expect(unheld).toBeLessThan(3);
    expect(held.swing.position.y).toBeGreaterThan(4.5);
    held.world.dispose();
  });

  it('a rope does nothing until it is taut', () => {
    const { world, swing } = rig();
    // Two metres of rope on a body one metre away: it should fall until the rope catches, and then
    // hang. A rope that acted like a rod would never have moved at all.
    world.addJoint(
      joint({ id: 'line', type: 'rope', objectA: 'anchor', objectB: 'swing', length: 2 }),
    );
    run(world, 3);

    const distance = swing.position.distanceTo(new THREE.Vector3(0, 5, 0));
    expect(swing.position.y).toBeLessThan(4.5);
    expect(distance).toBeLessThan(2.4);
    world.dispose();
  });

  it('a ball socket keeps the distance a rope only caps', () => {
    const { world, swing } = rig();
    world.addJoint(joint({ id: 'ball', type: 'ball', objectA: 'anchor', objectB: 'swing' }));
    run(world, 2);

    // Anchors default to each body's own origin, so a ball socket pulls the two origins together.
    expect(swing.position.distanceTo(new THREE.Vector3(0, 5, 0))).toBeLessThan(0.2);
    world.dispose();
  });
});

describe('joints that only allow one kind of movement', () => {
  it('a hinge limit stops the swing where it was told to', () => {
    const free = rig();
    free.world.addJoint(
      joint({
        id: 'h',
        type: 'hinge',
        objectA: 'anchor',
        objectB: 'swing',
        anchorA: [0, 0, 0],
        anchorB: [-1, 0, 0],
        axis: [0, 0, 1],
      }),
    );
    run(free.world, 2);
    const swungFreely = free.swing.position.y;
    free.world.dispose();

    const limited = rig();
    limited.world.addJoint(
      joint({
        id: 'h',
        type: 'hinge',
        objectA: 'anchor',
        objectB: 'swing',
        anchorA: [0, 0, 0],
        anchorB: [-1, 0, 0],
        axis: [0, 0, 1],
        // A tenth of a radian of travel: a door on a very short chain.
        limit: { min: -0.1, max: 0.1 },
      }),
    );
    run(limited.world, 2);

    // The control is the same joint without the limit. "It did not fall far" proves nothing on its
    // own — a hinge that failed to build at all would also leave the box where it started.
    expect(swungFreely).toBeLessThan(4.6);
    expect(limited.swing.position.y).toBeGreaterThan(4.8);
    limited.world.dispose();
  });

  it('a slider allows its axis and refuses the others', () => {
    const { world, swing } = rig();
    world.addJoint(
      joint({
        id: 's',
        type: 'slider',
        objectA: 'anchor',
        objectB: 'swing',
        axis: [0, 1, 0],
      }),
    );
    run(world, 1);

    // Free to fall along Y, pinned in X and Z — which is the whole of what a piston is.
    expect(swing.position.y).toBeLessThan(4);
    expect(Math.abs(swing.position.x)).toBeLessThan(0.1);
    expect(Math.abs(swing.position.z)).toBeLessThan(0.1);
    world.dispose();
  });

  it('a slider limit is a floor the piston lands on', () => {
    const { world, swing } = rig();
    world.addJoint(
      joint({
        id: 's',
        type: 'slider',
        objectA: 'anchor',
        objectB: 'swing',
        axis: [0, 1, 0],
        limit: { min: -1, max: 1 },
      }),
    );
    run(world, 3);

    expect(swing.position.y).toBeGreaterThan(3.8);
    world.dispose();
  });

  it('a motor drives a hinge against gravity', () => {
    const idle = rig();
    idle.world.addJoint(
      joint({
        id: 'h',
        type: 'hinge',
        objectA: 'anchor',
        objectB: 'swing',
        anchorA: [0, 0, 0],
        anchorB: [-1, 0, 0],
        axis: [0, 0, 1],
      }),
    );
    run(idle.world, 2);
    const unpowered = idle.swing.position.y;
    idle.world.dispose();

    const driven = rig();
    driven.world.addJoint(
      joint({
        id: 'h',
        type: 'hinge',
        objectA: 'anchor',
        objectB: 'swing',
        anchorA: [0, 0, 0],
        anchorB: [-1, 0, 0],
        axis: [0, 0, 1],
        motor: { mode: 'position', target: 0, stiffness: 5000, damping: 500 },
      }),
    );
    run(driven.world, 2);

    // A powered door holds its angle; an unpowered one hangs. Without the control this passes on a
    // world where the box simply never moved.
    expect(unpowered).toBeLessThan(4.6);
    expect(driven.swing.position.y).toBeGreaterThan(4.8);
    driven.world.dispose();
  });

  it('retargets a running motor without rebuilding the joint', () => {
    const { world, swing } = rig();
    world.addJoint(
      joint({
        id: 'h',
        type: 'slider',
        objectA: 'anchor',
        objectB: 'swing',
        axis: [0, 1, 0],
        motor: { mode: 'position', target: 0, stiffness: 5000, damping: 500 },
      }),
    );
    run(world, 1);
    const closed = swing.position.y;

    expect(world.driveJoint('h', 2, 5000, 500)).toBe(true);
    run(world, 2);

    // This is what a graph node drives a powered door with. Rebuilding the joint each time the
    // target changed would drop the accumulated impulse and make the door snap rather than swing.
    expect(swing.position.y).toBeGreaterThan(closed + 1);
    world.dispose();
  });
});

describe('refusing to build one', () => {
  it('reports a joint whose end has no body rather than throwing', () => {
    const { world } = rig();
    const added = world.addJoint(
      joint({ id: 'x', type: 'fixed', objectA: 'anchor', objectB: 'ghost' }),
    );

    // A level in mid-edit is not a corrupt document. The caller reports the skip so the user is
    // told, rather than the whole scene failing to load.
    expect(added).toBe(false);
    expect(world.jointCount).toBe(0);
    world.dispose();
  });

  it('substitutes Y for a zero axis instead of producing NaN', () => {
    const { world, swing } = rig();
    world.addJoint(
      joint({
        id: 'h',
        type: 'hinge',
        objectA: 'anchor',
        objectB: 'swing',
        axis: [0, 0, 0],
      }),
    );
    run(world, 1);

    // Rapier normalises the axis, and a zero one gives NaN — which propagates into the body's
    // translation and throws it out of the level entirely. Boring beats explosive.
    expect(Number.isFinite(swing.position.x)).toBe(true);
    expect(Number.isFinite(swing.position.y)).toBe(true);
    world.dispose();
  });

  it('refuses to join a body to itself', () => {
    const { world } = rig();
    expect(
      world.addJoint(joint({ id: 'self', type: 'fixed', objectA: 'swing', objectB: 'swing' })),
    ).toBe(false);
    world.dispose();
  });

  it('drops the joints attached to a removed object', () => {
    const { world } = rig();
    world.addJoint(joint({ id: 'weld', type: 'fixed', objectA: 'anchor', objectB: 'swing' }));
    expect(world.jointCount).toBe(1);

    world.removeObject('swing');

    // Rapier frees a removed body's joints for us. Leaving the handle in the map would mean the
    // next `removeJoint` for it handed a dangling handle back to the solver.
    expect(world.jointCount).toBe(0);
    world.removeJoint('weld');
    world.dispose();
  });

  it('replaces a joint rebuilt under the same id', () => {
    const { world } = rig();
    world.addJoint(joint({ id: 'weld', type: 'fixed', objectA: 'anchor', objectB: 'swing' }));
    world.addJoint(joint({ id: 'weld', type: 'ball', objectA: 'anchor', objectB: 'swing' }));

    // Editing a joint's type in the inspector rebuilds it. Two live joints under one id would fight
    // each other, and only one of them would ever be removable.
    expect(world.jointCount).toBe(1);
    world.dispose();
  });
});

describe('jointDataFor', () => {
  it('has an arm for every type in the vocabulary', () => {
    // The exhaustiveness guard is a compile-time claim; this is the runtime half of it. A new joint
    // type with no arm throws here rather than silently constraining nothing.
    for (const type of ['fixed', 'hinge', 'ball', 'slider', 'spring', 'rope'] as const) {
      expect(() =>
        jointDataFor(rapier, joint({ id: 'j', type, objectA: 'a', objectB: 'b' })),
      ).not.toThrow();
    }
  });
});

describe('jointProblems', () => {
  const ids = new Set(['a', 'b']);

  it('names an end that is not in the level', () => {
    const problems = jointProblems(
      [joint({ id: 'j', type: 'fixed', objectA: 'a', objectB: 'gone' })],
      ids,
    );
    expect(problems[0]?.reason).toContain('gone');
  });

  it('catches a joint between an object and itself', () => {
    // Rapier creates it happily and then chews a solver island satisfying a body against itself.
    // Nothing visible happens; the frame rate just falls.
    const problems = jointProblems(
      [joint({ id: 'j', type: 'fixed', objectA: 'a', objectB: 'a' })],
      ids,
    );
    expect(problems[0]?.reason).toContain('same object');
  });

  it('says nothing about a joint that is fine', () => {
    expect(
      jointProblems([joint({ id: 'j', type: 'fixed', objectA: 'a', objectB: 'b' })], ids),
    ).toEqual([]);
  });
});
