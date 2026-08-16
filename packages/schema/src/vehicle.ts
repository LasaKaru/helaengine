import { z } from 'zod';
import { UnsetIdSchema, Vec3Schema } from './primitives.js';

/**
 * Things you can drive.
 *
 * A car, a cart, a rover. Built on Rapier's ray-cast vehicle controller rather than on four wheel
 * bodies held by joints, and the reason is not performance — it is that a jointed car is a physics
 * puzzle with an unbounded number of ways to go wrong. Wheels catch on seams, suspension resonates,
 * a hard landing pops an axle, and every one of those is a solver problem the author has no
 * vocabulary to describe let alone fix.
 *
 * A ray-cast vehicle has no wheel bodies at all. Each wheel is a downward ray from the chassis; the
 * suspension is a spring along that ray, and grip is a force applied at the contact point. The
 * chassis is the only rigid body in the whole thing. That is why it cannot come apart, and it is
 * what every driving game that feels good is actually doing.
 *
 * ## The wheels are visual
 *
 * `wheelAssetId` names a model placed at each ray's contact point, spun and steered to match. It
 * collides with nothing. A wheel that had a collider would fight the ray that already decided where
 * the wheel is.
 */

/**
 * Which wheels the engine drives and which ones steer.
 *
 * A closed vocabulary rather than per-wheel flags. Per-wheel would be more general and would mean
 * the panel had to ask eight questions to describe a car — and the answer for a car is always one
 * of these three.
 */
export const DRIVE_LAYOUTS = ['front', 'rear', 'all'] as const;
export const DriveLayoutSchema = z.enum(DRIVE_LAYOUTS);
export type DriveLayout = z.infer<typeof DriveLayoutSchema>;

export const DRIVE_LABELS: Record<DriveLayout, string> = {
  front: 'Front wheels',
  rear: 'Rear wheels',
  all: 'All four',
};

/**
 * Where the four wheels sit, in the chassis's own space.
 *
 * Half-extents rather than four positions: a car is symmetric, and offering four independent
 * corners would be four chances to make it subtly lopsided in a way that only shows up as a pull to
 * one side at speed.
 */
export const WheelLayoutSchema = z
  .object({
    /** Distance from the chassis centre to the front and rear axles, in metres. */
    axleOffset: z.number().min(0.1).max(20).default(1.2),
    /** Half the track width — how far each wheel sits from the centre line. */
    trackHalfWidth: z.number().min(0.1).max(10).default(0.8),
    /** Height of the wheel mounting points relative to the chassis origin. Usually negative. */
    hubHeight: z.number().min(-10).max(10).default(-0.2),
    radius: z.number().min(0.05).max(5).default(0.35),
  })
  .default({});
export type WheelLayout = z.infer<typeof WheelLayoutSchema>;

export const SuspensionSchema = z
  .object({
    /** Rest length of the suspension ray, in metres. */
    restLength: z.number().min(0.01).max(5).default(0.3),
    /**
     * How hard the spring pushes back. Higher is stiffer.
     *
     * The number most worth getting wrong slowly: too soft and the car wallows and grounds out on
     * every rise; too stiff and it skips off bumps and loses grip exactly when it needs it.
     */
    stiffness: z.number().min(1).max(1000).default(24),
    /** Damping while the spring is compressing. */
    compression: z.number().min(0).max(100).default(1.5),
    /** Damping while it extends again. Higher than compression, or the car pogos after a bump. */
    relaxation: z.number().min(0).max(100).default(2.8),
    /** How far the wheel may travel from rest, in metres. */
    maxTravel: z.number().min(0).max(5).default(0.4),
    /**
     * Ceiling on the force one spring may apply, so a hard landing cannot launch the car.
     *
     * The default has to hold an ordinary car up at the engine's *default* gravity, which is 24 and
     * not 9.81 — the character controller wants a heavier-feeling world than Earth. A 900kg car
     * there weighs 21.6kN, so four springs capped at 6kN each cannot hold it: it sinks until the
     * chassis box rests on the ground, and that puts the wheel hubs below the surface where their
     * rays find nothing at all. The car is then dead for good, with full engine force and no
     * traction, which looks exactly like the throttle being ignored. 40kN a wheel carries a 6-tonne
     * vehicle with margin, and `vehicleProblems` warns when a heavier one would still sink.
     */
    maxForce: z.number().min(0).max(1_000_000).default(40_000),
  })
  .default({});
