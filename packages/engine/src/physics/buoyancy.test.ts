import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { PlayerSchema, WaterSchema } from '@helaengine/schema';
import { TerrainField } from '../TerrainField.js';
import {
  buoyantAcceleration,
  dragFactor,
  isSwimming,
  submergedFraction,
  swimSpeedFactor,
  swimVerticalVelocity,
} from './buoyancy.js';
import { PhysicsWorld } from './PhysicsWorld.js';
import { initPhysics, type RapierModule } from './rapier.js';

let rapier: RapierModule;

beforeAll(async () => {
  rapier = await initPhysics();
}, 30_000);

const floating = WaterSchema.parse({ height: 0, buoyancy: true });
/** Dense enough to sink: a stone, not a crate. Half its own weight in lift. */
const sinking = WaterSchema.parse({ height: 0, buoyancy: true, buoyancyStrength: 0.5 });

function nodeAt(y: number): THREE.Object3D {
  const node = new THREE.Group();
  node.position.set(0, y, 0);
  return node;
}

/**
 * A world with a floor to land on, so a body that does not float has somewhere to stop.
 *
 * The floor is flat at y=0 and the water in these tests sits at 5, which is the arrangement a real
 * level has: a surface above the ground, with the terrain deciding where it shows. Water *below*
 * the terrain is the case `waterProblems` warns the author about, and it is not what a physics test
 * should be quietly measuring.
 */
function makeWorld(withTerrain = true): PhysicsWorld {
  const world = new PhysicsWorld(rapier, {});
  if (withTerrain)
    world.addTerrain(new TerrainField({ segments: 8, size: [64, 64], maxHeight: 10 }));
  return world;
}

/** Five metres of water over a floor at zero. */
const pool = WaterSchema.parse({ height: 5, buoyancy: true });

describe('the submerged fraction', () => {
  it('measures from the base upward, the way a scene transform does', () => {
    // A 2m body with its feet at -2 and the surface at 0 is entirely under; half out at -1.
    expect(submergedFraction(-2, 2, 0)).toBe(1);
    expect(submergedFraction(-1, 2, 0)).toBeCloseTo(0.5, 6);
    expect(submergedFraction(0, 2, 0)).toBe(0);
  });

  it('is nothing at all for a body above the surface', () => {
    // The control for every force below: dry is zero, not a small number, so a body on a hill is
    // not quietly being lifted by a pond it is nowhere near.
    expect(submergedFraction(3, 2, 0)).toBe(0);
    expect(buoyantAcceleration(0, 9.81, floating)).toBeCloseTo(-9.81, 6);
    expect(dragFactor(0, floating, 1 / 60)).toBe(1);
    expect(swimSpeedFactor(0, floating)).toBe(1);
  });
});

describe('the balance of lift and weight', () => {
  it('hangs still at a strength of one, fully under', () => {
    // The definition of the setting: 1 is neutral. If this drifts, every author's number means
    // something different from what the panel says it means.
    const neutral = WaterSchema.parse({ buoyancy: true, buoyancyStrength: 1 });
    expect(buoyantAcceleration(1, 9.81, neutral)).toBeCloseTo(0, 6);
  });

  it('sinks below one and rises above it', () => {
    expect(buoyantAcceleration(1, 9.81, sinking)).toBeLessThan(0);
    expect(buoyantAcceleration(1, 9.81, floating)).toBeGreaterThan(0);
  });
});

describe('drag', () => {
  it('cannot push a velocity past zero, however strong it gets', () => {
    /**
     * The reason the factor divides rather than subtracting. `1 - drag·step` goes negative once
     * the product passes 1 and below -1 past 2, which is a swimmer flung the other way harder
     * every step. The schema caps drag at 10, but a long frame is not capped by anything.
     */
    const heavy = WaterSchema.parse({ buoyancy: true, drag: 10 });
    for (const step of [1 / 60, 0.1, 0.5, 2]) {
      const factor = dragFactor(1, heavy, step);
      expect(factor).toBeGreaterThan(0);
      expect(factor).toBeLessThanOrEqual(1);
    }
  });

  it('does nothing when the author turned it off', () => {
    const slippery = WaterSchema.parse({ buoyancy: true, drag: 0 });
    expect(dragFactor(1, slippery, 1 / 60)).toBe(1);
    expect(swimSpeedFactor(1, slippery)).toBe(1);
  });
});

