import { MixerSettingsSchema, type MixerSettings } from '@helaengine/schema';
import type { SaveStorage } from '../save/SaveStore.js';

export const MIXER_KEY = 'helaengine:mixer';

const DEFAULTS: MixerSettings = { master: 1, music: 1, sfx: 1 };

/**
 * How loud this player likes things.
 *
 * Deliberately *not* in the scene document: how loud somebody likes their music is a property of
 * that person, not of the level, and writing it into `scene.json` would carry one player's
 * preference to everyone the project is exported to. One key for the whole engine rather than one
 * per scene, for the same reason — nobody wants to set their volume again per level.
 *
 * Validated on read like every other stored blob. A tampered value is discarded rather than
 * producing a volume of 40, which is not a quiet bug.
 */
export class MixerStore {
  readonly #storage: SaveStorage | null;

  constructor(storage?: SaveStorage | null) {
    if (storage !== undefined) {
      this.#storage = storage;
      return;
    }
    try {
      this.#storage = typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      this.#storage = null;
    }
  }

  read(): MixerSettings {
    try {
      const raw = this.#storage?.getItem(MIXER_KEY);
      if (!raw) return { ...DEFAULTS };

      const result = MixerSettingsSchema.safeParse(JSON.parse(raw));
      return result.success ? result.data : { ...DEFAULTS };
    } catch {
      return { ...DEFAULTS };
    }
  }

  write(settings: MixerSettings): void {
    try {
      this.#storage?.setItem(MIXER_KEY, JSON.stringify(settings));
    } catch {
      // A refused write costs the player their preference next session, and nothing else.
    }
  }
}
