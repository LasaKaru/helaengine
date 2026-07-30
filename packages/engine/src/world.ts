import type * as THREE from 'three';
import type { BehaviorEntry, ObjectPhysics, PickupKind, Vec3 } from '@helaengine/schema';

/** What a pickup is offering. `weaponId` is empty for health, and for ammo means "the held gun". */
export interface PickupRequest {
  kind: PickupKind;
  weaponId: string;
  amount: number;
}

export interface SpawnRequest {
  assetId: string;
  position: Vec3;
  rotationY?: number;
  behaviors?: BehaviorEntry[];
  physics?: ObjectPhysics;
}

/**
 * What gameplay can ask of the world it is running in.
 *
 * The `GameObject` handle a behaviour gets covers "me and my node"; this covers everything that is
 * a property of the world rather than of one object — where the player is, whether anything is in
 * the way, and the two edits (spawn, destroy) that gameplay genuinely needs.
 *
 * It stays an interface, and a deliberately small one, because a behaviour written against it has
 * to run unchanged inside an exported project. Every method here is something an export can
 * actually provide; anything editor-shaped would break that the moment it were added.
 */
export interface WorldHandle {
  /** Feet position of the player character, or null when no character is being played. */
  playerPosition(): THREE.Vector3 | null;
  /** Current player health, or null when nothing is playing. */
  playerHealth(): number | null;
  /** Applies damage to the player. Ignored when nothing is playing. */
  damagePlayer(amount: number): void;

  /**
   * Offers the player an item.
   *
   * Returns whether it was taken. A medkit at full health and an ammo box for a weapon the player
   * is not carrying both return false, and the pickup stays in the world — the alternative is an
   * item that vanishes having done nothing, which players read as a bug because it is one.
   */
  collect(request: PickupRequest): boolean;

  /**
   * True when nothing solid stands between the two points.
   *
   * `ignoreObjectId` keeps an enemy's own collider from blocking its view of everything, which is
   * otherwise the first thing that happens.
   */
  lineOfSight(from: THREE.Vector3, to: THREE.Vector3, ignoreObjectId?: string): boolean;

  /** Ground height at a world X/Z, for keeping walkers on the terrain. */
  groundHeight(x: number, z: number): number;

  /**
   * Moves an object, through physics when it has a body there.
   *
   * Steering that wrote straight to `node.position` would slide enemies through walls the physics
   * world still believes they are outside of, so movement goes through here and the runtime picks
   * the right mechanism.
   */
  moveTo(objectId: string, position: THREE.Vector3): void;

  /** Adds an object to the running world. Returns its id, or null if it could not be created. */
  spawn(request: SpawnRequest): string | null;
  /** Removes an object from the running world. */
  destroy(objectId: string): void;

  emit(event: string, payload?: unknown): void;
}

/**
 * A world that does nothing.
 *
 * Behaviour unit tests, and any caller that runs behaviours without a full game runtime, get this
 * rather than an optional-chained `world?.` at forty call sites. A behaviour asking a question the
 * harness cannot answer gets a truthful "nothing there" instead of a crash.
 */
export const INERT_WORLD: WorldHandle = {
  playerPosition: () => null,
  playerHealth: () => null,
  damagePlayer: () => {},
  collect: () => false,
  lineOfSight: () => true,
  groundHeight: () => 0,
  moveTo: () => {},
  spawn: () => null,
  destroy: () => {},
  emit: () => {},
};
