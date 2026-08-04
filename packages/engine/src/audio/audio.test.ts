import { describe, expect, it, vi } from 'vitest';
import { AudioConfigSchema, MusicSchema, type AudioConfigInput } from '@helaengine/schema';
import type { EventBus } from '../TriggerRuntime.js';
import { MusicPlayer, type MusicTrack } from './MusicPlayer.js';
import { AudioSystem, type SfxVoice } from './AudioSystem.js';
import { MixerStore, MIXER_KEY } from './MixerStore.js';
import type { SaveStorage } from '../save/SaveStore.js';

/** A track that records what was asked of it. No sound card involved, which is the point. */
function fakeTrack(log: string[], name: string): MusicTrack & { level: number; live: boolean } {
  const track = {
    level: 0,
    live: false,
    play() {
      track.live = true;
      log.push(`play ${name}`);
    },
    stop() {
      track.live = false;
      log.push(`stop ${name}`);
    },
    volume(level: number) {
      track.level = level;
      log.push(`volume ${name} ${level.toFixed(2)}`);
    },
    fade(from: number, to: number, ms: number) {
      track.level = to;
      log.push(`fade ${name} ${from.toFixed(2)}->${to.toFixed(2)} ${ms}ms`);
    },
    unload() {
      log.push(`unload ${name}`);
    },
    playing: () => track.live,
  };
  return track;
}

function makeBus(): EventBus {
  const named = new Map<string, Set<(payload: unknown) => void>>();
  const any = new Set<(event: string, payload: unknown) => void>();
  return {
    emit(event, payload) {
      for (const listener of [...(named.get(event) ?? [])]) listener(payload);
      for (const listener of [...any]) listener(event, payload);
    },
    on(event, listener) {
      const set = named.get(event) ?? new Set();
      set.add(listener);
      named.set(event, set);
      return () => set.delete(listener);
    },
    onAny(listener) {
      any.add(listener);
      return () => any.delete(listener);
    },
  };
}

const TRACKS = {
  menuTrackAssetId: 'audio_music_menu',
  exploreTrackAssetId: 'audio_music_explore',
  combatTrackAssetId: 'audio_music_combat',
};

describe('MusicPlayer', () => {
  function rig(overrides: Record<string, unknown> = {}) {
    const log: string[] = [];
    const created: string[] = [];
    const player = new MusicPlayer({
      config: MusicSchema.parse({ ...TRACKS, ...overrides }),
      resolve: (assetId) => (assetId.startsWith('audio_') ? `/assets/${assetId}.wav` : null),
      create: (url) => {
        created.push(url);
        return fakeTrack(log, url.split('/').pop()!.replace('.wav', ''));
      },
    });
    return { player, log, created };
  }

  it('starts a track silent and fades it up', () => {
    const { player, log } = rig();
    player.setVolume(0.8);
    player.setState('menu');

    expect(player.state).toBe('menu');
    // Silent, then playing, then rising. Starting at full volume would be a stab rather than a fade.
    expect(log).toEqual([
      'volume audio_music_menu 0.00',
      'play audio_music_menu',
      'fade audio_music_menu 0.00->0.80 1500ms',
    ]);
  });

  it('crossfades: the old one falls while the new one rises', () => {
    const { player, log } = rig();
    player.setState('explore');
    log.length = 0;

    player.setState('combat');

    expect(log).toContain('fade audio_music_explore 1.00->0.00 1500ms');
    expect(log).toContain('fade audio_music_combat 0.00->1.00 1500ms');
    expect(player.state).toBe('combat');
  });

  it('cuts rather than fades when the crossfade is zero', () => {
    const { player, log } = rig({ crossfadeSeconds: 0 });
    player.setState('explore');
    log.length = 0;

    player.setState('combat');
    expect(log.filter((entry) => entry.startsWith('fade'))).toEqual([]);
    expect(log).toContain('stop audio_music_explore');
  });

  it('does nothing when asked for the state already playing', () => {
    const { player, log } = rig();
    player.setState('explore');
    log.length = 0;

    player.setState('explore');
    expect(log).toEqual([]);
  });

  it('falls silent rather than keeping the wrong track for a state with no music', () => {
    // Exploration music continuing through a boss fight is worse than no music at all.
    const { player, log } = rig({ combatTrackAssetId: null });
    player.setState('explore');
    log.length = 0;

    player.setState('combat');
    expect(player.state).toBeNull();
    expect(log).toContain('fade audio_music_explore 1.00->0.00 1500ms');
  });

  it('applies a volume change to what is already playing', () => {
    // A slider that only takes effect at the next transition is a slider that appears broken.
    const { player, log } = rig();
    player.setState('explore');
    log.length = 0;

    player.setVolume(0.25);
    expect(log).toEqual(['volume audio_music_explore 0.25']);
  });

  it('stops the previous track when a second change arrives mid-fade', () => {
    // Otherwise it fades forever with nobody holding a reference to stop it.
    const { player, log } = rig();
    player.setState('explore');
    player.setState('combat');
    log.length = 0;

    player.setState('menu');
    expect(log).toContain('stop audio_music_explore');
    expect(log).toContain('unload audio_music_explore');
  });

  it('frees everything on dispose', () => {
    const { player, log } = rig();
    player.setState('explore');
    log.length = 0;

    player.dispose();
    expect(log).toEqual(['stop audio_music_explore', 'unload audio_music_explore']);
    expect(player.state).toBeNull();
  });
});

