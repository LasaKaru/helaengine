import { describe, expect, it, vi } from 'vitest';
import { SaveStateSchema, type SaveState } from '@helaengine/schema';
import { SaveStore, saveKey, type SaveStorage } from './SaveStore.js';

/** An in-memory `localStorage`, which is all the store needs and all a test should give it. */
function memoryStorage(seed: Record<string, string> = {}): SaveStorage & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed));
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function state(overrides: Partial<SaveState> = {}): SaveState {
  return SaveStateSchema.parse({
    version: 1,
    sceneId: 'scene_demo',
    savedAt: 1_700_000_000_000,
    checkpointPosition: [1, 0, 2],
    health: 60,
    ...overrides,
  });
}

describe('SaveStore', () => {
  it('round-trips a save', () => {
    const storage = memoryStorage();
    const store = new SaveStore({ sceneId: 'scene_demo', storage });

    expect(store.read()).toBeNull();
    expect(store.write(state({ checkpointId: 'obj_0003' }))).toBe(true);

    expect(store.read()).toMatchObject({ checkpointId: 'obj_0003', health: 60 });
    expect(storage.map.has(saveKey('scene_demo'))).toBe(true);
  });

  it('keeps one key per scene, so two games do not overwrite each other', () => {
    const storage = memoryStorage();
    new SaveStore({ sceneId: 'scene_a', storage }).write(state({ sceneId: 'scene_a', health: 10 }));
    new SaveStore({ sceneId: 'scene_b', storage }).write(state({ sceneId: 'scene_b', health: 90 }));

    expect(new SaveStore({ sceneId: 'scene_a', storage }).read()?.health).toBe(10);
    expect(new SaveStore({ sceneId: 'scene_b', storage }).read()?.health).toBe(90);
  });

  it('discards a save that is not valid JSON, rather than crashing on load', () => {
    // `localStorage` is a text field the player can edit. This is untrusted input.
    const warn = vi.fn();
    const storage = memoryStorage({ [saveKey('scene_demo')]: '{not json' });
    const store = new SaveStore({ sceneId: 'scene_demo', storage, warn });

    expect(store.read()).toBeNull();
    expect(warn).toHaveBeenCalled();
    // And it is thrown away, so the next load is not the same failure again.
    expect(storage.map.size).toBe(0);
  });

  it('discards a save that does not match the schema', () => {
    const warn = vi.fn();
    const storage = memoryStorage({
      [saveKey('scene_demo')]: JSON.stringify({ version: 1, health: 'lots' }),
    });

    expect(new SaveStore({ sceneId: 'scene_demo', storage, warn }).read()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('refuses a save that names a different scene', () => {
    // Somebody's copy-paste, not this player's progress. Respawning them at a checkpoint from
    // another level is worse than starting them over.
    const warn = vi.fn();
    const storage = memoryStorage({
      [saveKey('scene_demo')]: JSON.stringify(state({ sceneId: 'scene_other' })),
    });

    expect(new SaveStore({ sceneId: 'scene_demo', storage, warn }).read()).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('reports a refused write instead of failing the game', () => {
    const warn = vi.fn();
    const store = new SaveStore({
      sceneId: 'scene_demo',
      warn,
      storage: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {},
      },
    });

    expect(store.write(state())).toBe(false);
    expect(warn).toHaveBeenCalled();
  });

  it('works with no storage at all', () => {
    // A sandboxed iframe, or site data blocked. A game that would not start because the browser
    // declined to remember anything would be a poor trade.
    const store = new SaveStore({ sceneId: 'scene_demo', storage: null });

    expect(store.write(state())).toBe(true);
    expect(store.read()).toBeNull();
    expect(store.hasSave).toBe(false);
  });

  it('clears on demand', () => {
    const storage = memoryStorage();
    const store = new SaveStore({ sceneId: 'scene_demo', storage });
    store.write(state());

    store.clear();
    expect(store.read()).toBeNull();
  });
});

describe('SaveStateSchema', () => {
  it('rejects a save claiming a future format version', () => {
    expect(SaveStateSchema.safeParse({ ...state(), version: 2 }).success).toBe(false);
  });

  it('rejects negative ammo, which a hand-edited save is the only source of', () => {
    expect(
      SaveStateSchema.safeParse({
        ...state(),
        weapons: [{ weaponId: 'weapon_0001', clip: -5, reserve: 0 }],
      }).success,
    ).toBe(false);
  });
});
