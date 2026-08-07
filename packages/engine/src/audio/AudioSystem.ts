import { Howl, Howler } from 'howler';
import type * as THREE from 'three';
import type { AudioConfig, MixerSettings, MusicState, SfxBinding } from '@helaengine/schema';
import type { EventBus } from '../TriggerRuntime.js';
import { MusicPlayer, type MusicTrack } from './MusicPlayer.js';
import { AmbiencePlayer } from './AmbiencePlayer.js';

/** The slice of a one-shot sound this needs. Same reasoning as `MusicTrack`. */
export interface SfxVoice {
  play(): void;
  volume(level: number): void;
  /** Places the sound in the world. Ignored by a non-positional voice. */
  pos?(x: number, y: number, z: number): void;
  unload(): void;
}

export interface AudioSystemOptions {
  config: AudioConfig;
  bus: EventBus;
  /** Turns an `assetId` into a URL, or null when the project does not ship it. */
  resolve(assetId: string): string | null;
  /** Where an object is, for a positional sound. Null when there is no such object. */
  locate?(objectId: string): THREE.Vector3 | null;
  /** Where the listener is. Positional sounds are placed relative to it. */
  listener?(): { position: THREE.Vector3; forward: THREE.Vector3 } | null;
  createMusic?: (url: string) => MusicTrack;
  createAmbience?: (url: string) => MusicTrack;
  createSfx?: (url: string, binding: SfxBinding) => SfxVoice;
  /** Injected for tests; `performance.now` in a browser. */
  now?: () => number;
}

/** Events that mean a fight is happening, for the music state machine. */
const COMBAT_EVENTS = new Set(['enemyAlerted', 'enemyAttacked', 'playerDamaged', 'weaponFired']);

/**
 * Sound, bound to what the game is already saying.
 *
 * The whole design rests on the event bus existing: behaviours already raise `pickup`,
 * `checkpoint`, `enemyDied` and the rest, so audio does not need a single new call site in gameplay
 * code. A scene binds a name to a clip and that is the entire integration — which is also why an
 * author can add a sound to something the engine has never heard of.
 *
 * Two audio graphs are in play and it is worth being honest about it: Howler owns its own
 * `AudioContext` for music and one-shots, and Three's `AudioListener` owns another for positional
 * sources. They are kept in step by applying the same master gain to both. One shared context
 * would be tidier; it is not worth reimplementing Howler to get it.
 */
export class AudioSystem {
  readonly music: MusicPlayer;
  readonly ambience: AmbiencePlayer;

  #config: AudioConfig;
  readonly #bus: EventBus;
  readonly #resolve: AudioSystemOptions['resolve'];
  readonly #locate: NonNullable<AudioSystemOptions['locate']>;
  readonly #listener: NonNullable<AudioSystemOptions['listener']>;
  readonly #createSfx: (url: string, binding: SfxBinding) => SfxVoice;
  readonly #now: () => number;
  readonly #unsubscribes: Array<() => void> = [];
  /** Per-binding rate limiting: last play time, and how many have gone out in this second. */
  readonly #recent = new Map<SfxBinding, { windowStart: number; count: number }>();

  #mixer: MixerSettings = { master: 1, music: 1, sfx: 1 };
  #started = false;
  /** Seconds since anything combat-flavoured happened, or null when out of combat. */
  #sinceCombat: number | null = null;
  #suspended = false;

  constructor(options: AudioSystemOptions) {
    this.#config = options.config;
    this.#bus = options.bus;
    this.#resolve = options.resolve;
    this.#locate = options.locate ?? (() => null);
    this.#listener = options.listener ?? (() => null);
    this.#now = options.now ?? (() => Date.now());
    this.#createSfx =
      options.createSfx ??
      ((url, binding) =>
        new Howl({
          src: [url],
          volume: binding.volume,
          ...(binding.positional
            ? { html5: false, pannerAttr: { maxDistance: binding.maxDistance, refDistance: 1 } }
            : {}),
        }) as unknown as SfxVoice);

    this.ambience = new AmbiencePlayer({
      resolve: options.resolve,
      ...(options.createAmbience ? { create: options.createAmbience } : {}),
    });
    this.ambience.setLayers(options.config.ambience);

    this.music = new MusicPlayer({
      config: options.config.music,
      resolve: options.resolve,
      ...(options.createMusic ? { create: options.createMusic } : {}),
    });
    this.#applyVolumes();
  }

  get mixer(): Readonly<MixerSettings> {
    return this.#mixer;
  }

  /** True while the music thinks a fight is happening. */
  get inCombat(): boolean {
    return this.#sinceCombat !== null;
  }

  setConfig(config: AudioConfig): void {
    this.#config = config;
    this.music.setConfig(config.music);
    this.ambience.setLayers(config.ambience);
    this.#applyVolumes();
  }

  /**
   * Passes the wind through to the beds.
   *
   * Taken as a number rather than a `Wind`, so the audio package does not need to know what a wind
   * *is* — only how hard it is blowing. That keeps the one coupling between sound and rendering to
   * a single float.
   */
  setWindStrength(strength: number): void {
    this.ambience.setWindStrength(strength);
  }

