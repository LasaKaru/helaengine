import * as THREE from 'three';
import type { CameraMode } from '@helaengine/schema';

/** Where the character is and how tall they currently are. */
export interface CameraTarget {
  /** Feet position, the same convention a scene object's transform uses. */
  position: THREE.Vector3;
  /** Height of the eyes above the feet. Shrinks when crouched. */
  eyeHeight: number;
  /** Ground speed in metres per second, for effects that respond to movement. */
  speed: number;
  /** Whether the character has ground under them. */
  grounded: boolean;
}

/** Where the player is looking, in radians. `yaw` is the camera's Y euler; 0 faces -Z. */
export interface LookState {
  yaw: number;
  pitch: number;
}

export interface CameraRigContext {
  /**
   * Distance to the first obstruction along a ray, or null for a clear line.
   *
   * Supplied by whoever owns the physics world. Without it a rig simply does not do collision
   * avoidance, which is the honest degradation: a scene with no physics has nothing to collide with.
   */
  probe?: (from: THREE.Vector3, direction: THREE.Vector3, maxDistance: number) => number | null;
  fieldOfView: number;
  distance: number;
  height: number;
  headBob: boolean;
}

/**
 * A way of pointing a camera at a character.
 *
 * Deliberately an interface with three implementations rather than one camera class with a `mode`
 * flag: a first-person rig has a head-bob phase, a third-person rig has a spring arm and a
 * collision probe, and a top-down rig has neither. Folding them together would mean one class
 * carrying three sets of state, two of which are always dead.
 */
export interface CameraRig {
  readonly mode: CameraMode;
  /** Places the camera for this frame. */
  update(
    camera: THREE.PerspectiveCamera,
    target: CameraTarget,
    look: LookState,
    deltaSeconds: number,
    context: CameraRigContext,
  ): void;
  /** Called when the rig stops being the active one. */
  reset?(): void;
}

const forward = new THREE.Vector3();
const desired = new THREE.Vector3();
const eye = new THREE.Vector3();

/** Turns a yaw/pitch pair into a direction, using the same convention as `PlayerController`. */
export function lookDirection(look: LookState, out: THREE.Vector3): THREE.Vector3 {
  const cosPitch = Math.cos(look.pitch);
  return out
    .set(-Math.sin(look.yaw) * cosPitch, Math.sin(look.pitch), -Math.cos(look.yaw) * cosPitch)
    .normalize();
}

/** How far the camera sways, in metres, at full walking speed. */
const BOB_AMPLITUDE = 0.045;
/** Sway cycles per metre travelled — tied to distance, not time, so it slows when you do. */
const BOB_CYCLES_PER_METRE = 1.1;

/**
 * Eyes-in-the-head first person.
 *
 * The head bob is driven by distance travelled rather than by elapsed time, which is the difference
 * between a walk cycle that slows down when the player slows down and a camera that wobbles on the
 * spot. It stops entirely in mid-air, because there is no footfall to bob to.
 */
export class FirstPersonRig implements CameraRig {
  readonly mode = 'fps' as const;
  #bobPhase = 0;

  update(
    camera: THREE.PerspectiveCamera,
    target: CameraTarget,
    look: LookState,
    deltaSeconds: number,
    context: CameraRigContext,
  ): void {
    if (target.grounded) {
      this.#bobPhase += target.speed * deltaSeconds * BOB_CYCLES_PER_METRE * Math.PI * 2;
    }

    const bob =
      context.headBob && target.grounded
        ? Math.sin(this.#bobPhase) * BOB_AMPLITUDE * Math.min(1, target.speed / 4)
        : 0;

    camera.position.set(
      target.position.x,
      target.position.y + target.eyeHeight + bob,
      target.position.z,
    );
    camera.quaternion.setFromEuler(new THREE.Euler(look.pitch, look.yaw, 0, 'YXZ'));
    applyFov(camera, context.fieldOfView);
  }

  reset(): void {
    this.#bobPhase = 0;
  }
}

/** How fast the arm returns to its full length once the obstruction is gone, in metres per second. */
const ARM_RECOVER_RATE = 6;
/** Gap kept between the camera and whatever it hit, so the near plane never clips through. */
const ARM_SKIN = 0.25;

/**
 * A spring arm behind the character.
 *
 * The arm shortens instantly when something gets between the camera and the player — a slow pull-in
 * means a frame or two of looking at the inside of a wall — and lengthens gradually when the way
 * clears, because a camera that snaps outward is far more jarring than one that eases.
 */
export class ThirdPersonRig implements CameraRig {
  readonly mode = 'tps' as const;
  #armLength = 0;

  update(
    camera: THREE.PerspectiveCamera,
    target: CameraTarget,
    look: LookState,
    deltaSeconds: number,
    context: CameraRigContext,
  ): void {
    // Pivot at head height rather than at the feet, or looking down would swing the camera through
    // the floor while looking up would leave the character at the bottom of the screen.
    eye.set(target.position.x, target.position.y + target.eyeHeight, target.position.z);
    lookDirection(look, forward);

    let wanted = context.distance;
    const probe = context.probe;
    if (probe) {
      desired.copy(forward).negate();
      const hit = probe(eye, desired, context.distance + ARM_SKIN);
      if (hit !== null) wanted = Math.max(0.4, hit - ARM_SKIN);
    }

    if (wanted < this.#armLength || this.#armLength === 0) this.#armLength = wanted;
    else this.#armLength = Math.min(wanted, this.#armLength + ARM_RECOVER_RATE * deltaSeconds);

    camera.position.copy(eye).addScaledVector(forward, -this.#armLength);
    camera.quaternion.setFromEuler(new THREE.Euler(look.pitch, look.yaw, 0, 'YXZ'));
    applyFov(camera, context.fieldOfView);
  }

  reset(): void {
    this.#armLength = 0;
  }
}

/**
 * Straight down, turning with the player's yaw.
 *
 * Pitch is ignored on purpose: a top-down camera that tilted with the look input would stop being
 * top-down, and the mode exists precisely because some games want a fixed perspective.
 */
export class TopDownRig implements CameraRig {
  readonly mode = 'topdown' as const;

  update(
    camera: THREE.PerspectiveCamera,
    target: CameraTarget,
    look: LookState,
    _deltaSeconds: number,
    context: CameraRigContext,
  ): void {
    camera.position.set(
      target.position.x,
      target.position.y + context.height,
      target.position.z + 0.001,
    );
    camera.up.set(-Math.sin(look.yaw), 0, -Math.cos(look.yaw));
    camera.lookAt(target.position.x, target.position.y, target.position.z);
    applyFov(camera, context.fieldOfView);
  }

  reset(): void {
    // The up vector is the one thing a top-down rig leaves behind; every other rig assumes +Y.
  }
}

function applyFov(camera: THREE.PerspectiveCamera, fieldOfView: number): void {
  if (camera.fov === fieldOfView) return;
  camera.fov = fieldOfView;
  camera.updateProjectionMatrix();
}

/** Builds the rig a document asks for. */
export function createCameraRig(mode: CameraMode): CameraRig {
  if (mode === 'tps') return new ThirdPersonRig();
  if (mode === 'topdown') return new TopDownRig();
  return new FirstPersonRig();
}

/** The next mode in the cycle, for the runtime toggle. */
export function nextCameraMode(mode: CameraMode): CameraMode {
  return mode === 'fps' ? 'tps' : mode === 'tps' ? 'topdown' : 'fps';
}
