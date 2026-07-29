import * as THREE from 'three';
import type { Player } from '@helaengine/schema';
import type { PhysicsWorld, RapierRigidBody } from './PhysicsWorld.js';
import type { RapierModule } from './rapier.js';

type Collider = ReturnType<InstanceType<RapierModule['World']>['createCollider']>;
type Controller = ReturnType<InstanceType<RapierModule['World']>['createCharacterController']>;

const DEG2RAD = Math.PI / 180;

/** One frame of intent. Values are unnormalised; the controller clamps and orients them. */
export interface MoveInput {
  /** -1 back … 1 forward. */
  forward: number;
  /** -1 left … 1 right. */
  right: number;
  jump: boolean;
  sprint?: boolean;
  crouch?: boolean;
  /**
   * Heading in radians: the camera's Y euler angle, so `0` faces -Z exactly as an unrotated
   * Three.js camera does. Sharing the convention is what keeps "forward" the same direction for
   * the view and for the feet.
   */
  yaw: number;
}

const desired = new THREE.Vector3();
const heading = new THREE.Vector3();
const strafe = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * A walking character, built on Rapier's kinematic character controller.
 *
 * Kinematic rather than dynamic on purpose: a dynamic capsule is at the mercy of the solver and
 * feels like pushing a shopping trolley — it tips, it slides on slopes, it bounces off steps. A
 * character controller instead asks "if I try to move here, where do I actually end up", and
 * answers with sliding, slope limits and step-over built in. That is what makes a first-person
 * preview feel like a game rather than a physics demo.
 */
export class PlayerController {
  readonly #world: PhysicsWorld;
  readonly #controller: Controller;
  readonly #body: RapierRigidBody;
  readonly #collider: Collider;
  readonly #player: Player;
  readonly #position = new THREE.Vector3();
  #verticalVelocity = 0;
  #grounded = false;
  #disposed = false;
  #crouched = false;
  #speed = 0;
  readonly #standHalfHeight: number;
  readonly #crouchHalfHeight: number;

  constructor(world: PhysicsWorld, player: Player, spawn?: THREE.Vector3) {
    const { rapier } = world;
    this.#world = world;
    this.#player = player;

    const start = spawn ?? new THREE.Vector3(...player.spawn);
    const radius = player.radius;
    const halfHeight = Math.max(player.height / 2 - radius, 0.05);
    this.#standHalfHeight = halfHeight;
    this.#crouchHalfHeight = Math.max(
      (player.height * player.crouchHeightRatio) / 2 - radius,
      0.05,
    );