export type Suspension = z.infer<typeof SuspensionSchema>;

export const VehicleSchema = z.object({
  /**
   * The model used for each wheel, or empty for none.
   *
   * Empty is legal to store and means a car whose wheels are invisible — which is exactly what a
   * half-built vehicle looks like, and better than the editor inventing a choice nobody reviewed.
   */
  wheelAssetId: UnsetIdSchema.default(''),
  wheels: WheelLayoutSchema,
  suspension: SuspensionSchema,
  drive: DriveLayoutSchema.default('rear'),

  /** Force one driven wheel applies at full throttle, in newtons. */
  enginePower: z.number().min(0).max(1_000_000).default(2400),
  /** Force one wheel applies under full braking. */
  brakePower: z.number().min(0).max(1_000_000).default(1200),
  /** Top speed in metres per second. Above it the engine stops pushing. */
  maxSpeed: z.number().min(1).max(200).default(28),
  /** How far the front wheels turn at full lock, in radians. */
  maxSteer: z.number().min(0.01).max(1.5).default(0.5),
  /**
   * Seconds to go from centred to full lock.
   *
   * Instant steering is the single thing that makes a ray-cast car feel like a toy: the chassis
   * snaps sideways because the tyre force changed direction in one step. Ramping it is most of the
   * difference between "driving" and "dragging a brick".
   */
  steerSeconds: z.number().min(0).max(5).default(0.25),
  /**
   * How much the steering angle shrinks at top speed, as a fraction.
   *
   * Zero means full lock is available at 100 km/h, which spins the car on any input. Real cars
   * solve this with steering-rack geometry; games solve it with this number.
   */
  steerSpeedFalloff: z.number().min(0).max(1).default(0.6),
  /** Sideways grip. Lower drifts, higher sticks. */
  friction: z.number().min(0).max(50).default(3),
  /** Resistance to sliding sideways at the tyre. Low values make the car feel like it is on ice. */
  sideFriction: z.number().min(0).max(10).default(1),

  /** Where the player sits relative to the chassis origin, for the camera and for getting out. */
  seatOffset: Vec3Schema.default([0, 0.8, 0]),
  /** How close the player must be to press the use key and get in, in metres. */
  enterRadius: z.number().min(0.5).max(20).default(3),
});
export type Vehicle = z.infer<typeof VehicleSchema>;

export const OptionalVehicleSchema = VehicleSchema.nullable().default(null);

export function defaultVehicle(): Vehicle {
  return VehicleSchema.parse({});
}

/** Wheel indices the engine drives, given a layout. Wheels are ordered FL, FR, RL, RR. */
export function drivenWheels(drive: DriveLayout): readonly number[] {
  if (drive === 'front') return [0, 1];
  if (drive === 'rear') return [2, 3];
  return [0, 1, 2, 3];
}

/** Wheel indices that steer. Always the front pair — a rear-steering car is a forklift. */
export const STEERING_WHEELS = [0, 1] as const;

/**
 * The four wheel mounting points in chassis space, ordered FL, FR, RL, RR.
 *
 * Derived rather than authored, so the order the runtime uses and the order `drivenWheels` talks
 * about cannot drift apart. -Z is forward, matching an unrotated Three.js camera and the character
 * controller's own convention.
 */
export function wheelPositions(layout: WheelLayout): Array<[number, number, number]> {
  const { axleOffset: axle, trackHalfWidth: track, hubHeight: hub } = layout;
  return [
    [-track, hub, -axle],
    [track, hub, -axle],
    [-track, hub, axle],
    [track, hub, axle],
  ];
}

