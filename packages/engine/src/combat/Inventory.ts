import type { Inventory as InventoryConfig, Weapon } from '@helaengine/schema';

/** What the player is carrying of one weapon: the weapon itself, plus its two ammo pools. */
export interface CarriedWeapon {
  readonly weapon: Weapon;
  /** Rounds in the clip. Always 0 for a weapon whose `clipSize` is 0 — it never needs any. */
  clip: number;
  /** Rounds outside the clip. */
  reserve: number;
}

/**
 * What the player is carrying.
 *
 * Pure state and arithmetic, with no knowledge of rays, nodes or the DOM — which is what makes it
 * testable without a physics world and reusable by whatever ends up driving it (the local player
 * today, a networked one in Sprint 20).
 *
 * The catalogue is fixed at construction from the scene document. Nothing here can invent a weapon
 * that the document did not describe, so "what can the player possibly be holding" has an answer
 * that can be read off the file.
 */
export class Inventory {
  readonly #catalogue = new Map<string, Weapon>();
  readonly #carried: CarriedWeapon[] = [];
  readonly #maxCarried: number;
  #index = 0;

  constructor(config: InventoryConfig) {
    for (const weapon of config.weapons) this.#catalogue.set(weapon.id, weapon);
    this.#maxCarried = config.maxCarried;
    // Silently skipping unknown ids would be wrong, but the schema already rejects them, so by the
    // time a document reaches here every starting id names a real weapon.
    for (const id of config.startingWeaponIds) this.give(id);
    this.#index = 0;
  }

  /** Every weapon in the scene's catalogue, held or not — what an editor list wants. */
  get catalogue(): readonly Weapon[] {
    return [...this.#catalogue.values()];
  }

  get carried(): readonly CarriedWeapon[] {
    return this.#carried;
  }

  /** The equipped weapon, or null when the player is empty-handed. */
  get current(): CarriedWeapon | null {
    return this.#carried[this.#index] ?? null;
  }

  get currentIndex(): number {
    return this.#index;
  }

  /**
   * Rounds available to fire right now, or null when the weapon does not use ammo.
   *
   * Null rather than Infinity so a HUD can render "—" for a melee weapon instead of a number that
   * never moves, and so `ammo === 0` unambiguously means empty.
   */
  get ammo(): number | null {
    const current = this.current;
    if (!current || current.weapon.clipSize === 0) return null;
    return current.clip;
  }

  get reserve(): number {
    return this.current?.reserve ?? 0;
  }

  has(weaponId: string): boolean {
    return this.#carried.some((entry) => entry.weapon.id === weaponId);
  }

  weapon(weaponId: string): Weapon | undefined {
    return this.#catalogue.get(weaponId);
  }

  /**
   * Picks up a weapon.
   *
   * Already holding it tops up the reserve instead — the alternative is a crate the player walks
   * over forever with nothing happening, which reads as a broken pickup rather than a full one.
   * Returns false only when nothing changed, which is what tells a pickup to stay in the world.
   */
  give(weaponId: string): boolean {
    const weapon = this.#catalogue.get(weaponId);
    if (!weapon) return false;

    const held = this.#carried.find((entry) => entry.weapon.id === weaponId);
    if (held) return this.addAmmo(weaponId, weapon.reserveAmmo);

    const entry: CarriedWeapon = {
      weapon,
      clip: weapon.clipSize,
      reserve: weapon.reserveAmmo,
    };

    if (this.#carried.length >= this.#maxCarried) {
      // At capacity the new weapon replaces the held one rather than being refused: the player
      // deliberately walked into it, and "nothing happened" is never the reading they want.
      this.#carried[this.#index] = entry;
    } else {
      this.#carried.push(entry);
      this.#index = this.#carried.length - 1;
    }
    return true;
  }

  /**
   * Adds reserve ammo. An empty `weaponId` means the held weapon.
   *
   * Returns false when it would do nothing — an unheld weapon, or a full reserve — so an ammo box
   * the player cannot use stays put for when they can.
   */
  addAmmo(weaponId: string, amount: number): boolean {
    if (amount <= 0) return false;

    const entry = weaponId
      ? this.#carried.find((candidate) => candidate.weapon.id === weaponId)
      : this.current;
    if (!entry || entry.weapon.clipSize === 0) return false;

    // A weapon's own `reserveAmmo` doubles as the ceiling: it is already the answer to "how much of
    // this does the author think you should be able to carry".
    const ceiling = entry.weapon.reserveAmmo;
    if (entry.reserve >= ceiling) return false;

    entry.reserve = Math.min(ceiling, entry.reserve + amount);
    return true;
  }

  /** Equips a carried weapon by id. Returns false when it is not held. */
  select(weaponId: string): boolean {
    const at = this.#carried.findIndex((entry) => entry.weapon.id === weaponId);
    if (at < 0) return false;
    this.#index = at;
    return true;
  }

  /** Cycles to the next carried weapon. A no-op with fewer than two. */
  next(): CarriedWeapon | null {
    if (this.#carried.length < 2) return this.current;
    this.#index = (this.#index + 1) % this.#carried.length;
    return this.current;
  }

  /** Whether the held weapon has a shot in it. */
  get loaded(): boolean {
    const current = this.current;
    if (!current) return false;
    return current.weapon.clipSize === 0 || current.clip > 0;
  }

  /** Spends one round. Returns false when there was none to spend. */
  consume(): boolean {
    const current = this.current;
    if (!current) return false;
    if (current.weapon.clipSize === 0) return true;
    if (current.clip <= 0) return false;

    current.clip -= 1;
    return true;
  }

  /** Moves reserve into the clip. Returns the number of rounds moved, which may be zero. */
  reload(): number {
    const current = this.current;
    if (!current || current.weapon.clipSize === 0) return 0;

    const room = current.weapon.clipSize - current.clip;
    const moved = Math.min(room, current.reserve);
    current.clip += moved;
    current.reserve -= moved;
    return moved;
  }

  /** Whether a reload would do anything — what a "press R" prompt and the auto-reload both ask. */
  get canReload(): boolean {
    const current = this.current;
    if (!current || current.weapon.clipSize === 0) return false;
    return current.reserve > 0 && current.clip < current.weapon.clipSize;
  }
}
