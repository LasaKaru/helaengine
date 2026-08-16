import * as THREE from 'three';
import {
  RAGDOLL_MASS_SHARE,
  RAGDOLL_PARENT,
  boundParts,
  type Ragdoll as RagdollSettings,
  type RagdollPart,
} from '@helaengine/schema';
import type { PhysicsWorld, RapierRigidBody } from './PhysicsWorld.js';

interface Limb {
  part: RagdollPart;
  bone: THREE.Bone;
  body: RapierRigidBody;
  /**
   * Rotation that takes the body's frame back to the bone's.
   *
   * A capsule is built along its own +Y and then rotated to lie along the bone, so the body and the
   * bone do not share an orientation. Storing the difference at build time means the write-back is a
   * multiply rather than a re-derivation, and — more importantly — the difference is captured from
   * the pose the character actually died in rather than assumed.
   */
  offset: THREE.Quaternion;
  /** Where the bone's origin sits relative to the body's centre, in the body's frame. */
  originOffset: THREE.Vector3;
}

const worldPosition = new THREE.Vector3();
const worldQuaternion = new THREE.Quaternion();
const worldScale = new THREE.Vector3();
const childPosition = new THREE.Vector3();
const along = new THREE.Vector3();
const midpoint = new THREE.Vector3();
const parentInverse = new THREE.Matrix4();
const composed = new THREE.Matrix4();
const bodyQuaternion = new THREE.Quaternion();
const bodyPosition = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/** A limb's length: the distance to its first bound child, or a fraction of the parent's if it is a tip. */
function limbLength(bone: THREE.Bone, childBone: THREE.Bone | null): number {
  if (!childBone) return 0;
  bone.getWorldPosition(worldPosition);
  childBone.getWorldPosition(childPosition);
  return worldPosition.distanceTo(childPosition);
}

/**
 * A character skeleton, handed over to physics.
 *
 * Built from the pose the character is standing in at the moment it is created, so a body that dies
 * mid-stride falls from mid-stride. Once built, the relationship between bones and animation is
 * reversed: the animator no longer writes bones, the bodies do.
 *
 * ## Why the animator must be stopped first
 *
 * Not stopping it is the whole bug this class can have. A mixer writing a death clip onto the same
 * bones the solver is writing produces a corpse that twitches between two poses every frame, and it
 * looks like the physics is unstable rather than like two systems fighting.
 */
export class RagdollBody {
  readonly #world: PhysicsWorld;
  readonly #limbs: Limb[] = [];
  readonly objectId: string;
  #disposed = false;

