// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UiConfigSchema, type UiAction, type UiConfig } from '@helaengine/schema';
import { THEME_PRESETS, themeVariables } from './theme.js';
import { UIRenderer } from './UIRenderer.js';

function config(overrides: Record<string, unknown> = {}): UiConfig {
  return UiConfigSchema.parse(overrides);
}

function mount(
  overrides: Record<string, unknown> = {},
  options: {
    onAction?: (action: UiAction) => void;
    resolveAsset?: (id: string) => string | null;
  } = {},
): { ui: UIRenderer; container: HTMLElement } {
  const container = document.createElement('div');
  container.style.position = 'relative';
  document.body.appendChild(container);

  const ui = new UIRenderer({
    container,
    config: config(overrides),
    ...(options.onAction ? { onAction: options.onAction } : {}),
    ...(options.resolveAsset ? { resolveAsset: options.resolveAsset } : {}),
  });
  ui.mount();
  return { ui, container };
}

function click(container: HTMLElement, label: string): void {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) throw new Error(`no button labelled "${label}"`);
  button.click();
}

describe('UIRenderer', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    document.getElementById('hela-ui-styles')?.remove();
  });

  it('opens on the home screen and shows the title from the document', () => {
    const { ui, container } = mount({ homeScreen: { title: 'Goblin Valley', subtitle: 'A demo' } });

    expect(ui.screen).toBe('home');
    expect(container.querySelector('.hela-title')?.textContent).toBe('Goblin Valley');
    expect(container.querySelector('.hela-subtitle')?.textContent).toBe('A demo');
  });

  it('runs the whole loop: home, play, pause, resume', () => {
    const actions: UiAction[] = [];
    const { ui, container } = mount({}, { onAction: (action) => actions.push(action) });

    click(container, 'Play');
    expect(ui.screen).toBe('playing');

    ui.togglePause();
    expect(ui.screen).toBe('paused');
    expect(container.querySelector('.hela-heading')?.textContent).toBe('Paused');

    click(container, 'Resume');
    expect(ui.screen).toBe('playing');
    expect(actions).toEqual(['startGame', 'resume']);
  });

  it('tells the host what happened as well as changing screen', () => {
    // The renderer knows `resume` means "show the world"; only the host knows it also means
    // "start stepping physics again". Both halves have to fire.
    const actions: UiAction[] = [];
    const { container } = mount({}, { onAction: (action) => actions.push(action) });

    click(container, 'Play');
    expect(actions).toEqual(['startGame']);
  });

  it('reports quit without pretending to know what quitting means', () => {
    const actions: UiAction[] = [];
    const { ui, container } = mount({}, { onAction: (action) => actions.push(action) });

    click(container, 'Play');
    ui.togglePause();
    click(container, 'Quit');

    expect(actions).toContain('quit');
    // Still on the pause menu: where "quit" goes is the host's call, not the renderer's.
    expect(ui.screen).toBe('paused');
  });

  it('returns from settings to whichever screen opened it', () => {
    const { ui, container } = mount();

    click(container, 'Settings');
    expect(ui.screen).toBe('settings');
    click(container, 'Back');
    expect(ui.screen).toBe('home');

    click(container, 'Play');
    ui.togglePause();
    click(container, 'Settings');
    click(container, 'Back');

    expect(ui.screen).toBe('paused');
  });

  it('builds the menu the document describes, in order', () => {
    const { ui, container } = mount({
      mainMenu: {
        buttons: [
          { label: 'Begin', action: 'startGame' },
          { label: 'Options', action: 'openSettings' },
        ],
      },
    });

    ui.setScreen('mainMenu');

    const labels = [...container.querySelectorAll('.hela-panel button')].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(['Begin', 'Options']);
  });

  it('says so rather than rendering an empty panel when a menu has no buttons', () => {
    const { ui, container } = mount({ mainMenu: { buttons: [] } });
    ui.setScreen('mainMenu');

    expect(container.textContent).toContain('No buttons configured');
  });

  it('shows the HUD only while playing', () => {
    const { ui, container } = mount();
    expect(container.querySelector('.hela-hud')).toBeNull();

    ui.setScreen('playing');
    expect(container.querySelector('.hela-hud')).not.toBeNull();
    expect(container.querySelector('.hela-crosshair')).not.toBeNull();
  });

  it('paints health without rebuilding the HUD', () => {
    const { ui, container } = mount();
    ui.setScreen('playing');
    const hud = container.querySelector('.hela-hud');

    ui.setHud({ health: 45, maxHealth: 100 });

    expect(container.querySelector('.hela-health-text')?.textContent).toBe('45 HP');
    expect(container.querySelector<HTMLElement>('.hela-health-fill')?.style.width).toBe('45%');
    // The same node: a HUD that re-created its DOM every frame would be the most expensive thing
    // in the engine.
    expect(container.querySelector('.hela-hud')).toBe(hud);
  });

  it('reads "Down" rather than a negative number at zero health', () => {
    const { ui, container } = mount();
    ui.setScreen('playing');
    ui.setHud({ health: 0 });

    expect(container.querySelector('.hela-health-text')?.textContent).toBe('Down');
  });

  it('honours HUD toggles', () => {
    const { ui, container } = mount({
      hud: { showCrosshair: false, showHealthBar: false, showAmmoCounter: true },
    });
    ui.setScreen('playing');

    expect(container.querySelector('.hela-crosshair')).toBeNull();
    expect(container.querySelector('.hela-health')).toBeNull();
    expect(container.querySelector('.hela-ammo')).not.toBeNull();
  });

  it('binds a custom HUD element to a runtime value', () => {
    const { ui, container } = mount({
      hud: {
        customElements: [
          { id: 'clock', kind: 'text', bind: 'timer', anchor: 'topRight', fontSize: 20 },
        ],
      },
    });
    ui.setScreen('playing');
    ui.setHud({ timer: 125 });

    const node = container.querySelector<HTMLElement>('[data-element-id="clock"]');
    expect(node?.textContent).toBe('02:05');
    expect(node?.className).toContain('hela-anchor-topRight');
  });

  it('shows literal text for an unbound element', () => {
    const { ui, container } = mount({
      hud: { customElements: [{ id: 'label', kind: 'text', value: 'Level 1' }] },
    });
    ui.setScreen('playing');

    expect(container.querySelector('[data-element-id="label"]')?.textContent).toBe('Level 1');
  });

  it('applies the theme as custom properties, so one swap restyles everything', () => {
    const { ui } = mount({ theme: { preset: 'neon' } });
    const neon = ui.root.style.getPropertyValue('--hela-primary');

    ui.setConfig(config({ theme: { preset: 'parchment' } }));

    expect(ui.root.style.getPropertyValue('--hela-primary')).not.toBe(neon);
    expect(ui.root.dataset['panel']).toBe('glass');
  });

  it('lets a document override the accent without abandoning the preset', () => {
    const { ui } = mount({ theme: { preset: 'midnight', primaryColor: '#ff0000' } });
    expect(ui.root.style.getPropertyValue('--hela-primary')).toBe('#ff0000');
    expect(ui.root.style.getPropertyValue('--hela-text')).not.toBe('');
  });

  it('renders nothing at all when the shell is switched off', () => {
    const { ui, container } = mount({ enabled: false });
    expect(container.querySelector('.hela-screen')).toBeNull();

    ui.setScreen('playing');
    expect(container.querySelector('.hela-hud')).toBeNull();
  });

  it('skips an intro whose video cannot be resolved rather than showing a black screen', () => {
    const { ui } = mount(
      { homeScreen: { introVideoAssetId: 'vid_missing' } },
      { resolveAsset: () => null },
    );

    expect(ui.screen).toBe('home');
  });

  it('plays an intro when there is one, and skips on demand', () => {
    // jsdom has no media stack, so `play()` is stubbed; what is under test is the wiring.
    const play = vi.fn(() => Promise.resolve());
    Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });

    const { ui, container } = mount(
      { homeScreen: { introVideoAssetId: 'vid_intro' } },
      { resolveAsset: () => 'blob:intro' },
    );

    expect(ui.screen).toBe('intro');
    expect(container.querySelector('video')?.muted).toBe(true);
    expect(play).toHaveBeenCalled();

    click(container, 'Skip');
    expect(ui.screen).toBe('home');
    expect(container.querySelector('video')).toBeNull();
  });

  it('leaves nothing behind when unmounted', () => {
    const { ui, container } = mount();
    ui.unmount();

    expect(container.children).toHaveLength(0);
    expect(ui.mounted).toBe(false);
  });

  it('injects its stylesheet exactly once', () => {
    mount();
    mount();
    expect(document.querySelectorAll('#hela-ui-styles')).toHaveLength(1);
  });
});

describe('themes', () => {
  it('ships four presets, each with a full set of tokens', () => {
    expect(THEME_PRESETS).toHaveLength(4);

    for (const preset of THEME_PRESETS) {
      const variables = themeVariables({ preset, panelStyle: 'glass' });
      for (const token of [
        '--hela-bg',
        '--hela-panel',
        '--hela-text',
        '--hela-primary',
        '--hela-font',
      ]) {
        expect(variables[token], `${preset} ${token}`).toBeTruthy();
      }
    }
  });
});
