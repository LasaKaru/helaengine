import type { MixerSettings, UiAction, UiButton, UiConfig } from '@helaengine/schema';
import { themeVariables } from './theme.js';

/** Which surface is showing. `playing` means the shell is out of the way. */
export type UiScreen = 'home' | 'intro' | 'mainMenu' | 'playing' | 'paused' | 'settings';

export interface HudState {
  health: number;
  maxHealth: number;
  ammo: number | null;
  score: number;
  /** Seconds since the run started. */
  timer: number;
}

export interface UIRendererOptions {
  /** Element the overlay is appended to. Must be a positioned containing block. */
  container: HTMLElement;
  config: UiConfig;
  /** Turns an `assetId` into a URL. Without one, images and video are simply skipped. */
  resolveAsset?: (assetId: string) => string | null;
  /**
   * Called for every button press, after the renderer has moved to the screen the action implies.
   *
   * The split matters: the renderer knows that `resume` means "show the world", and the host knows
   * that it means "start stepping physics again". Neither needs to know the other's half.
   */
  onAction?: (action: UiAction) => void;
  /** Called as a mixer slider moves, so the host can apply it while the player is still dragging. */
  onVolumeChange?: (channel: 'master' | 'music' | 'sfx', value: number) => void;
  /** Where the sliders start. The host owns the values; the shell only draws them. */
  mixer?: MixerSettings;
  /** Called whenever the visible screen changes, however it changed. */
  onScreenChange?: (screen: UiScreen) => void;
}

/** Where an action leaves the shell. Everything not listed here stays put. */
const SCREEN_FOR_ACTION: Partial<Record<UiAction, UiScreen>> = {
  startGame: 'playing',
  resume: 'playing',
  restartCheckpoint: 'playing',
  openSettings: 'settings',
  mainMenu: 'mainMenu',
};

const STYLE_ID = 'hela-ui-styles';

/**
 * The game's shell, rendered from `uiConfig`.
 *
 * Structurally the twin of `SceneLoader`: data in, a thing on screen out, no per-project code. DOM
 * and CSS rather than meshes in the 3D scene, because text quality, accessibility and the ability
 * to restyle a whole menu with one custom property all argue for it, and an in-world menu is a
 * niche this can grow into later without any of this being wasted.
 *
 * It owns which screen is showing and nothing else. Starting and stopping the simulation is the
 * host's business, which is why every button both changes the screen *and* reports the action.
 */
export class UIRenderer {
  readonly #container: HTMLElement;
  readonly #root: HTMLElement;
  readonly #resolveAsset: (assetId: string) => string | null;
  readonly #onAction: (action: UiAction) => void;
  readonly #onVolumeChange: (channel: 'master' | 'music' | 'sfx', value: number) => void;
  readonly #onScreenChange: (screen: UiScreen) => void;

  #config: UiConfig;
  #screen: UiScreen = 'home';
  #mixer: MixerSettings = { master: 1, music: 1, sfx: 1 };
  #hud: HudState = { health: 100, maxHealth: 100, ammo: null, score: 0, timer: 0 };
  #mounted = false;
  #video: HTMLVideoElement | null = null;

  constructor(options: UIRendererOptions) {
    this.#container = options.container;
    this.#config = options.config;
    this.#resolveAsset = options.resolveAsset ?? (() => null);
    this.#onAction = options.onAction ?? (() => {});
    this.#onVolumeChange = options.onVolumeChange ?? (() => {});
    this.#onScreenChange = options.onScreenChange ?? (() => {});
    if (options.mixer) this.#mixer = options.mixer;

    this.#root = document.createElement('div');
    this.#root.className = 'hela-ui';
    this.#root.dataset['screen'] = this.#screen;
  }

  get screen(): UiScreen {
    return this.#screen;
  }

  /** What the mixer sliders currently read. */
  get mixer(): Readonly<MixerSettings> {
    return this.#mixer;
  }

