import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { PlayerSchema, type Player } from '@helaengine/schema';
import { PhysicsWorld } from './PhysicsWorld.js';
import { initPhysics, type RapierModule } from './rapier.js';
import type { MoveInput } from './PlayerController.js';

/**
 * How movement feels.
 *
 * Every setting here defaults to the behaviour that existed before it, and that is the claim worth
 * testing hardest: a level tuned against the old controller has to play identically. So each
 * describe block runs the same scenario twice — once with the feature off, once on — and the "off"
 * half is not a formality, it is half the assertion.
 */

let rapier: RapierModule;

beforeAll(async () => {
  rapier = await initPhysics();
}, 30_000);

const player = (input: Record<string, unknown> = {}): Player => PlayerSchema.parse(input);

const STEP = 1 / 60;

/**
 * A world with a floor at y=0, and optionally a block standing on it.
 *
 * Colliders are built with their pivot at the base, matching the asset convention — so a box placed
 * at y=0 with height h occupies 0..h and its walkable top is at h. Getting this backwards is how the
 * first draft of these tests spawned the character inside the platform it was meant to stand on.
 */
function world(options: { blockHeight?: number; blockAtZ?: number } = {}): PhysicsWorld {
  const physics = new PhysicsWorld(rapier, { gravity: 24 });

  const ground = new THREE.Object3D();
  ground.position.set(0, -1, 0);
  ground.updateMatrixWorld(true);
  physics.addObject({
    objectId: 'ground',
    node: ground,
    shape: 'box',
    body: 'static',
    size: [200, 1, 200],
  });

  if (options.blockHeight !== undefined) {
    const node = new THREE.Object3D();
    node.position.set(0, 0, options.blockAtZ ?? 0);
    node.updateMatrixWorld(true);
    physics.addObject({
      objectId: 'platform',
      node,
      shape: 'box',
      body: 'static',
      size: [4, options.blockHeight, 4],
    });
  }

  return physics;
}

const still: MoveInput = { forward: 0, right: 0, jump: false, yaw: 0 };

/** Settles the character onto the ground so a test starts from a known, grounded state. */
function settle(physics: PhysicsWorld, controller: { move(i: MoveInput, s: number): void }): void {
  for (let frame = 0; frame < 60; frame += 1)
    physics.step(STEP, (step) => controller.move(still, step));
}

describe('coyote time', () => {
  /**
   * Walks off the edge of a platform, waits `delay` frames, then presses jump once.
   *
   * The platform is at x=0 and ends at x=2; the character walks +x off the end, so after a few
   * frames of falling they are past the lip and no longer grounded.
   */
  function walkOffAndJump(settings: Player, delay: number): number {
    // Tall enough that thirty frames of falling has not reached the ground: otherwise the "window
    // closes" case passes because the character landed, which proves nothing about the window.
    const physics = world({ blockHeight: 12 });
    const controller = physics.createPlayer(settings, new THREE.Vector3(0, 12.2, 0));
    settle(physics, controller);

    // Walk to the edge and off it.
    let leftGroundAt = -1;
    for (let frame = 0; frame < 200 && leftGroundAt < 0; frame += 1) {
      physics.step(STEP, (step) =>
        controller.move({ forward: -1, right: 0, jump: false, yaw: Math.PI / 2 }, step),
      );
      if (!controller.grounded) leftGroundAt = frame;
    }
    expect(leftGroundAt).toBeGreaterThan(0);

    for (let frame = 0; frame < delay; frame += 1) {
      physics.step(STEP, (step) =>
        controller.move({ forward: -1, right: 0, jump: false, yaw: Math.PI / 2 }, step),
      );
    }

    const before = controller.position.y;
    // One press, then released — a held button would prove nothing about the window.
    physics.step(STEP, (step) =>
      controller.move({ forward: -1, right: 0, jump: true, yaw: Math.PI / 2 }, step),
    );
    const rise = controller.verticalVelocity;

    physics.dispose();
    void before;
    return rise;
  }

  it('does nothing when it is off, which is the default', () => {
    // The control case, and the important half: a scene saved before coyote time existed must play
    // exactly as it did. Off means the press is eaten, as it always was.
    expect(walkOffAndJump(player(), 3)).toBeLessThan(0);
  });

  it('accepts a jump pressed just after the edge', () => {
    // A player pressing jump at the lip of a platform is almost always a frame or two late. Without
    // this they do not conclude they mistimed it — they conclude the controls are unreliable.
    expect(walkOffAndJump(player({ coyoteSeconds: 0.15 }), 3)).toBeGreaterThan(0);
  });

  it('closes the window rather than leaving it open', () => {
    // A window that never closed would be a double jump, which is a different feature and one
    // nobody asked for.
    expect(walkOffAndJump(player({ coyoteSeconds: 0.1 }), 30)).toBeLessThan(0);
  });
});

