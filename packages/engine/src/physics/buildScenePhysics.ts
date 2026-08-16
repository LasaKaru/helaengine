import * as THREE from 'three';
import type { ColliderType, Scene, SceneObject } from '@helaengine/schema';
import type { AssetResolver } from '../assets.js';
import type { LoadedScene } from '../SceneLoader.js';
import type { PhysicsWorld } from './PhysicsWorld.js';
import type { VehicleController } from './VehicleController.js';

export interface ScenePhysicsOptions {
  world: PhysicsWorld;
  scene: Scene;
  loaded: LoadedScene;
  resolver: AssetResolver;
}

export interface ScenePhysicsSkip {
  objectId: string;
  reason: string;
}

export interface BuiltVehicle {
  objectId: string;
  controller: VehicleController;
}

export interface ScenePhysicsReport {
  /** Bodies actually added to the world. */
  bodies: number;
  /** Objects that ended up with no collider, and why. */
  skipped: ScenePhysicsSkip[];
  terrain: boolean;
  /** Constraints actually created. */
  joints: number;
  /** Vehicles built, with their controllers, so the host can drive one. */
  vehicles: BuiltVehicle[];
  /** Joints that could not be built, and why. Same list the editor's panel warns about. */
  skippedJoints: ScenePhysicsSkip[];
}

const worldScale = new THREE.Vector3();

/** The collider a placement ends up with: its own choice, or the manifest's when it says `auto`. */
export function resolveColliderType(object: SceneObject, manifestType: ColliderType): ColliderType {
  return object.physics.collider === 'auto' ? manifestType : object.physics.collider;
}

/**
 * Populates a physics world from a scene document and the nodes the loader built for it.
 *
 * Deliberately a free function rather than a method on either side: the scene document knows what
 * should collide, the loaded scene knows where the nodes ended up, and the manifest knows how big
 * an asset is. Nothing owns all three, so the code that joins them belongs between them — and can
 * be called identically by the editor's preview and by an exported project's bootstrap.
 */
export function buildScenePhysics(options: ScenePhysicsOptions): ScenePhysicsReport {
  const { world, scene, loaded, resolver } = options;
  const skipped: ScenePhysicsSkip[] = [];
  let bodies = 0;

  const field = loaded.terrainField;
  if (field) world.addTerrain(field);

  for (const object of scene.objects) {
    const node = loaded.objects.get(object.id);
    if (!node) {
      skipped.push({ objectId: object.id, reason: 'no node was built for this object' });
      continue;
    }

    const entry = resolver.get(object.assetId);
    const shape = resolveColliderType(object, entry?.colliderType ?? 'box');
    if (shape === 'none') continue;

    // Three scales stack up before a collider knows how big to be: the asset's measured bounds,
    // the manifest's default scale for it, and whatever the user scaled this instance to.
    node.updateWorldMatrix(true, false);
    node.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), worldScale);

    const bounds = entry?.bounds ?? [1, 1, 1];
    const defaultScale = entry?.defaultScale ?? [1, 1, 1];
    const size: [number, number, number] = [
      Math.abs(bounds[0] * defaultScale[0] * worldScale.x),
      Math.abs(bounds[1] * defaultScale[1] * worldScale.y),
      Math.abs(bounds[2] * defaultScale[2] * worldScale.z),
    ];

    const added = world.addObject({
      objectId: object.id,
      node,
      shape,
      body: object.physics.body,
      size,
      mass: object.physics.mass,
    });

    if (added) bodies += 1;
    else skipped.push({ objectId: object.id, reason: `${shape} collider produced no shape` });
  }

  // Joints last, and only after every body exists. A joint names two objects and there is no order
  // that puts both of them before it — building them in the object loop would make a hinge work or
  // not depending on which end the author happened to place first.
  const skippedJoints: ScenePhysicsSkip[] = [];
  let joints = 0;
  for (const joint of scene.joints) {
    if (world.addJoint(joint)) joints += 1;
    else {
      skippedJoints.push({
        objectId: joint.id,
        reason: 'one end has no physics body — check for a "none" collider or a deleted object',
      });
    }
  }

  // Vehicles after the bodies too: a chassis needs its rigid body before a controller can be hung
  // off it, and a vehicle whose object had no collider is a car with nothing to push.
  const vehicles: BuiltVehicle[] = [];
  for (const object of scene.objects) {
    if (!object.vehicle) continue;
    const controller = world.createVehicle(object.id, object.vehicle);
    if (controller) vehicles.push({ objectId: object.id, controller });
    else {
      skipped.push({
        objectId: object.id,
        reason: 'a vehicle needs a Dynamic chassis with a collider',
      });
    }
  }

  return { bodies, skipped, terrain: field !== null, joints, skippedJoints, vehicles };
}
