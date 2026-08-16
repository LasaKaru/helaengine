import * as THREE from 'three';
import type { BodyType, ColliderType, Joint, Player, Vehicle } from '@helaengine/schema';
import type { TerrainField } from '../TerrainField.js';
import { colliderDescFor } from './colliders.js';
import { jointDataFor, jointIsDriveable } from './joints.js';
import { PlayerController } from './PlayerController.js';
import { VehicleController } from './VehicleController.js';
import { initPhysics, type RapierModule } from './rapier.js';

/** Rapier's own types are only reachable through the module namespace; these keep call sites readable. */
type RapierWorld = InstanceType<RapierModule['World']>;
type RapierRigidBody = ReturnType<RapierWorld['createRigidBody']>;
type RapierImpulseJoint = ReturnType<RapierWorld['createImpulseJoint']>;
/**
 * The joints that have an axis to limit and a motor to drive — hinges and sliders.
 *
 * Rapier puts `setLimits` and `configureMotor*` on this subclass rather than on `ImpulseJoint`,
 * which is a useful thing to be forced to acknowledge: asking a rope for its motor is a category
 * error, not a call that should quietly do nothing.
 */
type RapierUnitJoint = InstanceType<RapierModule['UnitImpulseJoint']>;

export interface PhysicsWorldOptions {
  /** Downward acceleration in metres per second squared. Default 9.81. */
  gravity?: number;
  /** Simulation step in seconds. Default 1/60. */
  fixedTimestep?: number;
  /** Ceiling on catch-up steps in one frame, so a stalled tab never spirals. Default 5. */
  maxSubsteps?: number;
}

export interface ObjectBodySpec {
  objectId: string;
  /** The scene-graph node this body follows (static) or drives (dynamic/kinematic). */
  node: THREE.Object3D;
  /** Resolved collider shape — `auto` must already have been turned into a real type. */
  shape: ColliderType;
  body: BodyType;
  /** World-space bounding size in metres, [width, height, depth], pivot at the base. */
  size: [number, number, number];
  mass?: number | undefined;
}

export interface BodyRecord {
  objectId: string;
  node: THREE.Object3D;
  body: RapierRigidBody;
  type: BodyType;
}

const position = new THREE.Vector3();
const quaternion = new THREE.Quaternion();
const scale = new THREE.Vector3();
const parentInverse = new THREE.Matrix4();
const composed = new THREE.Matrix4();

/**
 * A physics world that stays in step with a Three.js scene.
 *
 * Framework-free like the rest of `/packages/engine`: this exact class runs behind the editor's
 * Play Preview and inside an exported project. It owns the Rapier world and every body in it, and
 * `dispose()` frees the lot — Rapier allocates in WASM memory that no garbage collector will ever
 * reclaim on its own.
 *
 * Bodies are stepped at a fixed timestep with an accumulator rather than at the render rate.
 * Feeding a solver whatever delta the last frame happened to take makes physics resolution depend
 * on frame rate, which is how a character walks through a wall on a slow machine.
 */
export class PhysicsWorld {
  readonly rapier: RapierModule;
  readonly world: RapierWorld;
  readonly #bodies = new Map<string, BodyRecord>();
  /** Rapier body handle -> scene object id, so a raycast hit can say *what* it hit. */
  readonly #objectByBody = new Map<number, string>();
  readonly #dynamic: BodyRecord[] = [];
  readonly #fixedTimestep: number;
  readonly #maxSubsteps: number;
  readonly #players: PlayerController[] = [];
  readonly #vehicles: VehicleController[] = [];
  readonly #joints = new Map<string, RapierImpulseJoint>();
  /** Joint ids by the object at each end, so removing a body can drop the joints it took with it. */
  readonly #jointsByObject = new Map<string, Set<string>>();
  #terrain: RapierRigidBody | null = null;
  #accumulator = 0;
  #disposed = false;

  constructor(rapier: RapierModule, options: PhysicsWorldOptions = {}) {
    this.rapier = rapier;
    this.#fixedTimestep = options.fixedTimestep ?? 1 / 60;
    this.#maxSubsteps = options.maxSubsteps ?? 5;
    this.world = new rapier.World({ x: 0, y: -(options.gravity ?? 9.81), z: 0 });
    this.world.timestep = this.#fixedTimestep;
  }

  /** Initialises Rapier if needed, then builds a world. The one async door into physics. */
  static async create(options: PhysicsWorldOptions = {}): Promise<PhysicsWorld> {
    return new PhysicsWorld(await initPhysics(), options);
  }

  get bodyCount(): number {
    return this.#bodies.size;
  }

  get dynamicCount(): number {
    return this.#dynamic.length;
  }

  get hasTerrain(): boolean {
    return this.#terrain !== null;
  }

