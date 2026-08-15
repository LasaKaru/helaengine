import type { Destructible, Vec3 } from '@helaengine/schema';
import { impactDamage } from '@helaengine/schema';

/**
 * Things that break, and what is left when they do.
 *
 * Driven entirely by the `damage` event the weapon system already emits — a destructible is one
 * more listener for a message that existed before it did, which is why shooting a crate needed no
 * change to weapons at all. Impact damage arrives the same way, from a contact the physics world
 * reports.
 *
 * Like `WeaponSystem`, the world arrives as callbacks rather than as a `PhysicsWorld`. That keeps
 * this testable without WASM and keeps the layering honest: breaking knows what a fragment *is*
 * without knowing what Rapier is.
 */

export interface FragmentRequest {
  assetId: string;
  position: Vec3;
  /** Metres per second, outward from the break. */
  velocity: Vec3;
  scale: number;
}

export interface DestructibleHooks {
  /** Where the thing is now, or null if it has already gone. */
  positionOf(objectId: string): Vec3 | null;
  /** Removes the broken object. */
  destroy(objectId: string): void;
  /** Places a replacement or a fragment; returns the new object's id, or null if it could not. */
  spawnDebris(request: FragmentRequest): string | null;
  emit(event: string, payload?: unknown): void;
  /** Deterministic in tests, random in play. Returns 0..1. */
  random?: () => number;
}

interface Tracked {
  destructible: Destructible;
  remaining: number;
}

/** A fragment waiting to be cleaned up. */
interface Expiring {
  objectId: string;
  secondsLeft: number;
}

export class DestructibleSystem {
  readonly #hooks: DestructibleHooks;
  readonly #random: () => number;
  readonly #tracked = new Map<string, Tracked>();
  readonly #expiring: Expiring[] = [];
  /**
   * Ids that have already broken.
   *
   * A shotgun fires several pellets in one frame and every one of them reports a hit. Without this,
   * the second pellet breaks an object that no longer exists — spawning a second set of fragments
   * from a position the object has already left.
   */
  readonly #broken = new Set<string>();

  constructor(hooks: DestructibleHooks) {
    this.#hooks = hooks;
    this.#random = hooks.random ?? Math.random;
  }

  get trackedCount(): number {
    return this.#tracked.size;
  }

  /** Fragments currently counting down to removal — what a leak test watches. */
  get pendingFragments(): number {
    return this.#expiring.length;
  }

  register(objectId: string, destructible: Destructible): void {
    this.#tracked.set(objectId, { destructible, remaining: destructible.hitPoints });
    this.#broken.delete(objectId);
  }

  forget(objectId: string): void {
    this.#tracked.delete(objectId);
    this.#broken.delete(objectId);
  }

  /** Damage still to be done before this breaks, or null if it is not a destructible. */
  remaining(objectId: string): number | null {
    return this.#tracked.get(objectId)?.remaining ?? null;
  }

  /**
   * Applies weapon damage. Returns true if this was the blow that broke it.
   *
   * A hit on something that is not a destructible is not an error — most of a level is not
   * breakable, and a weapon that had to ask first would have to know about every object in the
   * world.
   */
  damage(objectId: string, amount: number): boolean {
    return this.#apply(objectId, amount, 'weapons');
  }

  /** Applies a collision. `speed` is the closing speed in metres per second. */
  impact(objectId: string, speed: number): boolean {
    const tracked = this.#tracked.get(objectId);
    if (!tracked) return false;
    return this.#apply(objectId, impactDamage(tracked.destructible, speed), 'impact');
  }

  #apply(objectId: string, amount: number, source: 'weapons' | 'impact'): boolean {
    if (amount <= 0) return false;

