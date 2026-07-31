import { Howl } from 'howler';
import type { Music, MusicState } from '@helaengine/schema';

export interface MusicPlayerOptions {
  config: Music;
  /** Turns an `assetId` into a URL. Null means the scene does not ship that track. */
  resolve(assetId: string): string | null;
  /** Constructs a track. Injected so tests can watch what is asked of it without a sound card. */
  create?: (url: string) => MusicTrack;
}

/**
 * The slice of Howl this needs.
 *
 * Narrow on purpose: a crossfade is "start the new one quiet, ramp both, stop the old one", and
 * every one of those is a method here. A test can implement four functions; it cannot implement
 * Howler.
 */
export interface MusicTrack {
  play(): void;
  stop(): void;
  volume(level: number): void;
  fade(from: number, to: number, milliseconds: number): void;
  unload(): void;
  playing(): boolean;
}

interface Playing {
  state: MusicState;
  track: MusicTrack;
}

/**
 * Music that follows what the game is doing.
 *
 * A crossfade rather than a cut, because the alternative is the single most jarring thing an engine
 * can do to a player: the music stopping dead the moment a goblin notices them. The new track
 * starts silent and rises while the old one falls, so there is never a gap and never a double
 * volume in the middle.
 *
 * Framework-free, and it takes its track factory as an option — so this class is testable without
 * an audio device, which matters because CI has no sound card and neither does headless Chromium.
 */
export class MusicPlayer {
  #config: Music;
  readonly #resolve: MusicPlayerOptions['resolve'];
  readonly #create: (url: string) => MusicTrack;

  #current: Playing | null = null;
  /** The track on its way out. Kept so a second change mid-fade can stop it rather than orphan it. */
  #previous: MusicTrack | null = null;
  #volume = 1;
  #muted = false;

  constructor(options: MusicPlayerOptions) {
    this.#config = options.config;
    this.#resolve = options.resolve;
    this.#create =
      options.create ??
      ((url) => new Howl({ src: [url], loop: true, volume: 0, html5: false }) as MusicTrack);
  }

  get state(): MusicState | null {
    return this.#current?.state ?? null;
  }

  get playing(): boolean {
    return this.#current?.track.playing() ?? false;
  }

  setConfig(config: Music): void {
    this.#config = config;
  }

  /**
   * The music bus level, 0..1.
   *
   * Applied to whatever is playing immediately rather than at the next transition — a volume slider
   * that only takes effect when the music next changes is a volume slider that appears broken.
   */
  setVolume(level: number): void {
    this.#volume = Math.max(0, Math.min(1, level));
    if (!this.#muted) this.#current?.track.volume(this.#volume);
  }

  setMuted(muted: boolean): void {
    this.#muted = muted;
    this.#current?.track.volume(muted ? 0 : this.#volume);
  }

  /** Changes state, crossfading. Asking for the state already playing does nothing. */
  setState(state: MusicState): void {
    if (this.#current?.state === state) return;

    const assetId = this.#trackFor(state);
    const url = assetId ? this.#resolve(assetId) : null;

    // A scene with no track for this state falls silent rather than keeping the wrong one playing:
    // exploration music continuing through a boss fight is worse than no music at all.
    if (!url) {
      this.#fadeOutCurrent();
      this.#current = null;
      return;
    }

    const track = this.#create(url);
    const milliseconds = this.#config.crossfadeSeconds * 1000;
    const target = this.#muted ? 0 : this.#volume;

    this.#fadeOutCurrent();
    track.volume(0);
    track.play();
    if (milliseconds > 0) track.fade(0, target, milliseconds);
    else track.volume(target);

    this.#current = { state, track };
  }

  /** Stops everything and frees the decoded audio. */
  dispose(): void {
    this.#previous?.stop();
    this.#previous?.unload();
    this.#previous = null;
    this.#current?.track.stop();
    this.#current?.track.unload();
    this.#current = null;
  }

  #trackFor(state: MusicState): string | null {
    switch (state) {
      case 'menu':
        return this.#config.menuTrackAssetId;
      case 'explore':
        return this.#config.exploreTrackAssetId;
      case 'combat':
        return this.#config.combatTrackAssetId;
    }
  }

  #fadeOutCurrent(): void {
    // A change arriving mid-fade would otherwise leave the previous track fading forever with
    // nobody holding a reference to stop it.
    this.#previous?.stop();
    this.#previous?.unload();
    this.#previous = null;

    const current = this.#current;
    if (!current) return;

    const milliseconds = this.#config.crossfadeSeconds * 1000;
    if (milliseconds <= 0) {
      current.track.stop();
      current.track.unload();
      return;
    }

    current.track.fade(this.#muted ? 0 : this.#volume, 0, milliseconds);
    this.#previous = current.track;
    // Howler does not promise to stop a track when its fade reaches zero, and a silent track still
    // decodes. The timer is what actually frees it.
    setTimeout(() => {
      if (this.#previous !== current.track) return;
      current.track.stop();
      current.track.unload();
      this.#previous = null;
    }, milliseconds + 50);
  }
}
