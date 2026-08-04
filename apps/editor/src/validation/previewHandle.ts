import type { Scene } from '@helaengine/schema';
import { useEditorStore } from '../store/editorStore';
import { livePlayerHealth, livePlayerPosition } from '../devApi';
import type { PreviewHandle } from './validateScene';

/**
 * Drives the editor's real Play Preview so the gate can watch it.
 *
 * Deliberately the *real* preview rather than a headless simulation of one. A validation step that
 * runs its own private copy of the world is a validation step that can pass while the thing users
 * press Play on fails — the two would drift, and the drift would be invisible until somebody
 * reported it. This starts the same preview the Walk button starts, and reads the same runtime.
 *
 * Input is dispatched as real keyboard events, for the same reason: the character controller is
 * driven by `InputManager`, and calling into the controller directly would skip the layer where
 * "held forward" actually means something.
 */
export function createPreviewHandle(): PreviewHandle {
  const errors: string[] = [];
  const failedAssets: string[] = [];

  const originalError = console.error;
  let listening = false;

  const listen = (): void => {
    if (listening) return;
    listening = true;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((arg) => String(arg)).join(' '));
      originalError(...args);
    };
  };

  const release = (): void => {
    if (!listening) return;
    listening = false;
    console.error = originalError;
  };

  const key = (type: 'keydown' | 'keyup', code: string): void => {
    window.dispatchEvent(new KeyboardEvent(type, { code, key: 'w', bubbles: true }));
  };

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => window.setTimeout(resolve, ms));

  /** Polls a predicate rather than waiting a fixed time. Physics is WASM and its load is not fixed. */
  const until = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await wait(100);
    }
    return predicate();
  };

  return {
    async start(_scene: Scene) {
      listen();
      errors.length = 0;
      failedAssets.length = 0;

      const store = useEditorStore.getState();
      store.setWalking(true);

      const settled = await until(() => {
        const status = useEditorStore.getState().physicsStatus;
        return status === 'ready' || status === 'error';
      }, 30_000);

      const status = useEditorStore.getState().physicsStatus;
      // A player object is the honest signal that the world is up: physics can report ready a frame
      // before the controller exists, and a check that ran in that gap would measure nothing.
      const hasPlayer = await until(() => livePlayerPosition() !== null, 10_000);

      return {
        sceneReady: settled && status !== 'error',
        physicsReady: status === 'ready' && hasPlayer,
      };
    },

    async stop() {
      useEditorStore.getState().setWalking(false);
      release();
      await wait(200);
    },

    position: () => livePlayerPosition(),
    health: () => livePlayerHealth(),

    async walkForward(ms: number) {
      key('keydown', 'KeyW');
      await wait(ms);
      key('keyup', 'KeyW');
      // One more frame, so the last step of movement lands before anything reads the position.
      await wait(120);
    },

    wait,
    errors: () => [...errors],
    failedAssets: () => [...failedAssets],
    heap: () => {
      const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      return memory ? memory.usedJSHeapSize : null;
    },
  };
}