  /**
   * The player's own mixer settings, multiplied by the author's defaults.
   *
   * Two layers rather than one, because they answer different questions: the author sets how the
   * game is balanced, and the player sets how loud their machine is. Collapsing them would mean a
   * player turning the music down also rebalancing it against the effects.
   */
  setMixer(settings: MixerSettings): void {
    this.#mixer = settings;
    this.#applyVolumes();
  }

  /** Starts listening. Call once the audio context is allowed to make noise. */
  start(): void {
    if (this.#started) return;
    this.#started = true;

    this.ambience.play();

    this.#unsubscribes.push(
      this.#bus.onAny((event, payload) => {
        if (COMBAT_EVENTS.has(event)) this.#sinceCombat = 0;
        this.#playFor(event, payload);
      }),
    );
  }

  /**
   * One frame. Advances the combat hold and follows the listener.
   *
   * `state` overrides the automatic choice — the shell passes `menu` while a menu is up, because no
   * amount of event-watching can know the player is staring at a pause screen.
   */
  update(deltaSeconds: number, state?: MusicState): void {
    if (state) {
      this.music.setState(state);
      // A menu does not end a fight; it pauses one. Holding the timer means resuming drops the
      // player back into combat music rather than into an anticlimax.
      if (state !== 'menu' && this.#sinceCombat !== null) this.#sinceCombat += deltaSeconds;
      return;
    }

    if (this.#sinceCombat !== null) {
      this.#sinceCombat += deltaSeconds;
      if (this.#sinceCombat > this.#config.music.combatHoldSeconds) this.#sinceCombat = null;
    }

    this.music.setState(this.#sinceCombat === null ? 'explore' : 'combat');
    this.#followListener();
  }

  /** Plays a bound sound directly, for a host that wants to trigger one without an event. */
  play(event: string, payload?: unknown): void {
    this.#playFor(event, payload);
  }

  /**
   * Silences everything without tearing it down — what a pause menu wants.
   *
   * Muting rather than stopping, because a stopped music track restarts from the top on resume and
   * a paused game should come back where it left off.
   */
  setSuspended(suspended: boolean): void {
    this.#suspended = suspended;
    this.music.setMuted(suspended);
  }

  /**
   * Nudges the audio context awake.
   *
   * Browsers refuse to start one outside a user gesture, so the shell calls this from the Play
   * button. Without it the first game has no sound at all and nothing says why.
   */
  static resume(): void {
    const context = (Howler as unknown as { ctx?: AudioContext }).ctx;
    if (context?.state === 'suspended') void context.resume();
  }

  stop(): void {
    if (!this.#started) return;
    this.#started = false;
    for (const unsubscribe of this.#unsubscribes) unsubscribe();
    this.#unsubscribes.length = 0;
    this.#recent.clear();
    this.#sinceCombat = null;
    this.music.dispose();
    this.ambience.dispose();
  }

  #applyVolumes(): void {
    const master = this.#config.masterVolume * this.#mixer.master;
    this.music.setVolume(master * this.#config.musicVolume * this.#mixer.music);
    // Ambience rides the music slider rather than getting one of its own: a player who turns the
    // music down is asking for a quieter background, and a third slider they have to find is not a
    // feature.
    this.ambience.setVolume(
      master * this.#config.ambienceVolume * this.#config.musicVolume * this.#mixer.music,
    );
    // Howler's global volume covers the one-shots, which are created and thrown away too fast to
    // be worth tracking individually.
    (Howler as unknown as { volume(level: number): void }).volume?.(
      master * this.#config.sfxVolume * this.#mixer.sfx,
    );
  }

  #playFor(event: string, payload: unknown): void {
    if (this.#suspended) return;

    for (const binding of this.#config.sfx) {
      if (binding.event !== event) continue;
      if (!this.#allowed(binding)) continue;

      const url = this.#resolve(binding.assetId);
      // A binding naming a clip the project does not ship is silent rather than fatal: an author
      // mid-edit should not have their preview stop working.
      if (!url) continue;

      const voice = this.#createSfx(url, binding);
      if (binding.positional) {
        const objectId = (payload as { objectId?: unknown } | undefined)?.objectId;
        const at = typeof objectId === 'string' ? this.#locate(objectId) : null;
        if (at) voice.pos?.(at.x, at.y, at.z);
      }
      voice.play();
    }
  }

  /**
   * Rate limiting, per binding.
   *
   * Twenty enemies dying in one frame is twenty identical samples starting together, which is not
   * twenty times louder so much as one loud click.
   */
  #allowed(binding: SfxBinding): boolean {
    const now = this.#now();
    const record = this.#recent.get(binding);

    if (!record || now - record.windowStart >= 1000) {
      this.#recent.set(binding, { windowStart: now, count: 1 });
      return true;
    }
    if (record.count >= binding.maxPerSecond) return false;

    record.count += 1;
    return true;
  }

  #followListener(): void {
    const listener = this.#listener();
    if (!listener) return;

    const howler = Howler as unknown as {
      pos?(x: number, y: number, z: number): void;
      orientation?(x: number, y: number, z: number, ux: number, uy: number, uz: number): void;
    };
    howler.pos?.(listener.position.x, listener.position.y, listener.position.z);
    howler.orientation?.(listener.forward.x, listener.forward.y, listener.forward.z, 0, 1, 0);
  }
}
