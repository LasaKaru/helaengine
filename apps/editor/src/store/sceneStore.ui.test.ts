import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyScene, useSceneStore } from './sceneStore';

const menu = () => useSceneStore.getState().scene.uiConfig.mainMenu.buttons;

describe('menu editing', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
  });

  it('starts with a Play button wired to starting the game', () => {
    expect(menu()[0]).toEqual({ label: 'Play', action: 'startGame' });
  });

  it('relabels and reassigns without disturbing the others', () => {
    useSceneStore.getState().setMenuButtons('mainMenu', [
      { label: 'Begin', action: 'startGame' },
      { label: 'Options', action: 'openSettings' },
    ]);

    expect(menu().map((button) => button.label)).toEqual(['Begin', 'Options']);
    expect(useSceneStore.getState().scene.uiConfig.pauseMenu.buttons.length).toBeGreaterThan(0);
  });

  it('reorders by one place at a time', () => {
    const before = menu().map((button) => button.label);
    useSceneStore.getState().moveMenuButton('mainMenu', 0, 1);

    expect(menu().map((button) => button.label)).toEqual([before[1], before[0]]);
  });

  it('refuses to move past either end rather than dropping a button', () => {
    const before = menu().map((button) => button.label);

    useSceneStore.getState().moveMenuButton('mainMenu', 0, -1);
    useSceneStore.getState().moveMenuButton('mainMenu', menu().length - 1, 1);

    expect(menu().map((button) => button.label)).toEqual(before);
  });

  it('is undoable, like every other document edit', () => {
    useSceneStore.getState().setMenuButtons('mainMenu', []);
    expect(menu()).toHaveLength(0);

    useSceneStore.getState().undo();
    expect(menu().length).toBeGreaterThan(0);
  });
});

describe('HUD element editing', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
  });

  it('starts empty', () => {
    expect(useSceneStore.getState().scene.uiConfig.hud.customElements).toEqual([]);
  });

  it('stores an element the schema accepts', () => {
    useSceneStore.getState().setHudElements([
      {
        id: 'hud_1',
        kind: 'text',
        value: 'Wave 1',
        bind: 'none',
        anchor: 'topCenter',
        offset: [0, 24],
        fontSize: 24,
      },
    ]);

    const [element] = useSceneStore.getState().scene.uiConfig.hud.customElements;
    expect(element).toMatchObject({ id: 'hud_1', bind: 'none', anchor: 'topCenter' });
  });

  it('survives a round trip through the document', () => {
    // The panel writes these and the renderer reads them out of a saved scene, so the thing that
    // actually has to hold is that the schema accepts what the editor produced.
    useSceneStore.getState().setHudElements([
      {
        id: 'clock',
        kind: 'text',
        value: '',
        bind: 'timer',
        anchor: 'topRight',
        offset: [16, 16],
        fontSize: 18,
      },
    ]);

    const json = JSON.stringify(useSceneStore.getState().scene);
    useSceneStore.getState().setScene(JSON.parse(json));

    expect(useSceneStore.getState().scene.uiConfig.hud.customElements[0]?.bind).toBe('timer');
  });
});