describe('AudioSystem', () => {
  function rig(config: AudioConfigInput = {}, options: { now?: () => number } = {}) {
    const bus = makeBus();
    const played: Array<{ url: string; at: [number, number, number] | null }> = [];
    const musicLog: string[] = [];

    const system = new AudioSystem({
      config: AudioConfigSchema.parse(config),
      bus,
      resolve: (assetId) => (assetId.startsWith('audio_') ? `/assets/${assetId}.wav` : null),
      locate: (objectId) => (objectId === 'obj_0001' ? ({ x: 3, y: 0, z: -4 } as never) : null),
      createMusic: (url) => fakeTrack(musicLog, url.split('/').pop()!.replace('.wav', '')),
      createSfx: (url) => {
        const entry: { url: string; at: [number, number, number] | null } = { url, at: null };
        const voice: SfxVoice = {
          play: () => played.push(entry),
          volume: () => {},
          pos: (x, y, z) => {
            entry.at = [x, y, z];
          },
          unload: () => {},
        };
        return voice;
      },
      ...(options.now ? { now: options.now } : {}),
    });

    return { system, bus, played, musicLog };
  }

  const PICKUP = { sfx: [{ event: 'pickup', assetId: 'audio_sfx_pickup' }] };

  it('plays a bound sound when the event it names reaches the bus', () => {
    // No gameplay code knows this makes a noise: the pickup behaviour already raised the event.
    const { system, bus, played } = rig(PICKUP);
    system.start();

    bus.emit('pickup', { objectId: 'obj_0001' });
    expect(played.map((entry) => entry.url)).toEqual(['/assets/audio_sfx_pickup.wav']);
  });

  it('ignores events nothing is bound to', () => {
    const { system, bus, played } = rig(PICKUP);
    system.start();

    bus.emit('somethingElse', {});
    expect(played).toEqual([]);
  });

  it('places a positional sound at the object that raised it', () => {
    const { system, bus, played } = rig({
      sfx: [{ event: 'enemyDied', assetId: 'audio_sfx_death', positional: true }],
    });
    system.start();

    bus.emit('enemyDied', { objectId: 'obj_0001' });
    expect(played[0]?.at).toEqual([3, 0, -4]);
  });

  it('plays a positional sound flat when the object cannot be found', () => {
    // Truthful: a sound with no location should not be placed at the origin, where it would come
    // from a corner of the map for no reason.
    const { system, bus, played } = rig({
      sfx: [{ event: 'enemyDied', assetId: 'audio_sfx_death', positional: true }],
    });
    system.start();

    bus.emit('enemyDied', { objectId: 'obj_missing' });
    expect(played).toHaveLength(1);
    expect(played[0]?.at).toBeNull();
  });

  it('stays silent for a clip the project does not ship, rather than throwing', () => {
    // An author mid-edit should not have their preview stop working.
    const { system, bus, played } = rig({ sfx: [{ event: 'pickup', assetId: 'not_ingested' }] });
    system.start();

    expect(() => bus.emit('pickup', {})).not.toThrow();
    expect(played).toEqual([]);
  });

  it('rate-limits a binding, because twenty identical samples at once is one loud click', () => {
    let clock = 0;
    const { system, bus, played } = rig(
      { sfx: [{ event: 'enemyDied', assetId: 'audio_sfx_death', maxPerSecond: 3 }] },
      { now: () => clock },
    );
    system.start();

    for (let index = 0; index < 20; index += 1) bus.emit('enemyDied', {});
    expect(played).toHaveLength(3);

    // A second later the window resets.
    clock = 1200;
    bus.emit('enemyDied', {});
    expect(played).toHaveLength(4);
  });

  it('enters combat on a fight and leaves after the hold expires', () => {
    const { system, bus } = rig({ music: { ...TRACKS, combatHoldSeconds: 5 } });
    system.start();
    system.update(0.1);
    expect(system.music.state).toBe('explore');

    bus.emit('enemyAlerted', {});
    system.update(0.1);
    expect(system.inCombat).toBe(true);
    expect(system.music.state).toBe('combat');

    // Still in combat four seconds later: the hold is what stops the track flickering every time
    // an enemy blinks.
    system.update(4);
    expect(system.music.state).toBe('combat');

    system.update(2);
    expect(system.inCombat).toBe(false);
    expect(system.music.state).toBe('explore');
  });

  it('plays menu music when the host says a menu is up, and holds the fight', () => {
    const { system, bus } = rig({ music: { ...TRACKS, combatHoldSeconds: 5 } });
    system.start();
    bus.emit('enemyAlerted', {});
    system.update(0.1);

    system.update(0.1, 'menu');
    expect(system.music.state).toBe('menu');

    // A menu pauses a fight, it does not end one — resuming should not be an anticlimax.
    system.update(60, 'menu');
    expect(system.inCombat).toBe(true);
  });

  it('goes quiet while suspended and plays nothing', () => {
    const { system, bus, played } = rig(PICKUP);
    system.start();

    system.setSuspended(true);
    bus.emit('pickup', {});
    expect(played).toEqual([]);

    system.setSuspended(false);
    bus.emit('pickup', {});
    expect(played).toHaveLength(1);
  });

  it('multiplies the author defaults by the player mixer rather than replacing them', () => {
    // Two layers: the author balances the game, the player sets how loud their machine is.
    const { system } = rig({ music: TRACKS, masterVolume: 0.5, musicVolume: 0.8 });
    system.start();
    system.update(0.1);

    system.setMixer({ master: 0.5, music: 0.5, sfx: 1 });
    // 0.5 author master * 0.5 player master * 0.8 author music * 0.5 player music
    expect(system.mixer.music).toBe(0.5);
  });

  it('stops listening when stopped', () => {
    const { system, bus, played } = rig(PICKUP);
    system.start();
    system.stop();

    bus.emit('pickup', {});
    expect(played).toEqual([]);
  });
});