  constructor(
    world: PhysicsWorld,
    objectId: string,
    root: THREE.Object3D,
    settings: RagdollSettings,
    velocity?: THREE.Vector3,
  ) {
    this.#world = world;
    this.objectId = objectId;

    const bones = new Map<string, THREE.Bone>();
    root.traverse((node) => {
      if ((node as THREE.Bone).isBone) bones.set(node.name, node as THREE.Bone);
    });

    const parts = boundParts(settings).filter((part) => bones.has(settings.bones[part]));
    const byPart = new Map<RagdollPart, THREE.Bone>();
    for (const part of parts) byPart.set(part, bones.get(settings.bones[part])!);

    /** The bound part that hangs directly off this one, for working out which way a limb points. */
    const childOf = new Map<RagdollPart, RagdollPart>();
    for (const part of parts) {
      const parent = RAGDOLL_PARENT[part];
      if (parent !== null && byPart.has(parent) && !childOf.has(parent)) childOf.set(parent, part);
    }

    for (const part of parts) {
      const bone = byPart.get(part)!;
      const childPart = childOf.get(part);
      const childBone = childPart ? byPart.get(childPart)! : null;

      // A tip limb — a head, a forearm — has no bound child to measure against, so it takes a share
      // of its own parent's length. Guessing a fixed size instead would make a child's head the same
      // size as an adult's.
      const measured = limbLength(bone, childBone);
      const length = measured > 1e-3 ? measured : 0.2;
      const radius = Math.max(length * settings.thickness, 0.02);

      bone.getWorldPosition(worldPosition);
      if (childBone) {
        childBone.getWorldPosition(childPosition);
        along.copy(childPosition).sub(worldPosition).normalize();
      } else {
        // No child to point at: inherit the bone's own axis, which for a head or a hand is the
        // direction the parent was already running in.
        bone.getWorldQuaternion(worldQuaternion);
        along.copy(UP).applyQuaternion(worldQuaternion).normalize();
      }

      // The capsule sits between the two joints rather than at the bone's origin — a body pinned at
      // the shoulder would swing an upper arm around a point at its end rather than through it.
      midpoint.copy(worldPosition).addScaledVector(along, length / 2);
      const orientation = new THREE.Quaternion().setFromUnitVectors(UP, along);

      const body = world.world.createRigidBody(
        world.rapier.RigidBodyDesc.dynamic()
          .setTranslation(midpoint.x, midpoint.y, midpoint.z)
          .setRotation({
            x: orientation.x,
            y: orientation.y,
            z: orientation.z,
            w: orientation.w,
          }),
      );

      const half = Math.max(length / 2 - radius, 0.01);
      const collider = world.rapier.ColliderDesc.capsule(half, radius);
      collider.setMass(settings.mass * RAGDOLL_MASS_SHARE[part]);
      world.world.createCollider(collider, body);

      if (velocity) {
        // Inherited so a sprinting enemy tumbles forward. A corpse that stops dead the instant it
        // dies reads as the animation having been switched off — which is exactly what happened,
        // and exactly what must not be visible.
        body.setLinvel(
          {
            x: velocity.x * settings.inheritVelocity,
            y: velocity.y * settings.inheritVelocity,
            z: velocity.z * settings.inheritVelocity,
          },
          true,
        );
      }

      bone.getWorldQuaternion(worldQuaternion);
      this.#limbs.push({
        part,
        bone,
        body,
        offset: orientation.clone().invert().multiply(worldQuaternion),
        originOffset: worldPosition
          .clone()
          .sub(midpoint)
          .applyQuaternion(orientation.clone().invert()),
      });
    }

    this.#joinLimbs(byPart);
  }

  get limbCount(): number {
    return this.#limbs.length;
  }

  /**
   * Writes body transforms back onto the bones.
   *
   * The reverse of what the animator did, and it has the same awkwardness `PhysicsWorld.syncToScene`
   * has with parented objects: the solver works in world space and a skeleton does not. Each bone's
   * world transform is converted back into its own parent's space, which is what lets a forearm keep
   * hanging off an upper arm that is itself being written every frame.
   */
  sync(): void {
    if (this.#disposed) return;

    for (const limb of this.#limbs) {
      const translation = limb.body.translation();
      const rotation = limb.body.rotation();
      bodyQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w);
      bodyPosition
        .copy(limb.originOffset)
        .applyQuaternion(bodyQuaternion)
        .add(new THREE.Vector3(translation.x, translation.y, translation.z));

      worldQuaternion.copy(bodyQuaternion).multiply(limb.offset);

      const parent = limb.bone.parent;
      if (parent) {
        parent.updateWorldMatrix(true, false);
        parentInverse.copy(parent.matrixWorld).invert();
        composed.compose(bodyPosition, worldQuaternion, limb.bone.scale).premultiply(parentInverse);
        composed.decompose(limb.bone.position, limb.bone.quaternion, worldScale);
      } else {
        limb.bone.position.copy(bodyPosition);
        limb.bone.quaternion.copy(worldQuaternion);
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const limb of this.#limbs) this.#world.world.removeRigidBody(limb.body);
    this.#limbs.length = 0;
  }

  /**
   * Ball joints from each limb to its parent, anchored at the shared bone origin.
   *
   * Ball rather than a cone-limited joint, which is what a production ragdoll uses to stop elbows
   * bending backwards. Rapier's spherical joint has no angular limit, and building one out of
   * generic joints is a project of its own — so the honest version is a rag doll that is genuinely
   * a rag, and a note saying so rather than a limit that half works.
   */
  #joinLimbs(byPart: ReadonlyMap<RagdollPart, THREE.Bone>): void {
    const bodyByPart = new Map(this.#limbs.map((limb) => [limb.part, limb]));

    for (const limb of this.#limbs) {
      const parentPart = RAGDOLL_PARENT[limb.part];
      if (parentPart === null) continue;
      const parent = bodyByPart.get(parentPart);
      if (!parent || !byPart.has(parentPart)) continue;

      // Anchored at the child bone's origin, expressed in each body's own frame — which is exactly
      // the point the two limbs share, and is why an elbow stays an elbow rather than drifting.
      limb.bone.getWorldPosition(worldPosition);

      const created = this.#world.world.createImpulseJoint(
        this.#world.rapier.JointData.spherical(
          this.#localAnchor(parent, worldPosition),
          this.#localAnchor(limb, worldPosition),
        ),
        parent.body,
        limb.body,
        true,
      );
      // Contacts off between joined limbs. Two capsules that share an endpoint overlap by
      // construction, and leaving contacts on makes the solver fight its own joint — the corpse
      // jitters, then throws itself across the level.
      // Rapier frees a body's joints with the body, so `dispose` removing the eleven rigid bodies
      // takes the ten joints with them — there is nothing separate to track.
      created.setContactsEnabled(false);
    }
  }

  /** A world point expressed in one limb body's own frame. */
  #localAnchor(limb: Limb, point: THREE.Vector3): { x: number; y: number; z: number } {
    const translation = limb.body.translation();
    const rotation = limb.body.rotation();
    bodyQuaternion.set(rotation.x, rotation.y, rotation.z, rotation.w).invert();
    const local = point
      .clone()
      .sub(new THREE.Vector3(translation.x, translation.y, translation.z))
      .applyQuaternion(bodyQuaternion);
    return { x: local.x, y: local.y, z: local.z };
  }
}
