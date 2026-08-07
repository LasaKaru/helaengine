import { beforeEach, describe, expect, it } from 'vitest';
import { AmbienceLayerSchema, ambienceVolume, type AmbienceLayer } from '@helaengine/schema';
import { AmbiencePlayer } from './AmbiencePlayer.js';

/**
 * Looping beds, against a fake that records what actually happened to each track.
 *
 * The interesting claims are all about *change*: the editor rewrites this list on every keystroke of
 * a volume field, so a player that restarted its loops on each call would turn the panel into
 * silence with clicks in it.
 */

interface FakeTrack {
  url: string;
  plays: number;
  volumes: number[];
  unloaded: boolean;
}

const tracks: FakeTrack[] = [];

function playerFor(warn: string[] = []): AmbiencePlayer {
  return new AmbiencePlayer({
    resolve: (assetId) => (assetId.startsWith('audio_') ? `/audio/${assetId}.wav` : null),
    create: (url) => {
      const track: FakeTrack = { url, plays: 0, volumes: [], unloaded: false };
      tracks.push(track);
      return {
        play: () => {
          track.plays += 1;
        },
        volume: (level: number) => track.volumes.push(level),
        unload: () => {
          track.unloaded = true;
        },
      } as never;
    },
    warn: (message) => warn.push(message),
  });
}

const layer = (assetId: string, parts: Partial<AmbienceLayer> = {}): AmbienceLayer =>
  AmbienceLayerSchema.parse({ assetId, ...parts });

const trackFor = (assetId: string): FakeTrack | undefined =>
  tracks.find((track) => track.url.includes(assetId));

beforeEach(() => {
  tracks.length = 0;
});

describe('layers', () => {
  it('plays several at once', () => {
    // The distinction from music: ambience is a place, and a river in a forest is both.
    const player = playerFor();
    player.setLayers([layer('audio_ambience_wind'), layer('audio_ambience_water')]);
    player.play();

    expect(player.playingIds).toEqual(['audio_ambience_wind', 'audio_ambience_water']);
    expect(trackFor('audio_ambience_wind')?.plays).toBe(1);
    expect(trackFor('audio_ambience_water')?.plays).toBe(1);
  });

  it('does not restart a bed whose volume merely changed', () => {
    /**
     * The claim the whole diffing exists for.
     *
     * A volume field is dragged, which rewrites the document on every frame of the drag. Restarting
     * the loop each time is not a subtle inefficiency — it is a bed that never gets past its first
     * hundred milliseconds, which sounds like a fault in the file.
     */
    const player = playerFor();
    player.setLayers([layer('audio_ambience_wind', { volume: 0.4 })]);
    player.play();
    expect(trackFor('audio_ambience_wind')?.plays).toBe(1);

    for (let step = 0; step < 10; step += 1) {
      player.setLayers([layer('audio_ambience_wind', { volume: 0.4 + step * 0.05 })]);
    }

    expect(trackFor('audio_ambience_wind')?.plays).toBe(1);
    expect(trackFor('audio_ambience_wind')?.unloaded).toBe(false);
    // The volume did follow, which is the other half of the claim.
    expect(trackFor('audio_ambience_wind')?.volumes.at(-1)).toBeCloseTo(0.85, 5);
  });

  it('leaves its neighbours alone when one is removed from the middle', () => {
    // Keyed by asset rather than by index. By index, deleting the first of three restarts the other
    // two — an audible glitch from an edit that should not have touched them.
    const player = playerFor();
    player.setLayers([
      layer('audio_ambience_wind'),
      layer('audio_ambience_birds'),
      layer('audio_ambience_water'),
    ]);
    player.play();

    player.setLayers([layer('audio_ambience_birds'), layer('audio_ambience_water')]);

    expect(trackFor('audio_ambience_wind')?.unloaded).toBe(true);
    expect(trackFor('audio_ambience_birds')?.plays).toBe(1);
    expect(trackFor('audio_ambience_water')?.plays).toBe(1);
    expect(player.playingIds).toEqual(['audio_ambience_birds', 'audio_ambience_water']);
  });

  it('starts a layer added while already playing', () => {
    const player = playerFor();
    player.setLayers([layer('audio_ambience_wind')]);
    player.play();

    player.setLayers([layer('audio_ambience_wind'), layer('audio_ambience_birds')]);
    expect(trackFor('audio_ambience_birds')?.plays).toBe(1);
  });

  it('does not start anything before play', () => {
    // The audio context is not allowed to make noise until the player has interacted with the page.
    const player = playerFor();
    player.setLayers([layer('audio_ambience_wind')]);
    expect(trackFor('audio_ambience_wind')?.plays).toBe(0);
  });

  it('warns about a layer the project does not ship, and carries on', () => {
    const warnings: string[] = [];
    const player = playerFor(warnings);
    player.setLayers([layer('missing_clip'), layer('audio_ambience_wind')]);
    player.play();

    expect(warnings.join('\n')).toContain('missing_clip');
    // The rest still plays: one bad reference should not silence the level.
    expect(player.playingIds).toEqual(['audio_ambience_wind']);
  });

  it('unloads everything on dispose', () => {
    const player = playerFor();
    player.setLayers([layer('audio_ambience_wind'), layer('audio_ambience_birds')]);
    player.play();
    player.dispose();

    expect(tracks.every((track) => track.unloaded)).toBe(true);
    expect(player.playingIds).toEqual([]);
  });
});

