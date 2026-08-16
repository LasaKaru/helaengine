import * as THREE from 'three';
import {
  drivenWheels,
  steerLimitAt,
  wheelPositions,
  STEERING_WHEELS,
  type Vehicle,
} from '@helaengine/schema';
import type { PhysicsWorld, RapierRigidBody } from './PhysicsWorld.js';
import type { RapierModule } from './rapier.js';

type RapierVehicle = ReturnType<InstanceType<RapierModule['World']>['createVehicleController']>;

/** One frame of driving intent. Unnormalised; the controller clamps. */
export interface DriveInput {
  /** -1 full reverse … 1 full throttle. */
  throttle: number;
  /** -1 full left … 1 full right. */
  steer: number;
  brake: boolean;
}

const DOWN = { x: 0, y: -1, z: 0 };
/**
 * The wheel's spin axis, in chassis space.
 *
 * +X rather than -X, and it is not cosmetic. Rapier derives the vehicle's *forward* direction from
 * this axis crossed with the suspension direction, so getting the sign wrong drives the car
 * backwards under positive throttle — and, worse, puts the wheels this code calls "front" at the
 * back, so the thing steers like a forklift. Both were true of the first draft; the tests below
 * caught the first and the second would have shipped.
 */
const AXLE = { x: 1, y: 0, z: 0 };

const wheelPosition = new THREE.Vector3();
const wheelQuaternion = new THREE.Quaternion();
const chassisQuaternion = new THREE.Quaternion();
const spinAxis = new THREE.Vector3(1, 0, 0);
const steerAxis = new THREE.Vector3(0, 1, 0);

/**
 * A driveable vehicle, built on Rapier's ray-cast vehicle controller.
 *
 * The whole thing is one rigid body — the chassis. Each wheel is a downward ray from it, the
 * suspension is a spring along that ray, and grip is a force at the contact point. There are no
 * wheel bodies and no joints, which is precisely why it cannot come apart: a jointed car has an
 * unbounded number of ways to fail (wheels catching on seams, suspension resonating, an axle
 * popping on a hard landing), and every one of them is a solver problem the author has no
 * vocabulary to describe, let alone fix.
 *
 * Wheel *models* are placed at each ray's contact point and spun to match. They collide with
 * nothing — a wheel with a collider would fight the ray that already decided where the wheel is.
 */
export class VehicleController {
  readonly #world: PhysicsWorld;
  readonly #controller: RapierVehicle;
  readonly #body: RapierRigidBody;
  readonly #settings: Vehicle;
  readonly #objectId: string;
  /** Wheel models, in the same FL, FR, RL, RR order the solver uses. */
  readonly #wheelNodes: THREE.Object3D[] = [];
  /** Accumulated spin per wheel, in radians, so a rolling wheel keeps rolling across frames. */
  readonly #spin: number[] = [0, 0, 0, 0];
  #steer = 0;
  #disposed = false;
  #steps = 0;

  constructor(world: PhysicsWorld, objectId: string, body: RapierRigidBody, settings: Vehicle) {
    this.#world = world;
    this.#objectId = objectId;
    this.#body = body;
    this.#settings = settings;
    this.#controller = world.world.createVehicleController(body);

    const { suspension, wheels } = settings;
    for (const [x, y, z] of wheelPositions(wheels)) {
      this.#controller.addWheel({ x, y, z }, DOWN, AXLE, suspension.restLength, wheels.radius);
    }

    for (let index = 0; index < 4; index += 1) {
      this.#controller.setWheelSuspensionStiffness(index, suspension.stiffness);
      this.#controller.setWheelSuspensionCompression(index, suspension.compression);
      this.#controller.setWheelSuspensionRelaxation(index, suspension.relaxation);
      this.#controller.setWheelMaxSuspensionTravel(index, suspension.maxTravel);
      this.#controller.setWheelMaxSuspensionForce(index, suspension.maxForce);
      this.#controller.setWheelFrictionSlip(index, settings.friction);
      this.#controller.setWheelSideFrictionStiffness(index, settings.sideFriction);
    }
  }

  get objectId(): string {
    return this.#objectId;
  }

  /** Forward speed in metres per second. Negative in reverse. */
  get speed(): number {
    return this.#controller.currentVehicleSpeed();
  }

  /** Current steering angle in radians, after ramping. */
  get steerAngle(): number {
    return this.#steer;
  }

