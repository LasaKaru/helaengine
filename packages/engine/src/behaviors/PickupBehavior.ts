import * as THREE from 'three';
import { z } from 'zod';
import { PickupKindSchema } from '@helaengine/schema';
import type { Behavior, BehaviorDefinition, GameObject } from './Behavior.js';

export const PickupParamsSchema = z.object({
  kind: PickupKindSchema.default('health'),
  /**
   * Which weapon this grants, or which weapon the ammo is for.
   *
   * Empty for a health pickup, and for ammo it means "whatever is held" — an ammo box that works
   * with the gun you brought is usually what a level designer wants, and naming a weapon is the
   * exception rather than the rule.
   */
  weaponId: z.string().max(128).default(''),
  /** Rounds, or points of health. Ignored for a weapon, which brings its own reserve. */
  amount: z.number().min(0).max(9999).default(25),
  /** How close the player has to get, in metres. */
  radius: z.number().min(0.2).max(20).default(1.5),
  /**
   * Seconds before it comes back. Zero means gone for good.
   *
   * Hidden rather than destroyed while it waits, because a respawning pickup that went through
   * spawn/destroy would churn a scene node several times a minute for no visible difference.
   */
  respawnSeconds: z.number().min(0).max(600).default(0),
  /**
   * Named sound event raised on collection.
   *
   * A name, never a path and never a snippet: Sprint 19's audio system maps names to clips, so a
   * document says *what happened* and the runtime decides what that sounds like.
   */
  sfxEvent: z.string().max(64).default('pickup'),
  /** Spin it, so it reads as something to walk into rather than scenery. */
  spin: z.boolean().default(true),
});

export type PickupParams = z.infer<typeof PickupParamsSchema>;

/** Radians per second for a spinning pickup. Fast enough to catch the eye, slow enough to read. */
const SPIN_RATE = 1.8;

/** How far above its feet a pickup counts as "reached", so a floating crate is still collectable. */
const VERTICAL_TOLERANCE = 1.5;

const toPlayer = new THREE.Vector3();

/**
 * Something the player walks into and gains.
 *
 * The interesting decision here is that it asks the world to take the item and does what the answer
 * says: a medkit at full health, or an ammo box for a gun the player is not carrying, returns false
 * and the pickup stays exactly where it is. The alternative — swallowing the item and giving
 * nothing — is the single most annoying bug this kind of behaviour has.
 */
export class PickupBehavior implements Behavior {
  readonly #params: PickupParams;
  #collected = false;
  #respawnIn = 0;

  constructor(params: PickupParams) {
    this.#params = params;
  }

  get collected(): boolean {
    return this.#collected;
  }

  onUpdate(object: GameObject, deltaSeconds: number): void {
    if (this.#collected) {
      if (this.#params.respawnSeconds === 0) return;

      this.#respawnIn -= deltaSeconds;
      if (this.#respawnIn > 0) return;

      this.#collected = false;
      object.node.visible = true;
      object.emit('itemRespawned', { objectId: object.id, kind: this.#params.kind });
      return;
    }

    if (this.#params.spin) object.node.rotation.y += SPIN_RATE * deltaSeconds;

    const player = object.world.playerPosition();
    if (!player) return;

    toPlayer.copy(player).sub(object.node.position);
    if (Math.abs(toPlayer.y) > VERTICAL_TOLERANCE) return;
    // Horizontal distance: a pickup on the ground should not need the player to be at the same
    // height as it, only standing on it.
    toPlayer.y = 0;
    if (toPlayer.lengthSq() > this.#params.radius * this.#params.radius) return;

    const taken = object.world.collect({
      kind: this.#params.kind,
      weaponId: this.#params.weaponId,
      amount: this.#params.amount,
    });
    if (!taken) return;

    object.emit(this.#params.sfxEvent, { objectId: object.id, kind: this.#params.kind });
    object.emit('itemPickedUp', {
      objectId: object.id,
      kind: this.#params.kind,
      weaponId: this.#params.weaponId,
      amount: this.#params.amount,
    });

    if (this.#params.respawnSeconds === 0) {
      object.world.destroy(object.id);
      return;
    }

    this.#collected = true;
    this.#respawnIn = this.#params.respawnSeconds;
    object.node.visible = false;
  }

  onDestroy(object: GameObject): void {
    // A pickup that was hidden when the preview stopped must not come back invisible.
    object.node.visible = true;
  }
}

export const pickupDefinition: BehaviorDefinition<typeof PickupParamsSchema> = {
  type: 'pickup',
  label: 'Pickup',
  description:
    'Gives the player a weapon, ammo or health when they walk into it. Stays put if it would give nothing.',
  params: PickupParamsSchema,
  create: (params) => new PickupBehavior(params),
};