  bodyFor(objectId: string): BodyRecord | undefined {
    return this.#bodies.get(objectId);
  }

  /**
   * Adds the sculpted terrain as a static heightfield.
   *
   * A heightfield rather than a trimesh: it is the shape Rapier can query fastest, it costs one
   * float per vertex instead of a triangle list, and it is exactly what a `TerrainField` already
   * is. Rapier spans the field over `scale`, centred on the origin — which is also where the
   * terrain mesh sits, so the two need no reconciling.
   *
   * The one thing that does need reconciling is the index order. A `TerrainField` is row-major in
   * z (`z * width + x`, matching the plane geometry it builds); Rapier's height matrix runs the
   * other way (`x * width + z`). Transposing here is cheap and, unlike a sign error, immediately
   * obvious when it is wrong — a hill appears mirrored across the diagonal. `physics.test.ts`
   * pins the mapping against `sampleHeight` so it cannot quietly drift.
   */
  addTerrain(field: TerrainField): void {
    this.removeTerrain();

    const { width, segments, size, maxHeight } = field;
    const heights = new Float32Array(width * width);
    for (let z = 0; z < width; z += 1) {
      for (let x = 0; x < width; x += 1) {
        heights[x * width + z] = field.heights[z * width + x]! * maxHeight;
      }
    }

    const body = this.world.createRigidBody(this.rapier.RigidBodyDesc.fixed());
    this.world.createCollider(
      this.rapier.ColliderDesc.heightfield(segments, segments, heights, {
        x: size[0],
        y: 1,
        z: size[1],
      }),
      body,
    );
    this.#terrain = body;
  }

