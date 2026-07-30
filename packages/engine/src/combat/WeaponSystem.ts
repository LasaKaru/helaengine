import * as THREE from 'three';
import type { Inventory } from './Inventory.js';

/** One frame of combat intent, in the same shape `MoveInput` takes for the feet. */
export interface WeaponInput {
  /** Trigger held. Only automatic weapons care. */
  fire: boolean;
  /** Trigger pulled this frame. What a semi-automatic weapon fires on. */
  firePressed: boolean;
  reload: boolean;
  nextWeapon: boolean;
  /** Where the shot starts — the camera, in practice. */
  origin: THREE.Vector3;
  /** Unit vector the shot travels along. */
  direction: THREE.Vector3;
}

/** What a shot found. `objectId` is null for terrain and anything with no scene object behind it. */
export interface ShotHit {
  objectId: string | null;
  distance: number;
  point: THREE.Vector3;
}

export interface WeaponSystemOptions {
  inventory: Inventory;
  /** Traces a shot. Supplied by the host so this class never imports a physics world. */
  cast(origin: THREE.Vector3, direction: THREE.Vector3, range: number): ShotHit | null;
  /** Raises a named event on the game's bus. */
  emit(event: string, payload?: unknown): void;
  /** Deterministic in tests, random in play: the spread cone's two samples in -1..1. */
  random?: () => number;
}

const aim = new THREE.Vector3();
const right = new THREE.Vector3();
const up = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const DEG2RAD = Math.PI / 180;

/**
 * Firing, reloading and switching — everything that happens between "the player pulled the trigger"
 * and "something took damage".
 *
 * Damage leaves through the event bus as a `damage` event with a `targetId`, which is the same
 * message an enemy already answers to and the same one a trigger can raise. Nothing here reaches
 * into an enemy behaviour, so a weapon works against anything that listens — including things this
 * class has never heard of.
 *
 * Ray casting arrives as a callback rather than a `PhysicsWorld` for the boring but important
 * reason that it keeps combat testable without WASM, and keeps `/packages/engine`'s layering
 * honest: physics knows nothing about weapons and weapons know nothing about Rapier.
 */
export class WeaponSystem {
  readonly #inventory: Inventory;
  readonly #cast: WeaponSystemOptions['cast'];
  readonly #emit: WeaponSystemOptions['emit'];
  readonly #random: () => number;

  /** Seconds until the weapon can fire again. */
  #cooldown = 0;
  /** Seconds left of a reload in progress, or 0. */
  #reloading = 0;
  #shotsFired = 0;

  constructor(options: WeaponSystemOptions) {
    this.#inventory = options.inventory;
    this.#cast = options.cast;
    this.#emit = options.emit;
    this.#random = options.random ?? Math.random;
  }

  get inventory(): Inventory {
    return this.#inventory;
  }

  get reloading(): boolean {
    return this.#reloading > 0;
  }

  /** Total shots taken since the runtime started, for tests and a future accuracy readout. */
  get shotsFired(): number {
    return this.#shotsFired;
  }

  update(deltaSeconds: number, input: WeaponInput): void {
    this.#cooldown = Math.max(0, this.#cooldown - deltaSeconds);

    if (this.#reloading > 0) {
      this.#reloading = Math.max(0, this.#reloading - deltaSeconds);
      if (this.#reloading === 0) this.#finishReload();
      return;
    }

    if (input.nextWeapon) {
      const next = this.#inventory.next();
      // Switching cancels the shot queued for this frame, which is what a player who pressed both
      // in the same frame meant: they wanted the other gun.
      if (next) {
        this.#cooldown = Math.max(this.#cooldown, next.weapon.fireInterval);
        this.#emit('weaponSwitched', { weaponId: next.weapon.id });
      }
      return;
    }

    if (input.reload && this.#inventory.canReload) {
      this.#beginReload();
      return;
    }

    const current = this.#inventory.current;
    if (!current) return;

    const wantsToFire = current.weapon.automatic ? input.fire : input.firePressed;
    if (!wantsToFire || this.#cooldown > 0) return;

    if (!this.#inventory.loaded) {
      this.#emit('weaponEmpty', { weaponId: current.weapon.id });
      // Reloading on a dry trigger rather than making the player press R is the behaviour every
      // shooter has settled on, and the alternative is a gun that appears to be broken.
      if (this.#inventory.canReload) this.#beginReload();
      else this.#cooldown = current.weapon.fireInterval;
      return;
    }

    this.#fire(input);
  }

  /** Starts a reload immediately, for a UI button or a scripted moment. */
  beginReload(): boolean {
    if (this.#reloading > 0 || !this.#inventory.canReload) return false;
    this.#beginReload();
    return true;
  }

  #beginReload(): void {
    const current = this.#inventory.current;
    if (!current) return;

    this.#emit('weaponReloading', { weaponId: current.weapon.id });
    if (current.weapon.reloadSeconds === 0) {
      this.#finishReload();
      return;
    }
    this.#reloading = current.weapon.reloadSeconds;
  }

  #finishReload(): void {
    const moved = this.#inventory.reload();
    const current = this.#inventory.current;
    if (current) {
      this.#emit('weaponReloaded', { weaponId: current.weapon.id, rounds: moved });
    }
  }

  #fire(input: WeaponInput): void {
    const current = this.#inventory.current;
    if (!current || !this.#inventory.consume()) return;

    const { weapon } = current;
    this.#cooldown = weapon.fireInterval;
    this.#shotsFired += 1;

    aim.copy(input.direction).normalize();
    if (weapon.spreadDegrees > 0) this.#applySpread(weapon.spreadDegrees);

    this.#emit('weaponFired', {
      weaponId: weapon.id,
      ammo: this.#inventory.ammo,
      origin: input.origin.toArray(),
      direction: aim.toArray(),
    });

    const hit = this.#cast(input.origin, aim, weapon.range);
    if (!hit) return;

    this.#emit('weaponHit', {
      weaponId: weapon.id,
      objectId: hit.objectId,
      point: hit.point.toArray(),
      distance: hit.distance,
    });

    // A hit on the terrain is still a hit; it just has nothing to damage.
    if (hit.objectId === null) return;
    this.#emit('damage', {
      targetId: hit.objectId,
      amount: weapon.damage,
      source: 'player',
      weaponId: weapon.id,
    });
  }

  /**
   * Nudges `aim` inside a cone.
   *
   * Two perpendicular offsets rather than a rotation about a random axis: it is the same
   * distribution to within the small-angle approximation these cones live in, and it needs no
   * quaternion per shot.
   */
  #applySpread(degrees: number): void {
    // Any vector not parallel to the aim will do for the first cross product; world up only fails
    // when shooting straight up or down, which the fallback covers.
    right.crossVectors(aim, WORLD_UP);
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    right.normalize();
    up.crossVectors(right, aim).normalize();

    const radians = degrees * DEG2RAD;
    aim
      .addScaledVector(right, (this.#random() * 2 - 1) * radians)
      .addScaledVector(up, (this.#random() * 2 - 1) * radians)
      .normalize();
  }
}
