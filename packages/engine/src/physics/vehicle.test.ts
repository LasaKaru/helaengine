import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  VehicleSchema,
  drivenWheels,
  steerLimitAt,
  vehicleProblems,
  wheelPositions,
  type Vehicle,
} from '@helaengine/schema';
import { PhysicsWorld } from './PhysicsWorld.js';
import { initPhysics, type RapierModule } from './rapier.js';
import type { DriveInput } from './VehicleController.js';

/**
 * Driving, against a real solver.
 *
 * Every claim is made by stepping the world and reading where the car ended up. A vehicle that
 * parses and exports perfectly while sitting motionless is exactly the failure this codebase keeps
 * meeting, and no assertion about the document can tell the difference.
 */

let rapier: RapierModule;

beforeAll(async () => {
  rapier = await initPhysics();
}, 30_000);

const settings = (input: Record<string, unknown> = {}): Vehicle => VehicleSchema.parse(input);

const STEP = 1 / 60;
const IDLE: DriveInput = { throttle: 0, steer: 0, brake: false };

/** A ground plane and a chassis resting on it. */
function rig(vehicle: Vehicle = settings()): {
  world: PhysicsWorld;
  chassis: THREE.Object3D;
  controller: NonNullable<ReturnType<PhysicsWorld['createVehicle']>>;
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
    size: [400, 1, 400],
  });

  const chassis = new THREE.Object3D();
  chassis.position.set(0, 1, 0);
  chassis.updateMatrixWorld(true);
  world.addObject({
    objectId: 'car',
    node: chassis,
    shape: 'box',
    body: 'dynamic',
    size: [1.8, 0.8, 4],
    mass: 900,
  });

  const controller = world.createVehicle('car', vehicle);
  expect(controller).not.toBeNull();
  return { world, chassis, controller: controller! };
}

/** Steps for `seconds` with one input, driving the vehicle inside the fixed step. */
function run(
  world: PhysicsWorld,
  controller: { drive(input: DriveInput, step: number): void },
  seconds: number,
  input: DriveInput,
): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += STEP) {
    world.step(STEP, (step) => controller.drive(input, step));
  }
}

describe('driving', () => {
  it('pulls away under throttle, and stays put without it', () => {
    // The control case, and it is the whole test: a car that never moves would satisfy "it did not
    // drive backwards" and every other one-sided assertion here.
    const idle = rig();
    run(idle.world, idle.controller, 2, IDLE);
    const drift = Math.abs(idle.chassis.position.z);
    idle.world.dispose();

    const driven = rig();
    run(driven.world, driven.controller, 2, { throttle: 1, steer: 0, brake: false });

    expect(drift).toBeLessThan(0.5);
    // -Z is forward, matching the character controller and an unrotated camera.
    expect(driven.chassis.position.z).toBeLessThan(-2);
    driven.world.dispose();
  });

  it('reverses under negative throttle', () => {
    const { world, chassis, controller } = rig();
    run(world, controller, 2, { throttle: -1, steer: 0, brake: false });

    expect(chassis.position.z).toBeGreaterThan(1);
    world.dispose();
  });

  it('slows under braking rather than carrying on', () => {
    const rolling = rig();
    run(rolling.world, rolling.controller, 2, { throttle: 1, steer: 0, brake: false });
    run(rolling.world, rolling.controller, 1, IDLE);
    const coasted = Math.abs(rolling.controller.speed);
    rolling.world.dispose();

    const stopping = rig();
    run(stopping.world, stopping.controller, 2, { throttle: 1, steer: 0, brake: false });
    run(stopping.world, stopping.controller, 1, { throttle: 0, steer: 0, brake: true });

    // Against a coasting car rather than against zero: an engine that simply stopped pushing would
    // also be slower after a second, and that is not braking.
    expect(stopping.controller.speed).toBeLessThan(coasted * 0.6);
    stopping.world.dispose();
  });

  it('turns when steered, and drives straight when not', () => {
    const straight = rig();
    run(straight.world, straight.controller, 3, { throttle: 1, steer: 0, brake: false });
    const straightDrift = Math.abs(straight.chassis.position.x);
    straight.world.dispose();

    const turning = rig();
    run(turning.world, turning.controller, 3, { throttle: 1, steer: 1, brake: false });

    expect(straightDrift).toBeLessThan(0.5);
    expect(Math.abs(turning.chassis.position.x)).toBeGreaterThan(1);
    turning.world.dispose();
  });

  it('holds a top speed rather than accelerating forever', () => {
    const { world, controller } = rig(settings({ maxSpeed: 8 }));
    run(world, controller, 12, { throttle: 1, steer: 0, brake: false });

    // Above the limit the engine stops pushing rather than a drag force being invented to fight it,
    // so the car settles just under rather than oscillating around it.
    expect(Math.abs(controller.speed)).toBeLessThan(9.5);
    expect(Math.abs(controller.speed)).toBeGreaterThan(4);
    world.dispose();
  });

  it('rests on its suspension instead of sinking or floating away', () => {
    const { world, chassis, controller } = rig();
    run(world, controller, 3, IDLE);

    // The chassis started at y=1 on ground whose top is y=0. A car that has fallen through is below
    // zero; one whose springs are pumping energy in is climbing.
    expect(chassis.position.y).toBeGreaterThan(0);
    expect(chassis.position.y).toBeLessThan(2);
    expect(controller.grounded).toBe(true);
    world.dispose();
  });
});