    const tracked = this.#tracked.get(objectId);
    if (!tracked || this.#broken.has(objectId)) return false;
    if (!tracked.destructible.damagedBy.includes(source)) return false;

    tracked.remaining -= amount;
    if (tracked.remaining > 0) {
      this.#hooks.emit('destructibleDamaged', {
        objectId,
        amount,
        remaining: tracked.remaining,
      });
      return false;
    }

    this.#break(objectId, tracked.destructible);
    return true;
  }

  #break(objectId: string, destructible: Destructible): void {
    // Marked before anything else happens. `spawnDebris` and `destroy` both run arbitrary runtime
    // code that can emit, and an event handler that damages this same object again would otherwise
    // re-enter and break it twice.
    this.#broken.add(objectId);

    const position = this.#hooks.positionOf(objectId) ?? [0, 0, 0];

    // Read where it is *before* removing it: a destroyed object has no position, and fragments
    // spawned from the origin appear in the middle of the level rather than where the crate was.
    this.#hooks.destroy(objectId);
    this.#tracked.delete(objectId);

    if (destructible.effect === 'swap' && destructible.debrisAssetId !== '') {
      this.#hooks.spawnDebris({
        assetId: destructible.debrisAssetId,
        position,
        velocity: [0, 0, 0],
        scale: 1,
      });
    } else if (destructible.effect === 'fragments' && destructible.debrisAssetId !== '') {
      this.#scatter(position, destructible);
    }

    if (destructible.breakEvent !== '') {
      this.#hooks.emit(destructible.breakEvent, { objectId, position });
    }

    // Always, and after the author's own event. A level that renames its break event still gets the
    // sound, and anything watching every break — a score counter, an achievement — has one message
    // to listen for rather than one per crate.
    this.#hooks.emit('destructibleBroken', { objectId, position });
  }

  #scatter(position: Vec3, destructible: Destructible): void {
    for (let index = 0; index < destructible.fragmentCount; index += 1) {
      // Thrown outward and *upward*: a purely horizontal burst slides along the floor and reads as
      // a puddle rather than a break. The upward bias is what makes it look like something came
      // apart under pressure.
      const angle = (index / destructible.fragmentCount) * Math.PI * 2 + this.#random() * 0.6;
      const spread = 0.25 + this.#random() * 0.35;
      const direction: Vec3 = [
        Math.cos(angle) * spread,
        0.6 + this.#random() * 0.4,
        Math.sin(angle) * spread,
      ];

      const id = this.#hooks.spawnDebris({
        assetId: destructible.debrisAssetId,
        // Offset from the centre so the fragments do not all start inside one another, which makes
        // the solver push them apart explosively on the first step.
        position: [
          position[0] + direction[0],
          position[1] + 0.3 + this.#random() * 0.3,
          position[2] + direction[2],
        ],
        velocity: [
          direction[0] * destructible.fragmentSpeed,
          direction[1] * destructible.fragmentSpeed,
          direction[2] * destructible.fragmentSpeed,
        ],
        scale: destructible.fragmentScale,
      });

      if (id !== null && destructible.fragmentLifetime > 0) {
        this.#expiring.push({ objectId: id, secondsLeft: destructible.fragmentLifetime });
      }
    }
  }

  /**
   * Ages fragments out.
   *
   * Without this every break leaves rigid bodies in the world forever, and a level where the player
   * shoots a hundred crates ends up simulating five hundred pieces of wood nobody can see.
   */
  update(delta: number): void {
    for (let index = this.#expiring.length - 1; index >= 0; index -= 1) {
      const entry = this.#expiring[index]!;
      entry.secondsLeft -= delta;
      if (entry.secondsLeft > 0) continue;

      this.#hooks.destroy(entry.objectId);
      // Walking backwards, so a splice here cannot skip the next entry.
      this.#expiring.splice(index, 1);
    }
  }

  /** Drops every fragment immediately. Called when a scene is torn down. */
  clear(): void {
    for (const entry of this.#expiring) this.#hooks.destroy(entry.objectId);
    this.#expiring.length = 0;
    this.#tracked.clear();
    this.#broken.clear();
  }
}
