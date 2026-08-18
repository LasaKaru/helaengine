import * as THREE from 'three';
import type { Player } from '@helaengine/schema';
import {
  isSwimming,
  submergedFraction,
  swimSpeedFactor,
  swimVerticalVelocity,
} from './buoyancy.js';
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
const DOWN = new THREE.Vector3(0, -1, 0);
const probe = new THREE.Vector3();

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
  #swimming = false;
  /** How much of the character is under water, 0 to 1. Drives the swim state and the speed penalty. */
  #submersion = 0;
  #disposed = false;
  #crouched = false;
  #speed = 0;
  /**
   * Seconds of coyote time left — how long a jump will still be accepted after leaving the ground.
   *
   * Counted down rather than a timestamp, so it advances with the fixed step and is unaffected by
   * how long the frame took. A wall-clock deadline would make the window longer on a slow machine.
   */
  #coyoteLeft = 0;
  /** Seconds left of a remembered jump press, waiting for the ground to arrive. */
  #bufferLeft = 0;
  /** Whether the jump button was down last step, so a held button is not a stream of jumps. */
  #jumpHeld = false;
  /** Ground direction at the moment of takeoff, for air control below 1. */
  readonly #takeoff = new THREE.Vector3();
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

  /** Whether the character is swimming rather than walking. What a swim animation and an audio bed want. */
  get swimming(): boolean {
    return this.#swimming;
  }

  /** How much of the character is under water, 0 to 1. Above zero while wading, before swimming starts. */
  get submersion(): number {
    return this.#submersion;
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

    /**
     * How deep the character is, and whether that counts as swimming.
     *
     * Read from the body's own height against the water plane rather than from a trigger volume
     * somebody has to remember to place: the surface is level-wide and the terrain decides where it
     * shows, so a character is in water exactly when the ground under them is below it. There is
     * nothing to keep in step and nothing to forget.
     */
    const water = this.#world.water;
    const submersion = water
      ? submergedFraction(this.#position.y, this.#player.height, water.height)
      : 0;
    const swimming = water !== null && isSwimming(submersion);
    this.#submersion = submersion;
    this.#swimming = swimming;

    // Crouching wins over sprinting: a player holding both is trying to sneak, and a sprint-crouch
    // that moved at full speed would be a exploit rather than a feature.
    const speed =
      this.#player.moveSpeed *
      (this.#crouched
        ? this.#player.crouchMultiplier
        : input.sprint === true
          ? this.#player.sprintMultiplier
          : 1) *
      // Sprinting through chest-deep water at full speed is the single thing that makes water read
      // as a painted decal rather than as water.
      (water && submersion > 0 ? swimSpeedFactor(submersion, water) : 1);

    /**
     * Air control: how far the player may steer away from the direction they left the ground in.
     *
     * Blended toward the takeoff direction rather than clamped, so the setting is a dial and not a
     * switch — 0.3 is "you can adjust", 0 is "you are committed", 1 is the old behaviour and stays
     * the default. Blending also keeps the vector's length right, where scaling only the difference
     * would quietly make diagonal air movement slower than straight.
     */
    if (!this.#grounded && this.#player.airControl < 1) {
      desired.lerpVectors(this.#takeoff, desired, this.#player.airControl);
      if (desired.lengthSq() > 1) desired.normalize();
    }

    desired.multiplyScalar(speed * step);

    // Windows first, so this step's decision uses this step's clock. Counting them down afterwards
    // would give every window one free frame more than it was set to.
    this.#coyoteLeft = this.#grounded
      ? this.#player.coyoteSeconds
      : Math.max(0, this.#coyoteLeft - step);

    // The buffer is filled on the *edge* of the press. While the button is held `input.jump` is
    // already saying so, so refilling would change nothing except to make the window outlive the
    // release by its full length.
    const pressed = input.jump && !this.#jumpHeld;
    this.#jumpHeld = input.jump;
    if (pressed) this.#bufferLeft = this.#player.jumpBufferSeconds;
    else this.#bufferLeft = Math.max(0, this.#bufferLeft - step);

    /**
     * Whether this step is a jump.
     *
     * `input.jump` rather than `pressed`, deliberately. Holding the button has always made the
     * character bounce on every landing, and that is the behaviour a level tuned against the old
     * controller was tuned against — so with both windows at zero this reduces to exactly
     * `input.jump && this.#grounded`, which is what the line here used to say. Making a jump
     * edge-triggered would be a better default and is not this change's to make: it would alter
     * every existing scene, silently, in a way nobody asked for.
     *
     * `coyoteLeft > 0` covers the player who pressed a moment after walking off the lip;
     * `bufferLeft > 0` covers the one who pressed a moment before landing. Both are the same
     * mistake, and both are almost always the game's fault rather than the player's.
     */
    const wantsJump = input.jump || this.#bufferLeft > 0;
    const mayJump = this.#grounded || this.#coyoteLeft > 0;
    const jumping = wantsJump && mayJump;

    // A mantle is offered on the same press as a jump, and only when a plain jump would not clear
    // the ledge anyway — so it never takes a jump the player meant to make. Never while swimming:
    // a swimmer next to a bank is always beside a ledge they cannot reach, and the mantle would fire
    // on every stroke.
    const mantle = wantsJump && !swimming ? this.#mantleBoost(heading) : 0;

    if (swimming && water) {
      /**
       * Swimming: buoyancy and drag replace the fall, and jump becomes a stroke upward.
       *
       * Replace rather than add. Leaving the fall running and adding lift on top means two systems
       * integrating the same axis, and the result is a character who sinks in water whose buoyancy
       * is set to float and floats in water set to sink — the sign of the outcome decided by which
       * of the two happened to be larger.
       */
      this.#verticalVelocity = swimVerticalVelocity(
        this.#verticalVelocity,
        submersion,
        this.#player.gravity,
        water,
        step,
        input.jump,
      );
      // Neither window means anything in water: there is no edge to have walked off, and a jump
      // remembered from the bank would fire the moment the player's feet found the bottom.
      this.#coyoteLeft = 0;
      this.#bufferLeft = 0;
      this.#takeoff.copy(desired).setY(0);
      if (this.#takeoff.lengthSq() > 1e-6) this.#takeoff.normalize();
    } else if (mantle > 0) {
      this.#verticalVelocity = mantle;
      this.#coyoteLeft = 0;
      this.#bufferLeft = 0;
      this.#takeoff.copy(heading);
    } else if (jumping) {
      this.#verticalVelocity = this.#player.jumpSpeed;
      // Both windows are spent by the jump they caused. Leaving coyote time running would let a
      // player jump a second time out of the same window, in mid-air.
      this.#coyoteLeft = 0;
      this.#bufferLeft = 0;
      this.#takeoff.copy(desired).setY(0);
      if (this.#takeoff.lengthSq() > 1e-6) this.#takeoff.normalize();
    } else if (this.#grounded) {
      // A small downward bias while grounded keeps the character pressed onto slopes instead of
      // skimming off the top of every rise.
      this.#verticalVelocity = -this.#player.gravity * step;
      // Standing on the ground, the takeoff direction is wherever they are heading now — so
      // stepping off an edge during coyote time commits to the direction they were walking.
      this.#takeoff.copy(desired).setY(0);
      if (this.#takeoff.lengthSq() > 1e-6) this.#takeoff.normalize();
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

  /**
   * Turns the character's own capsule on or off.
   *
   * For riding in things. A driver sits *inside* the chassis collider, and a kinematic capsule
   * teleported back into that overlap every frame is a permanent penetration the solver spends the
   * whole journey trying to resolve — it pushes back hard enough to pin the car in place, which
   * reads exactly like the throttle not working.
   */
  setColliderEnabled(enabled: boolean): void {
    this.#collider.setEnabled(enabled);
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

  /**
   * Launch speed that would carry the player onto a ledge in front of them, or 0 for no mantle.
   *
   * A mantle as an *assisted jump* rather than a scripted climb. The scripted version — take control
   * of the body, drive it along a curve, hand it back — is a second movement system with its own
   * collision story, and every one of its edge cases (mantling into a low ceiling, onto something
   * that then moves, while another body pushes you) has to be solved separately. Choosing a launch
   * speed instead leaves the solver in charge throughout: the player is pressing forward already, so
   * forward momentum carries them over, and everything that was true of a jump stays true.
   *
   * The cost is that it looks like a strong hop rather than a hand-over-hand climb. That is the
   * honest trade for a low-poly engine, and it is the version that cannot get the player stuck.
   */
  #mantleBoost(heading: THREE.Vector3): number {
    const limit = this.#player.mantleHeight;
    if (limit <= 0 || heading.lengthSq() < 1e-6) return 0;

    const radius = this.#player.radius;
    const feetY = this.#position.y;
    const reach = radius + 0.35;

    // Something solid in front, above what a step would have handled on its own. Without this
    // check, walking at open ground would mantle on every press.
    probe.copy(this.#position).setY(feetY + this.#player.stepHeight + 0.05);
    if (this.#world.castDistance(probe, heading, reach, this.#collider.handle) === null) return 0;

    // Where the top of it is: a ray straight down, started above the highest ledge that counts and
    // aimed at a point past the face rather than at the face itself.
    probe.copy(this.#position).addScaledVector(heading, reach);
    probe.y = feetY + limit + 0.5;
    const drop = this.#world.castDistance(probe, DOWN, limit + 1, this.#collider.handle);
    if (drop === null) return 0;

    const ledge = probe.y - drop - feetY;
    // Below a step it is not a mantle, it is a kerb the controller already walks over. Above the
    // limit it is a wall, and pretending otherwise is how a player ends up on the skybox.
    if (ledge <= this.#player.stepHeight || ledge > limit) return 0;

    // Headroom for a standing capsule on top of the ledge. Mantling under a low overhang would
    // wedge the player into it, which is the one outcome worse than not mantling.
    probe.y = feetY + ledge + 0.05;
    const clearance = this.#standHalfHeight * 2 + radius * 2;
    if (this.#world.castDistance(probe, UP, clearance, this.#collider.handle) !== null) return 0;

    // v = sqrt(2gh), plus a margin for the rise being spent partly on moving forward.
    return Math.sqrt(2 * this.#player.gravity * (ledge + 0.25));
  }

  #readBack(): void {
    const radius = this.#player.radius;
    const halfHeight = this.#crouched ? this.#crouchHalfHeight : this.#standHalfHeight;
    const translation = this.#body.translation();
    this.#position.set(translation.x, translation.y - halfHeight - radius, translation.z);
  }
}