describe('steering', () => {
  it('ramps toward full lock rather than snapping to it', () => {
    const { world, controller } = rig(settings({ steerSeconds: 0.5 }));

    world.step(STEP, (step) => controller.drive({ throttle: 0, steer: 1, brake: false }, step));
    const afterOneStep = controller.steerAngle;

    run(world, controller, 1, { throttle: 0, steer: 1, brake: false });
    const settled = controller.steerAngle;

    // Snapping the angle is the single thing that makes a ray-cast car feel like a toy: the tyre
    // force changes direction in one step and the chassis jerks sideways.
    expect(afterOneStep).toBeLessThan(settled * 0.5);
    expect(settled).toBeGreaterThan(0.3);
    world.dispose();
  });

  it('snaps when the ramp is switched off', () => {
    const { world, controller } = rig(settings({ steerSeconds: 0 }));
    world.step(STEP, (step) => controller.drive({ throttle: 0, steer: 1, brake: false }, step));

    expect(controller.steerAngle).toBeCloseTo(settings().maxSteer, 2);
    world.dispose();
  });

  it('gives less lock the faster it is going', () => {
    const vehicle = settings({ maxSteer: 0.5, maxSpeed: 20, steerSpeedFalloff: 0.6 });

    // Without the taper a car spins on any input above walking pace, which reads as the handling
    // being broken rather than as a setting somebody chose.
    expect(steerLimitAt(vehicle, 0)).toBeCloseTo(0.5, 5);
    expect(steerLimitAt(vehicle, 20)).toBeCloseTo(0.2, 5);
    expect(steerLimitAt(vehicle, 10)).toBeCloseTo(0.35, 5);
  });

  it('never gives more lock than full, however fast it is going backwards', () => {
    const vehicle = settings({ maxSteer: 0.5, maxSpeed: 20 });
    expect(steerLimitAt(vehicle, -1000)).toBeLessThanOrEqual(0.5);
    expect(steerLimitAt(vehicle, -1000)).toBeGreaterThanOrEqual(0);
  });
});

