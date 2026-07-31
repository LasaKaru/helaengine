import * as THREE from 'three';
import type { Unlockable, UnlockAction, UnlockKey } from '@helaengine/schema';
import type { EventBus } from '../TriggerRuntime.js';
import type { WorldHandle } from '../world.js';
import { createDetector, type UnlockDetector } from './detectors.js';

export interface UnlockRuntimeOptions {
  unlockables: readonly Unlockable[];
  world: WorldHandle;
  bus: EventBus;
}

interface Entry {
  unlockable: Unlockable;
  detector: UnlockDetector;
  unlocked: boolean;
}

const target = new THREE.Vector3();

/**
 * Secrets, as data.
 *
 * The whole point of this class is what it *cannot* do. A document names one of four ways a secret
 * is found and one of four things that happens when it is, and this turns those names into work.
 * There is no expression to evaluate, no snippet to run and no callback to look up by string — so
 * an exported project cannot be made to do something its author did not put in the file. That is
 * the same guarantee behaviours and trigger actions give, arrived at the same way, and it is worth
 * repeating rather than weakening for the one feature whose whole appeal is being sneaky.
 *
 * Kept separate from `TriggerRuntime` because a secret is not a place: an input sequence has no
 * position at all, and folding the two together would mean every secret needing a volume it does
 * not use.
 */
export class UnlockRuntime {
  readonly #entries: Entry[] = [];
  readonly #world: WorldHandle;
  readonly #bus: EventBus;
  readonly #unsubscribes: Array<() => void> = [];
  /** Objects hidden at startup because something reveals them, so stopping can put them back. */
  readonly #hidden = new Set<string>();
  #elapsed = 0;
  #started = false;

  constructor(options: UnlockRuntimeOptions) {
    this.#world = options.world;
    this.#bus = options.bus;

    for (const unlockable of options.unlockables) {
      this.#entries.push({
        unlockable,
        detector: createDetector(unlockable.unlockMethod),
        unlocked: false,
      });
    }
  }

  get count(): number {
    return this.#entries.length;
  }

  /** Ids of the secrets found so far — what a HUD counter and the save system both want. */
  get unlockedIds(): string[] {
    return this.#entries.filter((entry) => entry.unlocked).map((entry) => entry.unlockable.id);
  }

  /**
   * Marks secrets as already found, from a save.
   *
   * The actions are *not* re-run: a teleport on load would drop the player somewhere they did not
   * ask to be, and a weapon grant is already in the restored inventory. Only `revealArea` has a
   * lasting world effect, and that is applied directly so a revealed area stays revealed.
   */
  restore(unlockedIds: readonly string[]): void {
    const found = new Set(unlockedIds);

    for (const entry of this.#entries) {
      if (!found.has(entry.unlockable.id)) continue;
      entry.unlocked = true;

      for (const action of entry.unlockable.actions) {
        if (action.type !== 'revealArea') continue;
        for (const objectId of action.objectIds) {
          this.#world.setObjectHidden(objectId, false);
          this.#hidden.delete(objectId);
        }
      }
    }
  }

  isUnlocked(id: string): boolean {
    return this.#entries.some((entry) => entry.unlockable.id === id && entry.unlocked);
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#elapsed = 0;

    // Anything a `revealArea` names starts hidden. Deriving it from the action rather than from a
    // separate flag on the object means the two can never disagree about what is secret.
    for (const entry of this.#entries) {
      for (const action of entry.unlockable.actions) {
        if (action.type !== 'revealArea') continue;
        for (const objectId of action.objectIds) {
          if (this.#world.setObjectHidden(objectId, true)) this.#hidden.add(objectId);
        }
      }
    }

    // One subscription for the lot rather than one per detector: every detector is asked about
    // every event anyway, and a wildcard listener is not something the bus offers.
    this.#unsubscribes.push(
      this.#bus.onAny((event, payload) => {
        for (const entry of this.#entries) {
          if (this.#skip(entry)) continue;
          if (entry.detector.onEvent?.(event, payload) === true) this.#fire(entry);
        }
      }),
    );
  }

  /** One frame. `keys` are the named buttons pressed since the last call. */
  update(deltaSeconds: number, keys: readonly UnlockKey[] = []): void {
    if (!this.#started) return;
    this.#elapsed += deltaSeconds;
    if (keys.length === 0) return;

    for (const entry of this.#entries) {
      if (this.#skip(entry)) continue;
      if (entry.detector.onKeys?.(keys, this.#elapsed) === true) this.#fire(entry);
    }
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;

    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.length = 0;

    // Everything the preview hid comes back. Play Preview is a rehearsal, and a rehearsal that left
    // half a level invisible would be quietly editing the scene.
    for (const objectId of this.#hidden) this.#world.setObjectHidden(objectId, false);
    this.#hidden.clear();

    for (const entry of this.#entries) {
      entry.unlocked = false;
      entry.detector.reset();
    }
  }

  #skip(entry: Entry): boolean {
    return entry.unlocked && entry.unlockable.once;
  }

  #fire(entry: Entry): void {
    entry.unlocked = true;
    if (!entry.unlockable.once) entry.detector.reset();

    for (const action of entry.unlockable.actions) this.#apply(action);

    // Announced after the actions have run, so anything listening — a HUD notice, a sound — sees a
    // world in which the secret has already happened.
    this.#bus.emit('secretUnlocked', {
      unlockableId: entry.unlockable.id,
      label: entry.unlockable.label,
    });
  }

  /**
   * Does one action.
   *
   * Exhaustive, like the detector factory: adding an action to the schema without handling it here
   * is a compile error rather than a secret that silently does nothing.
   */
  #apply(action: UnlockAction): void {
    switch (action.type) {
      case 'teleportPlayer':
        target.set(action.target[0], action.target[1], action.target[2]);
        this.#world.teleportPlayer(target);
        return;
      case 'unlockInventoryItem':
        // The same door a pickup goes through, so a secret weapon arrives with its ammo and obeys
        // the carry limit exactly as a crate's would.
        this.#world.collect({ kind: 'weapon', weaponId: action.weaponId, amount: 0 });
        return;
      case 'revealArea':
        for (const objectId of action.objectIds) {
          this.#world.setObjectHidden(objectId, false);
          this.#hidden.delete(objectId);
        }
        return;
      case 'emit':
        this.#world.emit(action.event, { ...action.payload });
        return;
    }
  }
}