describe('jump buffering', () => {
  /** Presses jump once while falling, `early` frames before landing, then holds nothing. */
  function pressBeforeLanding(settings: Player, pressAtHeight: number): boolean {
    const physics = world();
    const controller = physics.createPlayer(settings, new THREE.Vector3(0, 4, 0));

    let pressed = false;
    let jumped = false;
    for (let frame = 0; frame < 300; frame += 1) {
      const press = !pressed && controller.position.y <= pressAtHeight;
      if (press) pressed = true;
      physics.step(STEP, (step) =>
        controller.move({ forward: 0, right: 0, jump: press, yaw: 0 }, step),
      );
      // A jump shows up as upward velocity on a character that was falling.
      if (pressed && controller.verticalVelocity > 1) jumped = true;
    }

    physics.dispose();
    return jumped;
  }

  it('forgets an early press when it is off, which is the default', () => {
    expect(pressBeforeLanding(player(), 0.5)).toBe(false);
  });

  it('fires the jump on the frame the player lands', () => {
    // The same mistake as coyote time from the other side: pressed a fraction early, landed a
    // fraction later, and nothing happened.
    expect(pressBeforeLanding(player({ jumpBufferSeconds: 0.2 }), 0.5)).toBe(true);
  });

  it('still bounces while the button is held, exactly as it always did', () => {
    /**
     * The invariant this change nearly broke.
     *
     * Holding jump has always made the character leap again on every landing. Gating the jump on
     * the press *edge* would be a better default and is not this change's to make: it would alter
     * the feel of every scene already built, silently, in a way nobody asked for. So buffering adds
     * a window and changes nothing else.
     */
    const physics = world();
    const controller = physics.createPlayer(
      player({ jumpBufferSeconds: 0.2 }),
      new THREE.Vector3(0, 1, 0),
    );
    settle(physics, controller);

    // Counted as a *rise* in vertical velocity from one step to the next, rather than as "was
    // falling, now rising". Landing clamps the velocity to zero before the jump is decided, so the
    // falling flag is already false on the frame the leap happens — which is how the first draft of
    // this test reported no jumps at all against a controller that was bouncing perfectly well.
    let jumps = 0;
    let previous = 0;
    for (let frame = 0; frame < 240; frame += 1) {
      physics.step(STEP, (step) =>
        controller.move({ forward: 0, right: 0, jump: true, yaw: 0 }, step),
      );
      if (controller.verticalVelocity - previous > 1) jumps += 1;
      previous = controller.verticalVelocity;
    }

    expect(jumps).toBeGreaterThan(2);
    physics.dispose();
  });
});

describe('air control', () => {
  /** Jumps forward, then tries to reverse in mid-air. Reports how far sideways they got. */
  function reverseMidAir(settings: Player): number {
    const physics = world();
    const controller = physics.createPlayer(settings, new THREE.Vector3(0, 1, 0));
    settle(physics, controller);

    // Take off heading -Z.
    physics.step(STEP, (step) =>
      controller.move({ forward: 1, right: 0, jump: true, yaw: 0 }, step),
    );

    // Then push hard the other way, but only while they are actually in the air. Measuring past the
    // landing would count ordinary ground walking as air drift, and both cases would look the same.
    let peakDrift = 0;
    for (let frame = 0; frame < 60; frame += 1) {
      physics.step(STEP, (step) =>
        controller.move({ forward: 0, right: 1, jump: false, yaw: 0 }, step),
      );
      if (controller.grounded) break;
      peakDrift = Math.max(peakDrift, Math.abs(controller.position.x));
    }

    physics.dispose();
    return peakDrift;
  }

  it('gives full control when it is 1, which is the default', () => {
    // The old behaviour: a character who can turn on a sixpence while falling.
    expect(reverseMidAir(player())).toBeGreaterThan(0.5);
  });

  it('commits the player to their takeoff direction when it is 0', () => {
    const committed = reverseMidAir(player({ airControl: 0 }));
    const free = reverseMidAir(player());

    // A dial, not a switch — and the control is what makes "it barely moved" mean anything.
    expect(committed).toBeLessThan(free * 0.3);
  });

  it('is a dial in between', () => {
    const half = reverseMidAir(player({ airControl: 0.5 }));
    expect(half).toBeGreaterThan(reverseMidAir(player({ airControl: 0 })));
    expect(half).toBeLessThan(reverseMidAir(player()));
  });
});

describe('mantling', () => {
  /** Walks into a block of `height` metres pressing jump, and reports whether they end up on top. */
  function climb(settings: Player, height: number): boolean {
    const physics = world({ blockHeight: height, blockAtZ: -4 });
    const controller = physics.createPlayer(settings, new THREE.Vector3(0, 0.5, 0));
    settle(physics, controller);

    /**
     * Whether they stood on top at any point, not whether they are there at the end.
     *
     * Holding forward for four seconds walks them straight across the block and off the far side,
     * so a check at the end reports a successful mantle as a failure. The block spans z=-6..-2.
     */
    let reachedTop = false;
    for (let frame = 0; frame < 240; frame += 1) {
      physics.step(STEP, (step) =>
        controller.move({ forward: 1, right: 0, jump: true, yaw: 0 }, step),
      );
      const { y, z } = controller.position;
      if (y > height - 0.2 && z < -2.2 && z > -6) reachedTop = true;
    }

    physics.dispose();
    return reachedTop;
  }

  it('does nothing when it is off, which is the default', () => {
    // A wall stays a wall for every level built before mantling existed.
    expect(climb(player({ jumpSpeed: 4 }), 1.6)).toBe(false);
  });

  it('pulls the player onto a chest-high ledge', () => {
    // The difference between "the geometry is rough" and "that is a wall I can climb", which is
    // worth a great deal in a level built out of crates.
    expect(climb(player({ jumpSpeed: 4, mantleHeight: 2 }), 1.6)).toBe(true);
  });

  it('refuses a ledge above the limit', () => {
    // Pretending otherwise is how a player ends up on the skybox.
    expect(climb(player({ jumpSpeed: 4, mantleHeight: 1 }), 2.5)).toBe(false);
  });
});
