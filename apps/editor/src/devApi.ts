import type { LoadedScene } from '@helaengine/engine';
import { SceneObjectSchema, type Vec3 } from '@helaengine/schema';
import type { AssetLibrary } from './engine/assetLibrary';
import { nextObjectId, useSceneStore } from './store/sceneStore';

export interface DevApi {
  store: typeof useSceneStore;
  assetIds(): string[];
  addObject(assetId: string, position?: Vec3, rotationY?: number): string;
  clear(): void;
  /** Object ids currently instantiated in the Three.js scene, not merely present in the store. */
  viewportObjectIds(): string[];
  /** Per-object view of what the engine actually built, including whether a GLB or a placeholder. */
  viewportObjects(): Array<{ id: string; assetId: string; isModel: boolean }>;
}

declare global {
  interface Window {
    helaengine?: DevApi;
  }
}

let currentLoadedScene: LoadedScene | null = null;

/**
 * Records what the engine last put in the viewport.
 *
 * This is the difference between "the store says there is a hut" and "there is a hut in the scene
 * graph" — the only distinction that actually proves the bridge works, and the thing the e2e test
 * asserts on. Reading it from here beats reaching into react-three-fiber's internals, which are
 * private and change between versions.
 */
export function setLoadedScene(loaded: LoadedScene | null): void {
  currentLoadedScene = loaded;
}

/**
 * A console handle on the store, for driving the editor before there is any UI to drive it with.
 *
 * Zustand's devtools middleware already exposes the store to Redux DevTools; this adds the couple
 * of verbs that are tedious to express as raw actions. It exists so the viewport can be exercised
 * end to end while the asset panel (Sprint 4) and gizmos (Sprint 5) are still missing, and the
 * e2e smoke test drives the editor through it rather than through UI that does not exist yet.
 */
export function exposeDevApi(library: AssetLibrary): void {
  if (typeof window === 'undefined') return;

  window.helaengine = {
    store: useSceneStore,

    assetIds: () => library.manifest.assets.map((asset) => asset.id),

    addObject(assetId, position = [0, 0, 0], rotationY = 0) {
      const state = useSceneStore.getState();
      const id = nextObjectId(state.scene);

      // Validated on the way in, exactly like a real editor action would be — a dev shortcut that
      // could write a malformed document would be worse than no shortcut.
      state.addObject(
        SceneObjectSchema.parse({
          id,
          assetId,
          transform: { position, rotation: [0, rotationY, 0], scale: [1, 1, 1] },
        }),
      );
      return id;
    },

    clear() {
      const state = useSceneStore.getState();
      for (const object of [...state.scene.objects]) state.removeObject(object.id);
    },

    viewportObjectIds: () => [...(currentLoadedScene?.objects.keys() ?? [])],

    viewportObjects: () =>
      [...(currentLoadedScene?.objects.entries() ?? [])].map(([id, node]) => ({
        id,
        assetId: String(node.userData['assetId'] ?? ''),
        // Placeholders are a single bare Mesh; a loaded GLB always arrives as a group of parts.
        isModel: node.children.length > 0,
      })),
  };
}