  removeTerrain(): void {
    if (!this.#terrain) return;
    this.world.removeRigidBody(this.#terrain);
    this.#terrain = null;
  }

  /**
   * Gives a scene object a body and a collider.
   *
   * Returns false when the object ends up with no collider — an asset marked `none`, or a `mesh`
   * request against a node with no triangles. Callers report that rather than substituting a shape,
   * so "this thing does not collide" is always something the user was told about.
   */
  addObject(spec: ObjectBodySpec): boolean {
    this.removeObject(spec.objectId);

    const descriptor = colliderDescFor(this.rapier, {
      shape: spec.shape,
      size: spec.size,
      node: spec.node,
    });
    if (!descriptor) return false;

    spec.node.updateWorldMatrix(true, false);
    spec.node.matrixWorld.decompose(position, quaternion, scale);

    const bodyDesc =
      spec.body === 'dynamic'
        ? this.rapier.RigidBodyDesc.dynamic()
        : spec.body === 'kinematic'
          ? this.rapier.RigidBodyDesc.kinematicPositionBased()
          : this.rapier.RigidBodyDesc.fixed();

    bodyDesc
      .setTranslation(position.x, position.y, position.z)
      .setRotation({ x: quaternion.x, y: quaternion.y, z: quaternion.z, w: quaternion.w });

    const body = this.world.createRigidBody(bodyDesc);
    if (spec.mass !== undefined && spec.body === 'dynamic') descriptor.setMass(spec.mass);
    this.world.createCollider(descriptor, body);

    const record: BodyRecord = { objectId: spec.objectId, node: spec.node, body, type: spec.body };
    this.#bodies.set(spec.objectId, record);
    this.#objectByBody.set(body.handle, spec.objectId);
    // Only bodies the solver can move are worth reading back every frame.
    if (spec.body !== 'static') this.#dynamic.push(record);
    return true;
  }

  /**
   * Turns an object's colliders on or off without destroying them.
   *
   * Disabling rather than removing, because a hidden secret area is expected to come back exactly
   * as it was: rebuilding a trimesh collider from scratch on reveal would be both slower and a
   * chance for the rebuilt one to differ from the original. Returns whether there was such a body.
   */
  setObjectEnabled(objectId: string, enabled: boolean): boolean {
    const record = this.#bodies.get(objectId);
    if (!record) return false;

    for (let index = 0; index < record.body.numColliders(); index += 1) {
      record.body.collider(index).setEnabled(enabled);
    }
    return true;
  }

  removeObject(objectId: string): void {
    const record = this.#bodies.get(objectId);
    if (!record) return;

    // Before the body goes, not after. Rapier frees a removed body's joints for us, which would
    // leave this map holding handles into freed memory — and the next `removeJoint` for one of them
    // would hand a dangling handle back to the solver.
    const attached = this.#jointsByObject.get(objectId);
    if (attached) {
      for (const jointId of [...attached]) this.removeJoint(jointId);
      this.#jointsByObject.delete(objectId);
    }

    this.world.removeRigidBody(record.body);
    this.#objectByBody.delete(record.body.handle);
    this.#bodies.delete(objectId);
    const at = this.#dynamic.indexOf(record);
    if (at >= 0) this.#dynamic.splice(at, 1);
  }

  get jointCount(): number {
    return this.#joints.size;
  }

  /**
   * Constrains two objects to each other.
   *
   * Returns false when either end has no body — which is not an error worth throwing over: an
   * object with a `none` collider legitimately has no body, and a level in mid-edit can name one it
   * has just deleted. The caller reports the skip, so "this hinge does nothing" is always something
   * the user was told about rather than something they discover by pushing a door.
   *
   * Waking both bodies is deliberate. Rapier lets a body fall asleep when it has been still, and a
   * sleeping body ignores a constraint that appears next to it — so a hinge added to a settled
   * assembly would do nothing until something else happened to disturb it.
   */
  addJoint(joint: Joint): boolean {
    this.removeJoint(joint.id);

    const a = this.#bodies.get(joint.objectA);
    const b = this.#bodies.get(joint.objectB);
    if (!a || !b || a === b) return false;

    const data = jointDataFor(this.rapier, joint);
    const created = this.world.createImpulseJoint(data, a.body, b.body, true);

    // `instanceof` rather than trusting the document's own type tag. The two agree today, but the
    // one that decides whether `setLimits` exists is the object Rapier handed back.
    if (jointIsDriveable(joint) && created instanceof this.rapier.UnitImpulseJoint) {
      if (joint.limit) created.setLimits(joint.limit.min, joint.limit.max);

      const motor = joint.motor;
      if (motor.mode === 'velocity') {
        created.configureMotorVelocity(motor.velocity, motor.damping);
      } else if (motor.mode === 'position') {
        created.configureMotorPosition(motor.target, motor.stiffness, motor.damping);
      }
    }

    created.setContactsEnabled(joint.collide);
    a.body.wakeUp();
    b.body.wakeUp();

    this.#joints.set(joint.id, created);
    for (const objectId of [joint.objectA, joint.objectB]) {
      let set = this.#jointsByObject.get(objectId);
      if (!set) this.#jointsByObject.set(objectId, (set = new Set()));
      set.add(joint.id);
    }
    return true;
  }

  removeJoint(jointId: string): void {
    const existing = this.#joints.get(jointId);
    if (!existing) return;
    this.world.removeImpulseJoint(existing, true);
    this.#joints.delete(jointId);
    for (const set of this.#jointsByObject.values()) set.delete(jointId);
  }

  /**
   * Retargets a joint's motor while the game is running.
   *
   * This is what a graph node or a behaviour drives a powered door with — the alternative would be
   * rebuilding the joint every time the target changed, which drops the accumulated impulse and
   * makes the door snap rather than swing.
   */
  driveJoint(jointId: string, target: number, stiffness: number, damping: number): boolean {
    const joint = this.#unitJoint(jointId);
    if (!joint) return false;
    joint.configureMotorPosition(target, stiffness, damping);
    return true;
  }

  /** A joint that has a motor, or null — a rope has no target to be driven to. */
  #unitJoint(jointId: string): RapierUnitJoint | null {
    const joint = this.#joints.get(jointId);
    return joint instanceof this.rapier.UnitImpulseJoint ? joint : null;
  }

  /**
   * Distance to the first thing along a ray, or null for a clear line.
   *
   * The one primitive every "is something in the way" question reduces to: a camera arm looking for
   * a wall, a crouched player checking for headroom, an enemy checking line of sight. Returning the
   * distance rather than a boolean is what lets a camera stop *just* short of the obstruction.
   */
  castDistance(
    from: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    excludeColliderHandle?: number,
  ): number | null {
    const hit = this.world.castRay(
      new this.rapier.Ray(
        { x: from.x, y: from.y, z: from.z },
        { x: direction.x, y: direction.y, z: direction.z },
      ),
      maxDistance,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      excludeColliderHandle === undefined
        ? undefined
        : (collider) => collider.handle !== excludeColliderHandle,
    );

    return hit ? hit.timeOfImpact : null;
  }

  /**
   * What a shot hits, and where.
   *
   * `objectId` is null when the ray lands on something that is not a scene object — the terrain,
   * or a collider whose body this world did not create. That is a hit, not a miss, and reporting it
   * as one is what lets a weapon spark off a hillside instead of shooting straight through it.
   */
  castObject(
    from: THREE.Vector3,
    direction: THREE.Vector3,
    maxDistance: number,
    excludeColliderHandle?: number,
  ): { objectId: string | null; distance: number; point: THREE.Vector3 } | null {
    const hit = this.world.castRay(
      new this.rapier.Ray(
        { x: from.x, y: from.y, z: from.z },
        { x: direction.x, y: direction.y, z: direction.z },
      ),
      maxDistance,
      true,
      undefined,
      undefined,
      undefined,
      undefined,
      excludeColliderHandle === undefined
        ? undefined
        : (collider) => collider.handle !== excludeColliderHandle,
    );
    if (!hit) return null;

    const bodyHandle = hit.collider.parent()?.handle;
    return {
      objectId: bodyHandle === undefined ? null : (this.#objectByBody.get(bodyHandle) ?? null),
      distance: hit.timeOfImpact,
      point: from.clone().addScaledVector(direction, hit.timeOfImpact),
    };
  }

  /**
   * Builds a driveable vehicle on an existing object's body.
   *
   * Returns null when the object has no body, or has one the solver cannot move. A ray-cast vehicle
   * pushes its *chassis*, so a static one is a car-shaped wall — reporting that is what lets the
   * editor say so rather than leaving the author to wonder why the throttle does nothing.
   */
  createVehicle(objectId: string, settings: Vehicle): VehicleController | null {
    const record = this.#bodies.get(objectId);
    if (!record || record.type !== 'dynamic') return null;

    const controller = new VehicleController(this, objectId, record.body, settings);
    this.#vehicles.push(controller);
    return controller;
  }

  vehicleFor(objectId: string): VehicleController | undefined {
    return this.#vehicles.find((vehicle) => vehicle.objectId === objectId);
  }

  get vehicleCount(): number {
    return this.#vehicles.length;
  }

  /** Forgets a vehicle so a disposed one is not synced from freed memory. */
  releaseVehicle(controller: VehicleController): void {
    const at = this.#vehicles.indexOf(controller);
    if (at >= 0) this.#vehicles.splice(at, 1);
  }

  /** Builds a character controller for the document's player. Stepped and synced with the world. */
  createPlayer(player: Player, spawn?: THREE.Vector3): PlayerController {
    const controller = new PlayerController(this, player, spawn);
    this.#players.push(controller);
    return controller;
  }

  /** Forgets a controller so a disposed player is not synced from freed memory. */
  releasePlayer(controller: PlayerController): void {
    const at = this.#players.indexOf(controller);
    if (at >= 0) this.#players.splice(at, 1);
  }

  /**
   * Advances the simulation by a frame's worth of time.
   *
   * `onFixedStep` runs once per solver step, before it — that is where a character controller
   * belongs, so its movement is integrated at the same rate everything else is resolved at.
   */
  step(delta: number, onFixedStep?: (step: number) => void): number {
    if (this.#disposed) return 0;

    // A tab that was in the background hands back a delta of minutes. Clamping here means the
    // catch-up is bounded by wall-clock time as well as by substep count.
    this.#accumulator = Math.min(
      this.#accumulator + delta,
      this.#fixedTimestep * this.#maxSubsteps,
    );

    let steps = 0;
    while (this.#accumulator >= this.#fixedTimestep && steps < this.#maxSubsteps) {
      onFixedStep?.(this.#fixedTimestep);
      this.world.step();
      this.#accumulator -= this.#fixedTimestep;
      steps += 1;
    }

    if (steps > 0) this.syncToScene();
    return steps;
  }

  /**
   * Writes body transforms back onto their Three.js nodes.
   *
   * Rapier works in world space and the scene graph does not, so a body on a parented node has its
   * result converted back into the parent's space. Doing it here rather than restricting physics to
   * root objects means a crate parented to a building still falls correctly.
   */
  syncToScene(): void {
    for (const player of this.#players) player.sync();
    // Before the dynamic bodies rather than after: a wheel model is positioned from the chassis's
    // own transform, and reading it a frame late makes the wheels trail the car they belong to.
    for (const vehicle of this.#vehicles) vehicle.syncWheels();

    for (const record of this.#dynamic) {
      const translation = record.body.translation();
      const rotation = record.body.rotation();
      position.set(translation.x, translation.y, translation.z);
      quaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);

      const parent = record.node.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        parentInverse.copy(parent.matrixWorld).invert();
        composed.compose(position, quaternion, record.node.scale).premultiply(parentInverse);
        composed.decompose(record.node.position, record.node.quaternion, scale);
      } else {
        record.node.position.copy(position);
        record.node.quaternion.copy(quaternion);
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#bodies.clear();
    this.#objectByBody.clear();
    this.#dynamic.length = 0;
    this.#players.length = 0;
    this.#vehicles.length = 0;
    this.#joints.clear();
    this.#jointsByObject.clear();
    this.#terrain = null;
    // Frees the WASM allocation behind the world; without it a scene reload leaks a whole solver.
    this.world.free();
  }
}

export type { RapierRigidBody, RapierWorld };