  /** Sets the sliders from outside — restoring saved settings, or a host-side reset. */
  setMixer(mixer: MixerSettings): void {
    this.#mixer = mixer;
    if (this.#screen === 'settings') this.#render();
  }

  get root(): HTMLElement {
    return this.#root;
  }

  get mounted(): boolean {
    return this.#mounted;
  }

  mount(): void {
    if (this.#mounted) return;
    this.#mounted = true;

    ensureStyles();
    if (getComputedStyle(this.#container).position === 'static') {
      this.#container.style.position = 'relative';
    }
    this.#container.appendChild(this.#root);

    // An intro that exists is the first thing anyone sees; otherwise straight to the home screen.
    // Assigned rather than routed through `setScreen`, which short-circuits when the screen is
    // already what it is being set to — and `home` is the initial value, so mounting a document
    // with no intro would have rendered nothing at all.
    const first: UiScreen = this.#config.homeScreen.introVideoAssetId ? 'intro' : 'home';
    this.#screen = first;
    this.#root.dataset['screen'] = first;
    this.#render();
    this.#onScreenChange(first);
  }

  unmount(): void {
    if (!this.#mounted) return;
    this.#mounted = false;
    this.#stopVideo();
    this.#root.remove();
  }

  /** Swaps in a new config and repaints. The editor calls this on every document edit. */
  setConfig(config: UiConfig): void {
    this.#config = config;
    this.#render();
  }

  setScreen(screen: UiScreen): void {
    if (screen === this.#screen) return;
    if (screen !== 'intro') this.#stopVideo();
    this.#screen = screen;
    this.#root.dataset['screen'] = screen;
    this.#render();
    this.#onScreenChange(screen);
  }

  /** Updates the numbers on the HUD. Cheap enough to call every frame. */
  setHud(state: Partial<HudState>): void {
    this.#hud = { ...this.#hud, ...state };
    if (this.#screen === 'playing') this.#paintHud();
  }

  /** Runs an action as if its button had been pressed. Used by keyboard shortcuts. */
  dispatch(action: UiAction): void {
    const next = SCREEN_FOR_ACTION[action];
    if (next) this.setScreen(next);
    else if (action === 'closeSettings') this.setScreen(this.#screenBeforeSettings());
    this.#onAction(action);
  }

  /** Escape means pause while playing and resume while paused — the universal convention. */
  togglePause(): boolean {
    if (this.#screen === 'playing') {
      this.setScreen('paused');
      return true;
    }
    if (this.#screen === 'paused') {
      this.dispatch('resume');
      return true;
    }
    if (this.#screen === 'settings') {
      this.dispatch('closeSettings');
      return true;
    }
    return false;
  }

  /**
   * Where `closeSettings` returns to.
   *
   * Settings is reachable from two places and has to go back to the right one; tracking it as
   * "wherever we came from" is one field's worth of state that removes a whole class of "the back
   * button went to the wrong screen" bugs.
   */
  #cameFrom: UiScreen = 'mainMenu';

  #screenBeforeSettings(): UiScreen {
    return this.#cameFrom;
  }

  #render(): void {
    this.#root.innerHTML = '';
    const theme = this.#config.theme;
    for (const [name, value] of Object.entries(themeVariables(theme))) {
      this.#root.style.setProperty(name, value);
    }
    this.#root.dataset['panel'] = theme.panelStyle;

    if (!this.#config.enabled) return;

    switch (this.#screen) {
      case 'intro':
        this.#renderIntro();
        break;
      case 'home':
        this.#renderHome();
        break;
      case 'mainMenu':
        this.#renderMenu('Menu', this.#config.mainMenu.buttons);
        break;
      case 'paused':
        this.#renderMenu('Paused', this.#config.pauseMenu.buttons);
        break;
      case 'settings':
        this.#renderSettings();
        break;
      case 'playing':
        this.#renderHud();
        break;
    }
  }

  #renderIntro(): void {
    const assetId = this.#config.homeScreen.introVideoAssetId;
    const source = assetId ? this.#resolveAsset(assetId) : null;
    if (!source) {
      this.setScreen('home');
      return;
    }

    const video = document.createElement('video');
    video.className = 'hela-intro';
    video.src = source;
    // Muted autoplay is the only kind browsers allow without a gesture. Sound comes back the
    // moment the player touches anything, which is the standard dance and not worth fighting.
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.addEventListener('ended', () => this.setScreen('home'));
    // A video that fails to load must not strand the player on a black screen forever.
    video.addEventListener('error', () => this.setScreen('home'));
    void video.play().catch(() => this.setScreen('home'));
    this.#video = video;
    this.#root.appendChild(video);

    if (this.#config.homeScreen.introSkippable) {
      const skip = button('Skip', 'hela-skip', () => this.setScreen('home'));
      this.#root.appendChild(skip);
    }
  }

  #renderHome(): void {
    const home = this.#config.homeScreen;
    const background = home.backgroundImageAssetId
      ? this.#resolveAsset(home.backgroundImageAssetId)
      : null;

    const screen = element('div', 'hela-screen hela-home');
    if (background) screen.style.backgroundImage = `url(${background})`;

    const panel = element('div', 'hela-panel hela-home-panel');
    panel.appendChild(element('h1', 'hela-title', home.title));
    if (home.subtitle) panel.appendChild(element('p', 'hela-subtitle', home.subtitle));
    panel.appendChild(
      button(home.playButtonText, 'hela-button hela-primary', () => this.dispatch('startGame')),
    );
    panel.appendChild(
      button('Settings', 'hela-button', () => {
        this.#cameFrom = 'home';
        this.dispatch('openSettings');
      }),
    );

    screen.appendChild(panel);
    this.#root.appendChild(screen);
  }

  #renderMenu(heading: string, buttons: readonly UiButton[]): void {
    const screen = element('div', 'hela-screen hela-menu');
    const panel = element('div', 'hela-panel');
    panel.appendChild(element('h2', 'hela-heading', heading));

    if (buttons.length === 0) {
      panel.appendChild(element('p', 'hela-subtitle', 'No buttons configured.'));
    }

    for (const entry of buttons) {
      const control = button(entry.label, 'hela-button', () => {
        if (entry.action === 'openSettings') this.#cameFrom = this.#screen;
        this.dispatch(entry.action);
      });
      control.dataset['action'] = entry.action;
      panel.appendChild(control);
    }

    screen.appendChild(panel);
    this.#root.appendChild(screen);
  }

  #renderSettings(): void {
    const screen = element('div', 'hela-screen hela-menu');
    const panel = element('div', 'hela-panel');
    panel.appendChild(element('h2', 'hela-heading', 'Settings'));

    for (const channel of ['master', 'music', 'sfx'] as const) {
      const row = element('label', 'hela-row');
      row.appendChild(element('span', '', channel === 'sfx' ? 'Effects' : capitalise(channel)));

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = String(Math.round(this.#mixer[channel] * 100));
      slider.setAttribute('aria-label', `${channel} volume`);

      // The readout is the difference between a slider you can use and one you have to guess at,
      // especially with the sound muted or the machine silent.
      const readout = element('span', 'hela-readout', `${slider.value}%`);
      slider.addEventListener('input', () => {
        const value = Number(slider.value) / 100;
        this.#mixer = { ...this.#mixer, [channel]: value };
        readout.textContent = `${slider.value}%`;
        this.#onVolumeChange(channel, value);
      });

      row.appendChild(slider);
      row.appendChild(readout);
      panel.appendChild(row);
    }
    panel.appendChild(button('Back', 'hela-button', () => this.dispatch('closeSettings')));

    screen.appendChild(panel);
    this.#root.appendChild(screen);
  }

  #renderHud(): void {
    const hud = element('div', 'hela-hud');
    hud.dataset['testid'] = 'hud';

    if (this.#config.hud.showCrosshair) hud.appendChild(element('div', 'hela-crosshair'));

    if (this.#config.hud.showHealthBar) {
      const bar = element('div', 'hela-health');
      bar.setAttribute('role', 'status');
      bar.setAttribute('aria-label', 'Health');
      bar.appendChild(element('div', 'hela-health-fill'));
      bar.appendChild(element('span', 'hela-health-text'));
      hud.appendChild(bar);
    }

    if (this.#config.hud.showAmmoCounter) {
      const ammo = element('div', 'hela-ammo');
      ammo.setAttribute('aria-label', 'Ammo');
      hud.appendChild(ammo);
    }

    for (const custom of this.#config.hud.customElements) {
      const node = element('div', `hela-custom hela-anchor-${custom.anchor}`);
      node.dataset['elementId'] = custom.id;
      node.style.fontSize = `${custom.fontSize}px`;
      node.style.setProperty('--hela-offset-x', `${custom.offset[0]}px`);
      node.style.setProperty('--hela-offset-y', `${custom.offset[1]}px`);

      if (custom.kind === 'image') {
        const source = this.#resolveAsset(custom.value);
        if (source) {
          const image = document.createElement('img');
          image.src = source;
          image.alt = '';
          node.appendChild(image);
        }
      }
      hud.appendChild(node);
    }

    this.#root.appendChild(hud);
    this.#paintHud();
  }

  /**
   * Writes the live numbers into the HUD that is already on screen.
   *
   * Separate from `#renderHud` because this runs every frame and that one rebuilds the DOM. A HUD
   * that re-created its elements sixty times a second would be the most expensive thing in the
   * engine by an embarrassing margin.
   */
  #paintHud(): void {
    const { health, maxHealth, ammo } = this.#hud;
    const fraction = maxHealth > 0 ? Math.max(0, Math.min(1, health / maxHealth)) : 0;

    const fill = this.#root.querySelector<HTMLElement>('.hela-health-fill');
    if (fill) fill.style.width = `${fraction * 100}%`;

    const text = this.#root.querySelector<HTMLElement>('.hela-health-text');
    if (text) text.textContent = health <= 0 ? 'Down' : `${Math.round(health)} HP`;

    const ammoNode = this.#root.querySelector<HTMLElement>('.hela-ammo');
    if (ammoNode) ammoNode.textContent = ammo === null ? '—' : String(ammo);

    for (const custom of this.#config.hud.customElements) {
      if (custom.kind !== 'text') continue;
      const node = this.#root.querySelector<HTMLElement>(`[data-element-id="${custom.id}"]`);
      if (node) node.textContent = this.#bindingValue(custom.bind, custom.value);
    }
  }

  #bindingValue(bind: HudElementBind, literal: string): string {
    switch (bind) {
      case 'health':
        return String(Math.round(this.#hud.health));
      case 'ammo':
        return this.#hud.ammo === null ? '—' : String(this.#hud.ammo);
      case 'score':
        return String(this.#hud.score);
      case 'timer': {
        const total = Math.max(0, Math.floor(this.#hud.timer));
        return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
      }
      default:
        return literal;
    }
  }

  #stopVideo(): void {
    if (!this.#video) return;
    this.#video.pause();
    this.#video.remove();
    this.#video = null;
  }
}

type HudElementBind = UiConfig['hud']['customElements'][number]['bind'];

function element(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Injects the shell's stylesheet once per document.
 *
 * Shipped as a string inside the engine rather than as a separate CSS file, because an exported
 * project is a folder of files someone can open with a double click, and "remember to also copy
 * the stylesheet" is exactly the kind of step that makes an export not work.
 */
function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
.hela-ui { position: absolute; inset: 0; z-index: 30; font-family: var(--hela-font); color: var(--hela-text); }
.hela-ui[data-screen="playing"] { pointer-events: none; }
.hela-screen { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  background: var(--hela-bg); background-size: cover; background-position: center; }
.hela-home { align-items: flex-end; justify-content: flex-start; padding: 6vh 6vw; }
.hela-panel { display: flex; flex-direction: column; gap: 10px; min-width: 260px; max-width: 420px;
  padding: 28px; background: var(--hela-panel); border: 1px solid var(--hela-panel-border);
  border-radius: var(--hela-radius); }
.hela-title { margin: 0 0 4px; font-size: clamp(28px, 5vw, 52px); line-height: 1.05; }
.hela-heading { margin: 0 0 6px; font-size: 22px; }
.hela-subtitle { margin: 0 0 8px; color: var(--hela-text-dim); font-size: 14px; }
.hela-button { padding: 11px 18px; color: var(--hela-text); font: inherit; font-size: 15px;
  text-align: left; background: transparent; border: 1px solid var(--hela-panel-border);
  border-radius: var(--hela-radius); cursor: pointer; transition: background 120ms, color 120ms; }
.hela-button:hover, .hela-button:focus-visible { background: var(--hela-primary); color: var(--hela-on-primary); }
.hela-primary { background: var(--hela-primary); color: var(--hela-on-primary); font-weight: 600; }
.hela-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 14px; }
.hela-readout { min-width: 44px; text-align: right; font-variant-numeric: tabular-nums; opacity: 0.8; }
.hela-intro { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
.hela-skip { position: absolute; right: 24px; bottom: 24px; padding: 8px 16px; color: var(--hela-text);
  font: inherit; background: rgba(0,0,0,0.5); border: 1px solid var(--hela-panel-border);
  border-radius: var(--hela-radius); cursor: pointer; }
.hela-hud { position: absolute; inset: 0; pointer-events: none; }
.hela-crosshair { position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px;
  background: var(--hela-primary); border-radius: 50%; opacity: 0.85; }
.hela-health { position: absolute; left: 50%; bottom: 28px; display: flex; align-items: center;
  justify-content: center; width: 220px; height: 20px; overflow: hidden; font-size: 11px; font-weight: 600;
  background: var(--hela-panel); border: 1px solid var(--hela-panel-border); border-radius: 999px;
  transform: translateX(-50%); }
.hela-health-fill { position: absolute; inset: 0 auto 0 0; background: var(--hela-primary); transition: width 120ms linear; }
.hela-health-text { position: relative; mix-blend-mode: difference; }
.hela-ammo { position: absolute; right: 28px; bottom: 24px; font-size: 24px; font-weight: 700; }
.hela-custom { position: absolute; }
.hela-anchor-topLeft { left: var(--hela-offset-x); top: var(--hela-offset-y); }
.hela-anchor-topCenter { left: 50%; top: var(--hela-offset-y); transform: translateX(-50%); }
.hela-anchor-topRight { right: var(--hela-offset-x); top: var(--hela-offset-y); }
.hela-anchor-bottomLeft { left: var(--hela-offset-x); bottom: var(--hela-offset-y); }
.hela-anchor-bottomCenter { left: 50%; bottom: var(--hela-offset-y); transform: translateX(-50%); }
.hela-anchor-bottomRight { right: var(--hela-offset-x); bottom: var(--hela-offset-y); }
.hela-ui[data-panel="outline"] .hela-panel { background: transparent; border-width: 2px; }
.hela-ui[data-panel="glass"] .hela-panel { backdrop-filter: blur(14px) saturate(1.1); }
`;
  document.head.appendChild(style);
}