describe('swimming', () => {
  it('starts at the chest, not at the ankles', () => {
    // Wading through a ford is walking. A threshold at the feet would have the player swimming in
    // a puddle, which is the version of this feature everyone has met and nobody liked.
    expect(isSwimming(submergedFraction(-0.2, 1.8, 0))).toBe(false);
    expect(isSwimming(submergedFraction(-1.5, 1.8, 0))).toBe(true);
  });

  it('settles at the surface rather than at either extreme', () => {
    /**
     * The behaviour that matters, and it is emergent: nothing here says "stop at the waterline".
     * Lift grows with depth, so a swimmer released underwater rises until lift equals weight and
     * stays there — with the default strength, a little under the top of their head.
     */
    let feet = -4;
    let velocity = 0;
    const height = 1.8;
    for (let step = 0; step < 600; step += 1) {
      const submersion = submergedFraction(feet, height, floating.height);
      velocity = swimVerticalVelocity(velocity, submersion, 9.81, floating, 1 / 60, false);
      feet += velocity / 60;
    }

    const settled = submergedFraction(feet, height, floating.height);
    // 1 / 1.15: the depth at which strength × submersion reaches 1.
    expect(settled).toBeCloseTo(1 / floating.buoyancyStrength, 2);
    expect(Math.abs(velocity)).toBeLessThan(0.05);
  });

  it('sinks in water that does not float things — the control', () => {
    // Same loop, same start, one setting different. Without this the test above passes on any
    // implementation that pushes upward at all, including one that ignores the strength entirely.
    let feet = -4;
    let velocity = 0;
    for (let step = 0; step < 600; step += 1) {
      const submersion = submergedFraction(feet, 1.8, sinking.height);
      velocity = swimVerticalVelocity(velocity, submersion, 9.81, sinking, 1 / 60, false);
      feet += velocity / 60;
    }

    expect(feet).toBeLessThan(-4);
    expect(velocity).toBeLessThan(0);
  });

  it('rises when the player strokes upward, and only then', () => {
    const held = swimVerticalVelocity(0, 1, 9.81, floating, 1 / 60, true);
    const idle = swimVerticalVelocity(0, 1, 9.81, floating, 1 / 60, false);
    expect(held).toBeGreaterThan(idle);
    expect(held).toBeGreaterThan(0);
  });
});

describe('rigid bodies in water', () => {
  /** Drops a 1m crate on the floor of a five-metre pool and runs ten seconds. */
  function settle(water: ReturnType<typeof WaterSchema.parse> | null): number {
    const world = makeWorld();
    if (water) world.setWater(water);

    const node = nodeAt(0.5);
    world.addObject({
      objectId: 'obj_0001',
      node,
      shape: 'box',
      body: 'dynamic',
      size: [1, 1, 1],
    });

    for (let frame = 0; frame < 600; frame += 1) world.step(1 / 60);
    const settled = node.position.y;
    world.dispose();
    return settled;
  }

  it('lifts a crate off the bottom and holds it at the surface', () => {
    // Five metres up, and stopped there rather than launched out. The equilibrium is the depth at
    // which lift matches weight — for the default strength, a base a little under the waterline.
    const settled = settle(pool);
    expect(settled).toBeGreaterThan(3.9);
    expect(settled).toBeLessThan(4.6);
  });

  it('leaves the same crate on the bottom with no water — the control', () => {
    /**
     * The control the whole feature turns on. A crate that ends up somewhere plausible for an
     * unrelated reason — never being stepped, the terrain being where it is — would pass the test
     * above with no buoyancy running at all. Here the single difference is `setWater`.
     */
    expect(settle(null)).toBeLessThan(0.1);
  });

  it('ignores water the author only wanted to look at', () => {
    // `buoyancy: false` is the default, and it is the whole reason adding a pond to an existing
    // level cannot change how that level plays.
    const scenery = WaterSchema.parse({ height: 5 });
    const world = makeWorld();
    world.setWater(scenery);
    expect(world.water).toBeNull();
    world.dispose();

    expect(settle(scenery)).toBeLessThan(0.1);
  });

  it('slows what moves through it', () => {
    /**
     * No terrain in either world: a crate that lands is slowed by friction, and a drag test that
     * measured friction would pass with the water doing nothing.
     */
    function shove(water: ReturnType<typeof WaterSchema.parse> | null): number {
      const world = makeWorld(false);
      if (water) world.setWater(water);

      world.addObject({
        objectId: 'obj_0001',
        node: nodeAt(3),
        shape: 'box',
        body: 'dynamic',
        size: [1, 1, 1],
      });
      const body = world.bodyFor('obj_0001')?.body;
      body?.setLinvel({ x: 8, y: 0, z: 0 }, true);

      for (let frame = 0; frame < 30; frame += 1) world.step(1 / 60);
      const speed = body?.linvel().x ?? 0;
      world.dispose();
      return speed;
    }

    expect(shove(pool)).toBeLessThan(shove(null) * 0.5);
  });
});