describe('following the wind', () => {
  it('leaves a layer that did not opt in alone', () => {
    const player = playerFor();
    player.setLayers([layer('audio_ambience_water', { volume: 0.5, followWind: 0 })]);
    player.play();
    const before = trackFor('audio_ambience_water')!.volumes.length;

    player.setWindStrength(4);
    // Not merely "the same value" — no write at all, because nothing in the list cares.
    expect(trackFor('audio_ambience_water')!.volumes.length).toBe(before);
  });

  it('takes a layer that did from silence to full', () => {
    const player = playerFor();
    player.setLayers([layer('audio_ambience_wind', { volume: 0.8, followWind: 1 })]);
    player.play();

    player.setWindStrength(0);
    expect(trackFor('audio_ambience_wind')!.volumes.at(-1)).toBeCloseTo(0, 5);

    // Wind you can see but not hear reads as a rendering trick.
    player.setWindStrength(4);
    expect(trackFor('audio_ambience_wind')!.volumes.at(-1)).toBeCloseTo(0.8, 5);
  });

  it('mixes partially when the layer only half follows', () => {
    const half = layer('audio_ambience_wind', { volume: 1, followWind: 0.5 });
    expect(ambienceVolume(half, 0)).toBeCloseTo(0.5, 5);
    expect(ambienceVolume(half, 4)).toBeCloseTo(1, 5);
    expect(ambienceVolume(half, 2)).toBeCloseTo(0.75, 5);
  });

  it('clamps a wind stronger than the schema allows', () => {
    const following = layer('audio_ambience_wind', { volume: 1, followWind: 1 });
    // Never louder than the layer's own volume, whatever a hand-edited document claims.
    expect(ambienceVolume(following, 999)).toBeCloseTo(1, 5);
    expect(ambienceVolume(following, -5)).toBeCloseTo(0, 5);
  });
});

describe('mixer gain', () => {
  it('multiplies the layer volume rather than replacing it', () => {
    const player = playerFor();
    player.setLayers([layer('audio_ambience_wind', { volume: 0.5 })]);
    player.play();
    player.setVolume(0.4);

    // The author balances the level and the player sets how loud their machine is. Collapsing the
    // two would mean turning the volume down also rebalancing the mix.
    expect(trackFor('audio_ambience_wind')!.volumes.at(-1)).toBeCloseTo(0.2, 5);
  });
});
