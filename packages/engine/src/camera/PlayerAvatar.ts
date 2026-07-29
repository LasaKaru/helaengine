import * as THREE from 'three';
import type { Player } from '@helaengine/schema';

export interface PlayerAvatar {
  node: THREE.Object3D;
  /** Places the body at the character's feet, facing its heading, and sizes it for crouch. */
  update(position: THREE.Vector3, yaw: number, crouched: boolean): void;
  dispose(): void;
}

/**
 * A stand-in body for the player.
 *
 * Third person needs something to look at, and until there is a rigged character model to load
 * (Sprint 37's asset library), a capsule matching the collider is the honest placeholder: it is
 * exactly the shape the physics world is using, so what the player sees is what they collide with.
 * The small nose is there for one reason — without it a capsule gives no clue which way it is
 * facing, and a third-person camera is unusable when you cannot tell where "forward" is.
 *
 * Hidden in first person, where the camera is inside it.
 */
export function createPlayerAvatar(player: Player): PlayerAvatar {
  const radius = player.radius;
  const cylinder = Math.max(player.height - radius * 2, 0.1);

  const geometry = new THREE.CapsuleGeometry(radius, cylinder, 6, 12);
  // Pivot at the feet, matching every other transform convention in the engine.
  geometry.translate(0, player.height / 2, 0);
  const material = new THREE.MeshStandardMaterial({ color: '#8fd694', roughness: 0.8 });

  const body = new THREE.Mesh(geometry, material);
  body.castShadow = true;

  const noseGeometry = new THREE.ConeGeometry(radius * 0.35, radius * 0.9, 8);
  noseGeometry.rotateX(-Math.PI / 2);
  const nose = new THREE.Mesh(noseGeometry, material);
  nose.position.set(0, player.height * 0.78, -radius * 0.9);

  const node = new THREE.Group();
  node.name = 'player-avatar';
  node.add(body, nose);

  return {
    node,
    update(position, yaw, crouched) {
      node.position.copy(position);
      node.rotation.y = yaw;
      // Squashing rather than rebuilding the mesh: the capsule's proportions are wrong while
      // crouched, but the alternative is reallocating geometry every time the player ducks.
      const squash = crouched ? player.crouchHeightRatio : 1;
      node.scale.set(1, squash, 1);
    },
    dispose() {
      node.removeFromParent();
      geometry.dispose();
      noseGeometry.dispose();
      material.dispose();
    },
  };
}