describe('a character in water', () => {
  const STEP = 1 / 60;
  const still = { forward: 0, right: 0, jump: false, yaw: 0 };
  const settings = PlayerSchema.parse({});

  /** A floor at y=0, and water deep enough to swim in over it. */
  function pooled(water: ReturnType<typeof WaterSchema.parse> | null) {
    const world = new PhysicsWorld(rapier, {});
    const ground = new THREE.Object3D();
    ground.position.set(0, -1, 0);
    ground.updateMatrixWorld(true);
    world.addObject({
      objectId: 'ground',
      node: ground,
      shape: 'box',
      body: 'static',
      size: [200, 1, 200],
    });
    if (water) world.setWater(water);
    return world;
  }

  it('holds a swimmer up instead of dropping them to the bottom', () => {
    const world = pooled(pool);
    const controller = world.createPlayer(settings, new THREE.Vector3(0, 4, 0));

    for (let frame = 0; frame < 600; frame += 1)
      world.step(STEP, (step) => controller.move(still, step));

    // Near the surface at 5, not on the floor at 0. The equilibrium is the swimmer's own: lift
    // matches weight a little under the top of their head.
    expect(controller.position.y).toBeGreaterThan(2.5);
    expect(controller.swimming).toBe(true);
    world.dispose();
  });

  it('drops the same character to the floor with no water — the control', () => {
    /**
     * Without this, the test above passes on a controller that simply stopped falling — a broken
     * gravity integration, a character stuck on a collider — and says nothing about buoyancy.
     */
    const world = pooled(null);
    const controller = world.createPlayer(settings, new THREE.Vector3(0, 4, 0));

    for (let frame = 0; frame < 600; frame += 1)
      world.step(STEP, (step) => controller.move(still, step));

    expect(controller.position.y).toBeLessThan(0.1);
    expect(controller.swimming).toBe(false);
    world.dispose();
  });

  it('wades without swimming when the water is shallow', () => {
    // Knee-deep is walking. A character who starts swimming in a ford is the failure everyone has
    // met, and the threshold is the only thing standing between this feature and that.
    const shallow = WaterSchema.parse({ height: 0.4, buoyancy: true });
    const world = pooled(shallow);
    const controller = world.createPlayer(settings, new THREE.Vector3(0, 1, 0));

    for (let frame = 0; frame < 300; frame += 1)
      world.step(STEP, (step) => controller.move(still, step));

    expect(controller.swimming).toBe(false);
    expect(controller.grounded).toBe(true);
    expect(controller.submersion).toBeGreaterThan(0);
    world.dispose();
  });

  it('swims upward when the player asks it to', () => {
    const world = pooled(pool);
    const controller = world.createPlayer(settings, new THREE.Vector3(0, 1, 0));

    for (let frame = 0; frame < 120; frame += 1)
      world.step(STEP, (step) => controller.move(still, step));
    const floating = controller.position.y;

    for (let frame = 0; frame < 120; frame += 1)
      world.step(STEP, (step) => controller.move({ ...still, jump: true }, step));

    expect(controller.position.y).toBeGreaterThan(floating + 0.3);
    world.dispose();
  });

  it('moves more slowly through water than over dry ground', () => {
    function travelled(water: ReturnType<typeof WaterSchema.parse> | null): number {
      const world = pooled(water);
      const controller = world.createPlayer(settings, new THREE.Vector3(0, 1, 0));
      const from = controller.position.clone();

      for (let frame = 0; frame < 120; frame += 1)
        world.step(STEP, (step) => controller.move({ ...still, forward: 1 }, step));

      // Ground distance, not the raw axis: `yaw: 0` faces -Z, and a test that measured x would
      // read zero for both and pass on nothing at all.
      const distance = Math.hypot(controller.position.x - from.x, controller.position.z - from.z);
      world.dispose();
      return distance;
    }

    // Waist-deep: still walking, and still slower than dry land.
    expect(travelled(WaterSchema.parse({ height: 1, buoyancy: true }))).toBeLessThan(
      travelled(null) * 0.9,
    );
  });
});