    this.#body = world.world.createRigidBody(
      rapier.RigidBodyDesc.kinematicPositionBased().setTranslation(
        start.x,
        // The capsule's origin is its centre, while a spawn point means "where the feet go".
        start.y + halfHeight + radius,
        start.z,
      ),
    );
    this.#collider = world.world.createCollider(
      rapier.ColliderDesc.capsule(halfHeight, radius),
      this.#body,
    );

    // The offset is the gap the controller keeps between the character and the world. Too small and
    // contacts jitter; too large and the character visibly hovers. A tenth of the radius is the
    // ratio Rapier's own examples settle on.
    this.#controller = world.world.createCharacterController(radius * 0.1);
    this.#controller.setUp({ x: 0, y: 1, z: 0 });
    this.#controller.setSlideEnabled(true);
    this.#controller.setMaxSlopeClimbAngle(player.maxSlopeDegrees * DEG2RAD);
    this.#controller.setMinSlopeSlideAngle((player.maxSlopeDegrees + 5) * DEG2RAD);
    this.#controller.enableAutostep(player.stepHeight, player.radius * 0.5, true);
    // Snapping keeps the character on the ground walking downhill; without it a slope launches you
    // into a series of small hops.
    this.#controller.enableSnapToGround(player.stepHeight);

    this.#readBack();
  }

  /** Feet position — the same convention as a scene object's transform. */
  get position(): THREE.Vector3 {
    return this.#position;
  }

  /** Camera height: the top of the capsule, less a little so the view is not inside the crown. */
  get eyeHeight(): number {
    const height = this.#crouched
      ? this.#player.height * this.#player.crouchHeightRatio
      : this.#player.height;
    return height - 0.15;
  }

  /** Ground speed last frame, in metres per second — what a head bob and a footstep loop want. */
  get speed(): number {
    return this.#speed;
  }

  get crouched(): boolean {
    return this.#crouched;
  }

  /**
   * Rapier handle of the character's own capsule.
   *
   * Line-of-sight traces need it: a ray aimed at the player hits the player, and without knowing
   * which collider that is, every enemy would conclude it was looking at a wall.
   */
  get colliderHandle(): number {
    return this.#collider.handle;
  }

  get grounded(): boolean {
    return this.#grounded;
  }

  get verticalVelocity(): number {
    return this.#verticalVelocity;
  }

  /**
   * Integrates one fixed step of movement.
   *
   * Call it from `PhysicsWorld.step`'s `onFixedStep` hook, so intent is applied at the rate the
   * solver resolves at rather than at the rate the screen happens to refresh.
   */
  move(input: MoveInput, step: number): void {
    if (this.#disposed) return;

    this.#setCrouched(input.crouch === true);

    // Camera-relative movement: forward is where you are looking, flattened onto the ground.
    heading.set(-Math.sin(input.yaw), 0, -Math.cos(input.yaw));
    strafe.set(-heading.z, 0, heading.x);
    desired.set(0, 0, 0);
    desired.addScaledVector(heading, input.forward);
    desired.addScaledVector(strafe, input.right);
    if (desired.lengthSq() > 1) desired.normalize();

    // Crouching wins over sprinting: a player holding both is trying to sneak, and a sprint-crouch
    // that moved at full speed would be a exploit rather than a feature.
    const speed =
      this.#player.moveSpeed *
      (this.#crouched
        ? this.#player.crouchMultiplier
        : input.sprint === true
          ? this.#player.sprintMultiplier
          : 1);
    desired.multiplyScalar(speed * step);

    if (this.#grounded) {
      // A small downward bias while grounded keeps the character pressed onto slopes instead of
      // skimming off the top of every rise.
      this.#verticalVelocity = input.jump ? this.#player.jumpSpeed : -this.#player.gravity * step;
    } else {
      this.#verticalVelocity -= this.#player.gravity * step;
    }
    desired.y = this.#verticalVelocity * step;

    this.#controller.computeColliderMovement(this.#collider, desired);
    const movement = this.#controller.computedMovement();
    this.#grounded = this.#controller.computedGrounded();

    const current = this.#body.translation();
    this.#body.setNextKinematicTranslation({
      x: current.x + movement.x,
      y: current.y + movement.y,
      z: current.z + movement.z,
    });

    this.#speed = step > 0 ? Math.hypot(movement.x, movement.z) / step : 0;

    // Landing or hitting a ceiling: keep integrating gravity from a standstill rather than from a
    // velocity the character never actually reached.
    if (this.#grounded && this.#verticalVelocity < 0) this.#verticalVelocity = 0;
  }

  /** Reads the solver's answer onto `position`. Called for you by `PhysicsWorld.step`. */
  sync(): void {
    this.#readBack();
  }

  /** Drops the character somewhere new, cancelling any fall in progress. */
  teleport(to: THREE.Vector3): void {
    const radius = this.#player.radius;
    const halfHeight = Math.max(this.#player.height / 2 - radius, 0.05);
    this.#body.setTranslation({ x: to.x, y: to.y + halfHeight + radius, z: to.z }, true);
    this.#verticalVelocity = 0;
    this.#readBack();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#world.releasePlayer(this);
    this.#world.world.removeCharacterController(this.#controller);
    this.#world.world.removeRigidBody(this.#body);
  }

  /**
   * Shrinks or restores the capsule.
   *
   * A real resize rather than only lowering the camera, because the point of crouching is fitting
   * under things. Standing up is refused when there is no room — otherwise a player could stand up
   * inside a ceiling and be ejected through it.
   */
  #setCrouched(wanted: boolean): void {
    if (wanted === this.#crouched) return;

    if (!wanted) {
      const clearance = (this.#standHalfHeight - this.#crouchHalfHeight) * 2;
      const translation = this.#body.translation();
      const headroom = this.#world.castDistance(
        new THREE.Vector3(translation.x, translation.y, translation.z),
        UP,
        this.#standHalfHeight + this.#player.radius + clearance,
        this.#collider.handle,
      );
      if (headroom !== null) return;
    }

    this.#crouched = wanted;
    this.#collider.setHalfHeight(wanted ? this.#crouchHalfHeight : this.#standHalfHeight);
    // The body origin is the capsule centre, so resizing it without moving the body would sink the
    // character into the floor by exactly the amount it shrank.
    const delta = (this.#standHalfHeight - this.#crouchHalfHeight) * (wanted ? -1 : 1);
    const translation = this.#body.translation();
    this.#body.setTranslation(
      { x: translation.x, y: translation.y + delta, z: translation.z },
      true,
    );
    this.#readBack();
  }

  #readBack(): void {
    const radius = this.#player.radius;
    const halfHeight = this.#crouched ? this.#crouchHalfHeight : this.#standHalfHeight;
    const translation = this.#body.translation();
    this.#position.set(translation.x, translation.y - halfHeight - radius, translation.z);
  }
}