describe('layout', () => {
  it('puts the wheels where the numbers say, in a fixed order', () => {
    const layout = settings({
      wheels: { axleOffset: 1.5, trackHalfWidth: 0.9, hubHeight: -0.3 },
    }).wheels;
    const positions = wheelPositions(layout);

    // FL, FR, RL, RR — derived rather than authored, so the order the runtime uses and the order
    // `drivenWheels` talks about cannot drift apart.
    expect(positions).toEqual([
      [-0.9, -0.3, -1.5],
      [0.9, -0.3, -1.5],
      [-0.9, -0.3, 1.5],
      [0.9, -0.3, 1.5],
    ]);
  });

  it('drives the wheels the layout names', () => {
    expect(drivenWheels('front')).toEqual([0, 1]);
    expect(drivenWheels('rear')).toEqual([2, 3]);
    expect(drivenWheels('all')).toEqual([0, 1, 2, 3]);
  });

  it('pushes only the wheels the layout names', () => {
    /**
     * Read from the solver rather than from the car's movement.
     *
     * A car with every wheel driven pulls away exactly like a correctly configured rear-wheel-drive
     * one on flat ground, so "it moved" is true of both and proves nothing about which wheels are
     * pushing. This is the assertion that actually distinguishes them.
     */
    for (const [drive, expected] of [
      ['front', [0, 1]],
      ['rear', [2, 3]],
      ['all', [0, 1, 2, 3]],
    ] as const) {
      const { world, controller } = rig(settings({ drive }));
      world.step(STEP, (step) => controller.drive({ throttle: 1, steer: 0, brake: false }, step));

      const pushing = [0, 1, 2, 3].filter((index) => controller.engineForceAt(index) !== 0);
      expect(pushing).toEqual([...expected]);
      world.dispose();
    }
  });

  it('brakes every wheel, driven or not', () => {
    // A handbrake that only worked on the driven axle would make a front-wheel-drive car stop
    // differently from a rear-wheel-drive one for no reason the author chose.
    const { world, controller } = rig(settings({ drive: 'rear' }));
    world.step(STEP, (step) => controller.drive({ throttle: 0, steer: 0, brake: true }, step));

    for (let index = 0; index < 4; index += 1) expect(controller.brakeAt(index)).toBeGreaterThan(0);
    world.dispose();
  });

  it('front-wheel drive pulls away as well as rear', () => {
    // Both layouts have to actually move the car. A `drivenWheels` that returned the wrong pair
    // would leave one of them pushing nothing, and nothing else would say so.
    for (const drive of ['front', 'rear', 'all'] as const) {
      const { world, chassis, controller } = rig(settings({ drive }));
      run(world, controller, 2, { throttle: 1, steer: 0, brake: false });
      expect(chassis.position.z).toBeLessThan(-1);
      world.dispose();
    }
  });
});

describe('refusing to build one', () => {
  it('will not hang a vehicle on a static chassis', () => {
    const world = new PhysicsWorld(rapier, {});
    const node = new THREE.Object3D();
    node.updateMatrixWorld(true);
    world.addObject({ objectId: 'wall', node, shape: 'box', body: 'static', size: [2, 2, 2] });

    // A ray-cast vehicle pushes its chassis. A static one is a car-shaped wall, and everything else
    // about the document says it should drive.
    expect(world.createVehicle('wall', settings())).toBeNull();
    world.dispose();
  });

  it('will not hang one on an object with no body at all', () => {
    const world = new PhysicsWorld(rapier, {});
    expect(world.createVehicle('ghost', settings())).toBeNull();
    world.dispose();
  });
});

describe('vehicleProblems', () => {
  const assets = new Set(['wheel_01']);

  it('catches a chassis that cannot move', () => {
    expect(vehicleProblems(settings(), 'static', assets).join('\n')).toContain('Dynamic');
  });

  it('catches a wheel model this project does not have', () => {
    expect(
      vehicleProblems(settings({ wheelAssetId: 'ghost' }), 'dynamic', assets).join('\n'),
    ).toContain('ghost');
  });

  it('catches suspension that will make the car pogo', () => {
    // Springs that extend faster than they compress pump energy into the chassis: the car bounces
    // higher after every bump until it takes off.
    const problems = vehicleProblems(
      settings({ wheelAssetId: 'wheel_01', suspension: { compression: 4, relaxation: 1 } }),
      'dynamic',
      assets,
    );
    expect(problems.join('\n')).toContain('pogo');
  });

  it('catches an engine with no power', () => {
    expect(
      vehicleProblems(
        settings({ wheelAssetId: 'wheel_01', enginePower: 0 }),
        'dynamic',
        assets,
      ).join('\n'),
    ).toContain('no power');
  });

  it('says nothing about a car that is set up', () => {
    expect(vehicleProblems(settings({ wheelAssetId: 'wheel_01' }), 'dynamic', assets)).toEqual([]);
  });
});
