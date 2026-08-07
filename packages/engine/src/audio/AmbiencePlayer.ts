import { Howl } from 'howler';
import { ambienceVolume, type AmbienceLayer } from '@helaengine/schema';
import type { MusicTrack } from './MusicPlayer.js';

/**
 * Looping beds of sound, several at once.
 *
 * The distinction from music is not cosmetic. Music is a *state* — menu, explore, combat — and
 * exactly one plays, with crossfades between them; ambience is a *place*, and layers stack, which
 * is how a river in a forest sounds like both at once rather than like whichever the engine picked.
 *
 * ## Why layers are keyed by asset rather than by index
 *
 * The editor edits a list, and editing a list means inserting and removing from the middle. Keyed
 * by index, deleting the first of three layers restarts the other two — an audible glitch caused by
 * an edit that should not have touched them. Keyed by asset, only what actually changed changes.
 *
 * The cost is that one asset cannot appear twice in the list. That is not a loss: two copies of the
 * same loop at the same volume is one loop, slightly louder, and at different volumes it is one
 * loop at the sum.
 */

export interface AmbiencePlayerOptions {
  resolve(assetId: string): string | null;
  /** Injected by tests. Real playback goes through Howler, like music does. */
  create?: (url: string) => MusicTrack;
  warn?: (message: string) => void;
}

interface Bed {
  track: MusicTrack;
  layer: AmbienceLayer;
}

export class AmbiencePlayer {
  readonly #resolve: AmbiencePlayerOptions['resolve'];
  readonly #create: (url: string) => MusicTrack;
  readonly #warn: (message: string) => void;

  readonly #beds = new Map<string, Bed>();
  #layers: readonly AmbienceLayer[] = [];
  /** Master × ambience volume from the mixer. Layer volumes ride on top. */
  #gain = 1;
  #windStrength = 0;
  #playing = false;

  constructor(options: AmbiencePlayerOptions) {
    this.#resolve = options.resolve;
    this.#create =
      options.create ??
      ((url) => new Howl({ src: [url], loop: true, volume: 0 }) as unknown as MusicTrack);
    this.#warn = options.warn ?? ((message) => console.warn(`[helaengine] ${message}`));
  }

  /** Asset ids currently playing, for tests and the editor's readout. */
  get playingIds(): string[] {
    return [...this.#beds.keys()];
  }

  /**
   * Takes a new list of layers, starting and stopping only what changed.
   *
   * Called whenever the document changes, which in the editor is on every keystroke of a volume
   * field. Restarting every bed each time would make the panel unusable — a loop that restarts
   * sixty times a second is silence with clicks in it.
   */
  setLayers(layers: readonly AmbienceLayer[]): void {
    this.#layers = layers;
    const wanted = new Set(layers.map((layer) => layer.assetId));

    for (const [assetId, bed] of this.#beds) {
      if (wanted.has(assetId)) continue;
      bed.track.unload();
      this.#beds.delete(assetId);
    }

    for (const layer of layers) {
      const existing = this.#beds.get(layer.assetId);
      if (existing) {
        // Same bed, possibly a new volume. Nothing restarts.
        existing.layer = layer;
        continue;
      }

      const url = this.#resolve(layer.assetId);
      if (!url) {
        this.#warn(`ambience layer names "${layer.assetId}", which this project does not ship`);
        continue;
      }

      const track = this.#create(url);
      this.#beds.set(layer.assetId, { track, layer });
      if (this.#playing) track.play();
    }

    this.#applyVolumes();
  }

  /** Starts everything. Call once the audio context is allowed to make noise. */
  play(): void {
    if (this.#playing) return;
    this.#playing = true;
    for (const bed of this.#beds.values()) bed.track.play();
    this.#applyVolumes();
  }

  setVolume(gain: number): void {
    this.#gain = gain;
    this.#applyVolumes();
  }

  /**
   * Tells the beds how hard the wind is blowing.
   *
   * The one place audio and the renderer share a setting, and worth the coupling: wind you can see
   * but not hear reads as a rendering trick, and a howling gale over motionless grass reads as a
   * broken level. Layers that do not opt in are unaffected.
   */
  setWindStrength(strength: number): void {
    if (strength === this.#windStrength) return;
    this.#windStrength = strength;
    // Only worth the walk if something is actually listening to the wind.
    if (this.#layers.some((layer) => layer.followWind > 0)) this.#applyVolumes();
  }

  dispose(): void {
    for (const bed of this.#beds.values()) bed.track.unload();
    this.#beds.clear();
    this.#layers = [];
    this.#playing = false;
  }

  #applyVolumes(): void {
    for (const bed of this.#beds.values()) {
      bed.track.volume(this.#gain * ambienceVolume(bed.layer, this.#windStrength));
    }
  }
}