/**
 * Steering available at a given speed, in radians.
 *
 * Full lock at a standstill, tapering toward `maxSteer * (1 - falloff)` at `maxSpeed`. Without the
 * taper a car spins on any input above walking pace, which reads as the handling being broken
 * rather than as a setting.
 */
export function steerLimitAt(vehicle: Vehicle, speed: number): number {
  const fraction = Math.min(Math.abs(speed) / vehicle.maxSpeed, 1);
  return vehicle.maxSteer * (1 - vehicle.steerSpeedFalloff * fraction);
}

/**
 * How far the lowest point of a wheel sits below the chassis origin, in metres.
 *
 * Also the height the chassis settles at on flat ground, which is the number an author needs when
 * placing a car: park one lower than this and the wheel rays start underground and find nothing.
 */
export function wheelReach(vehicle: Vehicle): number {
  return -vehicle.wheels.hubHeight + vehicle.suspension.restLength + vehicle.wheels.radius;
}

/**
 * Problems that would make a vehicle undriveable, or drive strangely.
 *
 * Reported rather than thrown, and shown in the editor: a car that silently refuses to move is
 * indistinguishable from one somebody forgot to finish.
 */
export function vehicleProblems(
  vehicle: Vehicle,
  body: string,
  knownAssets: ReadonlySet<string>,
  /** Chassis mass in kg and world gravity, when the caller knows them. */
  weight?: { mass: number; gravity: number },
): string[] {
  const problems: string[] = [];

  if (body !== 'dynamic') {
    // The chassis is the only rigid body a ray-cast vehicle has. A static one is a car-shaped wall,
    // and everything else about the document says it should drive.
    problems.push('the chassis must be Dynamic under Physics, or nothing can move it');
  }

  if (vehicle.wheelAssetId === '') {
    problems.push('no wheel model chosen — it will drive, but on invisible wheels');
  } else if (!knownAssets.has(vehicle.wheelAssetId)) {
    problems.push(`"${vehicle.wheelAssetId}" is not an asset this project has`);
  }

  if (vehicle.enginePower === 0) problems.push('the engine has no power, so it cannot pull away');

  /**
   * Wheels that never reach below the chassis.
   *
   * Colliders are built with their pivot at the base, so the object's origin *is* the bottom of the
   * chassis box. A wheel hangs from `hubHeight` and reaches `restLength + radius` further down; if
   * that never gets past the origin, the wheel is inside the chassis and its ray finds the ground
   * only once the chassis is already resting on it — at which point the ray starts underground and
   * finds nothing at all. The car then sits with full engine force and no traction, which looks
   * exactly like the throttle being ignored. It cost an afternoon to find.
   */
  if (wheelReach(vehicle) <= 0) {
    problems.push('the wheels never reach below the chassis, so they can never touch the ground');
  }

  if (vehicle.suspension.maxTravel > vehicle.suspension.restLength * 2) {
    // The wheel can extend far below where the ray expects ground, so the car hangs on its springs
    // and the chassis floats a wheel's height above the road.
    problems.push('suspension travel is long compared to its rest length, so the car will float');
  }

  if (weight && weight.mass * weight.gravity > vehicle.suspension.maxForce * 4) {
    /**
     * Springs that cannot hold the car up.
     *
     * The failure is total and permanent rather than merely soft: the chassis sinks until its own
     * collider rests on the ground, which leaves the wheel hubs below the surface with their rays
     * pointing down into nothing. No contact means no traction, so the car sits at full throttle
     * and does not move — and nothing about the document says why.
     */
    problems.push(
      'the suspension cannot hold this mass up — raise the spring force limit or lower the mass',
    );
  }

  if (vehicle.suspension.relaxation < vehicle.suspension.compression) {
    // Springs that extend faster than they compress pump energy into the chassis: the car bounces
    // higher after every bump until it takes off.
    problems.push('relaxation below compression makes the car pogo after every bump');
  }

  return problems;
}

/** Asset ids a vehicle needs the project to have, so a preload can fetch them. */
export function vehicleAssets(vehicle: Vehicle): string[] {
  return vehicle.wheelAssetId === '' ? [] : [vehicle.wheelAssetId];
}