describe('MixerStore', () => {
  function memory(seed: Record<string, string> = {}): SaveStorage {
    const map = new Map(Object.entries(seed));
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
      removeItem: (key) => {
        map.delete(key);
      },
    };
  }

  it('defaults to everything at full', () => {
    expect(new MixerStore(memory()).read()).toEqual({ master: 1, music: 1, sfx: 1 });
  });

  it('round-trips settings', () => {
    const storage = memory();
    const store = new MixerStore(storage);
    store.write({ master: 0.4, music: 0.2, sfx: 0.9 });

    expect(new MixerStore(storage).read()).toEqual({ master: 0.4, music: 0.2, sfx: 0.9 });
  });

  it('discards a tampered value rather than producing a volume of forty', () => {
    const storage = memory({ [MIXER_KEY]: JSON.stringify({ master: 40, music: 1, sfx: 1 }) });
    expect(new MixerStore(storage).read()).toEqual({ master: 1, music: 1, sfx: 1 });
  });

  it('survives unreadable JSON and no storage at all', () => {
    expect(new MixerStore(memory({ [MIXER_KEY]: '{oops' })).read().master).toBe(1);
    const none = new MixerStore(null);
    expect(() => none.write({ master: 0.5, music: 1, sfx: 1 })).not.toThrow();
    expect(none.read().master).toBe(1);
  });
});

describe('audio and the rest of the engine', () => {
  it('needs no gameplay change: every sound is a name the bus already carries', () => {
    // A guard against the obvious regression — someone adding a `playSound()` call into a
    // behaviour, which would work and would also make audio unremovable.
    const bus = makeBus();
    const heard = vi.fn();
    bus.onAny(heard);

    for (const event of ['pickup', 'checkpoint', 'playerDamaged', 'weaponFired', 'enemyDied']) {
      bus.emit(event, {});
    }
    expect(heard).toHaveBeenCalledTimes(5);
  });
});
