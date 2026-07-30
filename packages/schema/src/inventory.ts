import { z } from 'zod';
import { IdSchema } from './primitives.js';

/**
 * A weapon the game knows about.
 *
 * Hitscan only, and deliberately so: a ray with a range and a damage number is the shape almost
 * every low-poly shooter actually needs, it costs one query per shot, and it is the thing an
 * exported project can reproduce exactly. Projectiles are a different simulation — travel time,
 * gravity, a body per bullet — and adding them as a `kind` field here would mean half this schema
 * quietly meaning nothing for one of the two options.
 *
 * The catalogue lives on the scene rather than on the objects that grant weapons, so a pistol is
 * described once and the nine crates that give you one all point at the same description.
 */
export const WeaponSchema = z.object({
  id: IdSchema,
  name: z.string().min(1).max(64).default('Weapon'),
  /** Damage per shot that lands. */
  damage: z.number().min(0).max(10_000).default(25),
  /** How far the shot reaches, in metres. Beyond this it hits nothing at all. */
  range: z.number().min(1).max(500).default(60),
  /** Seconds between shots. */
  fireInterval: z.number().min(0.02).max(10).default(0.25),
  /** Hold to keep firing, rather than one shot per click. */
  automatic: z.boolean().default(false),
  /**
   * Rounds per clip. Zero means the weapon never reloads and never runs out — which is what a
   * melee swing or a starter blaster wants, and is cleaner than a magic sentinel elsewhere.
   */
  clipSize: z.number().int().min(0).max(500).default(12),
  /** Rounds carried outside the clip when the weapon is first picked up. */
  reserveAmmo: z.number().int().min(0).max(9999).default(60),
  reloadSeconds: z.number().min(0).max(10).default(1.4),
  /** Random cone applied to each shot, in degrees. Zero is pinpoint. */
  spreadDegrees: z.number().min(0).max(45).default(0),
});
export type Weapon = z.infer<typeof WeaponSchema>;

/**
 * The scene's weapon catalogue and what the player starts with.
 *
 * `startingWeaponIds` is a list of ids rather than embedded weapons for the same reason `assetId`
 * is not a file path: one description, many references, and renaming or rebalancing a weapon is a
 * single edit rather than a search.
 */
export const InventorySchema = z
  .object({
    weapons: z.array(WeaponSchema).max(16).default([]),
    /** Weapons the player spawns holding. The first is equipped. */
    startingWeaponIds: z.array(IdSchema).max(16).default([]),
    /** How many weapons can be carried at once. Picking up past this swaps the held one. */
    maxCarried: z.number().int().min(1).max(16).default(4),
  })
  .superRefine((inventory, ctx) => {
    const known = new Set(inventory.weapons.map((weapon) => weapon.id));
    const seen = new Set<string>();

    for (const [index, weapon] of inventory.weapons.entries()) {
      if (seen.has(weapon.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['weapons', index, 'id'],
          message: `duplicate weapon id "${weapon.id}"`,
        });
      }
      seen.add(weapon.id);
    }

    // A starting weapon that is not in the catalogue would spawn the player holding nothing, with
    // no error anywhere — exactly the kind of silent-wrong the schema exists to prevent.
    for (const [index, id] of inventory.startingWeaponIds.entries()) {
      if (!known.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['startingWeaponIds', index],
          message: `no weapon is defined with id "${id}"`,
        });
      }
    }
  })
  .default({});
export type Inventory = z.infer<typeof InventorySchema>;

/** What a pickup gives the player. A closed set, like every other vocabulary in this schema. */
export const PickupKindSchema = z.enum(['weapon', 'ammo', 'health']);
export type PickupKind = z.infer<typeof PickupKindSchema>;
