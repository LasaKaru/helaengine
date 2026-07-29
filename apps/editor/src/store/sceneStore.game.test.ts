import { beforeEach, describe, expect, it } from 'vitest';
import { createEmptyScene, useSceneStore } from './sceneStore';

describe('game config', () => {
  beforeEach(() => {
    useSceneStore.setState({ scene: createEmptyScene(), selectedIds: [] });
  });

  it('starts in first person with switching allowed', () => {
    const { gameConfig } = useSceneStore.getState().scene;
    expect(gameConfig).toMatchObject({
      cameraMode: 'fps',
      allowModeSwitch: true,
      headBob: true,
      fieldOfView: 70,
    });
  });

  it('changes camera mode without disturbing the rest', () => {
    useSceneStore.getState().setGameConfig({ cameraMode: 'tps' });

    const { gameConfig } = useSceneStore.getState().scene;
    expect(gameConfig.cameraMode).toBe('tps');
    expect(gameConfig.fieldOfView).toBe(70);
  });

  it('is undoable like every other document edit', () => {
    useSceneStore.getState().setGameConfig({ cameraMode: 'topdown' });
    useSceneStore.getState().setGameConfig({ fieldOfView: 95 });

    useSceneStore.getState().undo();

    expect(useSceneStore.getState().scene.gameConfig.fieldOfView).toBe(70);
    expect(useSceneStore.getState().scene.gameConfig.cameraMode).toBe('topdown');
  });

  it('keeps multiplayer off by default — it is a whole separate runtime', () => {
    expect(useSceneStore.getState().scene.gameConfig.multiplayer).toMatchObject({
      enabled: false,
      mode: 'none',
    });
  });
});
