import { safeParseSaveState, type SaveState } from '@helaengine/schema';

/**
 * The slice of `localStorage` this needs.
 *
 * An interface rather than a direct reference so the store is testable without a DOM and usable in
 * a host that has somewhere better to put a save — which is exactly what hosted play will be in
 * Sprint 27, with no change to anything that calls this.
 */
export interface SaveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SaveStoreOptions {
  sceneId: string;
  /** Defaults to `localStorage` when there is one, and to a no-op store when there is not. */
  storage?: SaveStorage | null;
  warn?: (message: string) => void;
}

/** A store that forgets everything, for a host with no persistence at all. */
const NULL_STORAGE: SaveStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};

function defaultStorage(): SaveStorage {
  // Accessing `localStorage` throws outright in a sandboxed iframe or with site data blocked, so
  // the guard is a try rather than a typeof check. A game that will not start because the browser
  // declined to remember anything would be a poor trade.
  try {
    if (typeof localStorage === 'undefined') return NULL_STORAGE;
    return localStorage;
  } catch {
    return NULL_STORAGE;
  }
}

/** One key per scene, so two games in one browser do not overwrite each other. */
export function saveKey(sceneId: string): string {
  return `helaengine:save:${sceneId}`;
}

/**
 * Where a player's progress lives.
 *
 * Everything read back goes through `SaveStateSchema` first. `localStorage` is a text field the
 * player can edit, so an exported game reading it is reading untrusted input in exactly the sense
 * the rest of this codebase means — and a save that does not parse is discarded rather than
 * half-applied. Starting fresh is a worse outcome than resuming and a far better one than a crash
 * on load.
 */
export class SaveStore {
  readonly #key: string;
  readonly #sceneId: string;
  readonly #storage: SaveStorage;
  readonly #warn: (message: string) => void;

  constructor(options: SaveStoreOptions) {
    this.#sceneId = options.sceneId;
    this.#key = saveKey(options.sceneId);
    this.#storage = options.storage === undefined ? defaultStorage() : (options.storage ?? NULL_STORAGE);
    this.#warn = options.warn ?? ((message) => console.warn(`[helaengine] ${message}`));
  }

  /** The stored save, or null when there is none, it is unreadable, or it is another scene's. */
  read(): SaveState | null {
    let raw: string | null;
    try {
      raw = this.#storage.getItem(this.#key);
    } catch {
      return null;
    }
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.#warn('saved progress was not valid JSON; starting fresh');
      this.clear();
      return null;
    }

    const result = safeParseSaveState(parsed);
    if (!result.success) {
      this.#warn(`saved progress did not match the save schema; starting fresh`);
      this.clear();
      return null;
    }

    // A save keyed under this scene but naming another one is somebody's copy-paste, not this
    // player's progress. Refusing it beats respawning them at a checkpoint from a different level.
    if (result.data.sceneId !== this.#sceneId) {
      this.#warn('saved progress belongs to a different scene; ignoring it');
      return null;
    }

    return result.data;
  }

  write(state: SaveState): boolean {
    try {
      this.#storage.setItem(this.#key, JSON.stringify(state));
      return true;
    } catch {
      // A full quota or a private-browsing store that refuses writes. Failing the save is correct;
      // failing the *game* because of it is not.
      this.#warn('could not save progress; the browser refused to store it');
      return false;
    }
  }

  clear(): void {
    try {
      this.#storage.removeItem(this.#key);
    } catch {
      // Nothing useful to do, and nothing depends on the removal having happened.
    }
  }

  get hasSave(): boolean {
    return this.read() !== null;
  }
}
