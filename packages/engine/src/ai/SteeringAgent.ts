import * as THREE from 'three';
import {
  ArriveBehavior,
  SeekBehavior,
  Vector3 as YukaVector3,
  Vehicle,
  WanderBehavior,
} from 'yuka';

export type SteeringMode = 'seek' | 'arrive' | 'wander' | 'none';

export interface SteeringAgentOptions {
  /** Metres per second the agent will not exceed. */
  maxSpeed: number;
  /** How hard it can turn. Low values make wide, heavy turns; high ones make it pivot. */
  maxForce?: number;
  /** How sharply `arrive` slows down. Higher is more abrupt; Yuka's default is 3. */
  deceleration?: number;
  /** How close `arrive` counts as arrived, in metres, so it never jitters around the point. */
  arrivalTolerance?: number;
}

const yukaTarget = new YukaVector3();

/**
 * Yuka steering, in the form the rest of the engine wants it.
 *
 * Yuka's `Vehicle` normally owns its own position and integrates itself, which is the one thing we
 * cannot let it do: an agent's position belongs to the physics world, or the sprint's promise that
 * steering drives Rapier bodies rather than raw mesh transforms would be empty. So each frame the
 * vehicle is told where its body actually is, asked where it would like to go, and the answer is
 * handed back as a target position for someone else to apply.
 *
 * The result is that Yuka does the part it is genuinely good at — the steering maths, with proper
 * arrival damping and a wander that does not look like a random walk — and nothing else.
 */
export class SteeringAgent {
  readonly #vehicle = new Vehicle();
  readonly #seek = new SeekBehavior();
  readonly #arrive: ArriveBehavior;
  readonly #wander = new WanderBehavior(2, 6, 4);
  readonly #next = new THREE.Vector3();
  #mode: SteeringMode = 'none';

  constructor(options: SteeringAgentOptions) {
    this.#vehicle.maxSpeed = options.maxSpeed;
    this.#vehicle.maxForce = options.maxForce ?? 20;
    // Orientation is decided by the caller: an enemy should face the way it moves, but the yaw it
    // ends up with has to survive being written to a kinematic body, not live on a Yuka entity.
    this.#vehicle.updateOrientation = false;
    this.#arrive = new ArriveBehavior(
      new YukaVector3(),
      options.deceleration ?? 3,
      options.arrivalTolerance ?? 0.2,
    );
    this.#seek.active = false;
    this.#arrive.active = false;
    this.#wander.active = false;
    this.#vehicle.steering.add(this.#seek).add(this.#arrive).add(this.#wander);
  }

  get maxSpeed(): number {
    return this.#vehicle.maxSpeed;
  }

  set maxSpeed(value: number) {
    this.#vehicle.maxSpeed = value;
  }

  /** Current speed in metres per second — useful for deciding between a walk and a run pose. */
  get speed(): number {
    return this.#vehicle.getSpeed();
  }

  /** Chooses which behaviour is doing the steering. Only one is ever active. */
  setMode(mode: SteeringMode): void {
    this.#mode = mode;
    this.#seek.active = mode === 'seek';
    this.#arrive.active = mode === 'arrive';
    this.#wander.active = mode === 'wander';
    if (mode === 'none') this.#vehicle.velocity.set(0, 0, 0);
  }

  setTarget(target: THREE.Vector3): void {
    yukaTarget.set(target.x, target.y, target.z);
    this.#seek.target.copy(yukaTarget);
    this.#arrive.target.copy(yukaTarget);
  }

  /** Drops the agent somewhere, cancelling its momentum. */
  reset(position: THREE.Vector3): void {
    this.#vehicle.position.set(position.x, position.y, position.z);
    this.#vehicle.velocity.set(0, 0, 0);
  }

  /**
   * Steers for one frame and returns where the agent would like to be.
   *
   * `from` is where its body actually is, which is not necessarily where the vehicle thought it
   * was — a wall, a slope or another body may have had other ideas last frame. Re-seating the
   * vehicle each frame is what keeps the steering honest about that.
   */
  step(from: THREE.Vector3, deltaSeconds: number): THREE.Vector3 {
    this.#vehicle.position.set(from.x, from.y, from.z);
    if (this.#mode === 'none') return this.#next.copy(from);

    this.#vehicle.update(deltaSeconds);
    const { x, y, z } = this.#vehicle.position;
    return this.#next.set(x, y, z);
  }
}