  /** Whether any wheel is touching something — false while airborne. */
  get grounded(): boolean {
    for (let index = 0; index < 4; index += 1) {
      if (this.#controller.wheelIsInContact(index)) return true;
    }
    return false;
  }

  /** Where a passenger sits, in world space. */
  seatPosition(into: THREE.Vector3): THREE.Vector3 {
    const translation = this.#body.translation();
    const rotation = this.#body.rotation();
    chassisQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
    return into
      .set(...this.#settings.seatOffset)
      .applyQuaternion(chassisQuaternion)
      .add(new THREE.Vector3(translation.x, translation.y, translation.z));
  }

  /**
   * Engine force currently applied at one wheel, in newtons.
   *
   * Exposed because "does the drive layout reach the solver" has no other honest answer: a car with
   * every wheel driven pulls away exactly like a correctly configured rear-wheel-drive one on flat
   * ground, so watching it move proves nothing about which wheels are pushing.
   */
  engineForceAt(index: number): number {
    return this.#controller.wheelEngineForce(index) ?? 0;
  }

  /** How many fixed steps this vehicle has been driven for. Diagnostic. */
  get stepCount(): number {
    return this.#steps;
  }

  /** Braking force currently applied at one wheel. */
  brakeAt(index: number): number {
    return this.#controller.wheelBrake(index) ?? 0;
  }

  /** Hands the controller the wheel models to drive, in FL, FR, RL, RR order. */
  attachWheels(nodes: THREE.Object3D[]): void {
    this.#wheelNodes.length = 0;
    this.#wheelNodes.push(...nodes.slice(0, 4));
  }

  get wheelNodes(): readonly THREE.Object3D[] {
    return this.#wheelNodes;
  }

  /**
   * Integrates one fixed step of driving.
   *
   * Call it from `PhysicsWorld.step`'s `onFixedStep` hook, so the vehicle is updated at the rate the
   * solver resolves at rather than at the rate the screen refreshes.
   */
  drive(input: DriveInput, step: number): void {
    if (this.#disposed) return;
    this.#steps += 1;

    const settings = this.#settings;
    const speed = this.#controller.currentVehicleSpeed();

    /**
     * Steering, ramped rather than set.
     *
     * Snapping the angle is the single thing that makes a ray-cast car feel like a toy: the tyre
     * force changes direction in one step and the chassis jerks sideways. Ramping toward the target
     * is most of the difference between "driving" and "dragging a brick".
     */
    const limit = steerLimitAt(settings, speed);
    const target = THREE.MathUtils.clamp(input.steer, -1, 1) * limit;
    if (settings.steerSeconds <= 0) {
      this.#steer = target;
    } else {
      const rate = (settings.maxSteer / settings.steerSeconds) * step;
      this.#steer = THREE.MathUtils.clamp(target, this.#steer - rate, this.#steer + rate);
    }
    for (const index of STEERING_WHEELS) this.#controller.setWheelSteering(index, this.#steer);

    // Above the top speed the engine simply stops pushing, rather than a drag force being invented
    // to fight it. A car that is over its limit downhill should coast, not brake by itself.
    const throttle = THREE.MathUtils.clamp(input.throttle, -1, 1);
    const overspeed =
      Math.abs(speed) >= settings.maxSpeed && Math.sign(throttle) === Math.sign(speed);
    const force = overspeed ? 0 : throttle * settings.enginePower;

    const driven = new Set(drivenWheels(settings.drive));
    for (let index = 0; index < 4; index += 1) {
      this.#controller.setWheelEngineForce(index, driven.has(index) ? force : 0);
      // Braking on every wheel, driven or not — a handbrake that only worked on the driven axle
      // would make a front-wheel-drive car stop differently from a rear-wheel-drive one for no
      // reason the author chose.
      this.#controller.setWheelBrake(index, input.brake ? settings.brakePower : 0);
    }

    this.#controller.updateVehicle(step);
    this.#advanceWheels(step, speed);
  }

  /** Writes wheel model transforms from the solver's own contact points. */
  syncWheels(): void {
    if (this.#wheelNodes.length === 0) return;

    const rotation = this.#body.rotation();
    chassisQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

    for (let index = 0; index < this.#wheelNodes.length; index += 1) {
      const node = this.#wheelNodes[index]!;
      const hard = this.#controller.wheelChassisConnectionPointCs(index);
      const length = this.#controller.wheelSuspensionLength(index);
      if (!hard || length === null) continue;

      // The wheel sits where the suspension has actually compressed to, not at its rest position.
      // Drawing it at rest is what makes a car look like it is hovering over a bump rather than
      // absorbing it.
      const translation = this.#body.translation();
      wheelPosition
        .set(hard.x, hard.y - length, hard.z)
        .applyQuaternion(chassisQuaternion)
        .add(new THREE.Vector3(translation.x, translation.y, translation.z));

      node.position.copy(wheelPosition);
      node.quaternion
        .copy(chassisQuaternion)
        .multiply(wheelQuaternion.setFromAxisAngle(steerAxis, index < 2 ? this.#steer : 0))
        .multiply(wheelQuaternion.setFromAxisAngle(spinAxis, this.#spin[index]!));
      node.updateMatrixWorld(true);
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#world.world.removeVehicleController(this.#controller);
    this.#wheelNodes.length = 0;
  }

  /**
   * Rolls the wheels by how far the car actually travelled.
   *
   * Derived from speed rather than from engine force, so a wheel spinning up in the air or locked
   * under braking stops rolling — which is the cue that tells a player what the car is doing
   * without a single instrument on screen.
   */
  #advanceWheels(step: number, speed: number): void {
    const circumference = this.#settings.wheels.radius;
    if (circumference <= 0) return;

    const turn = (speed * step) / circumference;
    for (let index = 0; index < 4; index += 1) {
      // A braked wheel is a locked wheel. Rolling it while the car skids is the one detail that
      // makes braking read as sliding rather than as slowing down.
      const braked = (this.#controller.wheelBrake(index) ?? 0) > 0;
      if (!braked) this.#spin[index] = (this.#spin[index]! + turn) % (Math.PI * 2);
    }
  }
}
