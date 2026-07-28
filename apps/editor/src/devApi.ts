import { Vector3, type Camera } from 'three';
import type { LoadedScene, PlayerController } from '@helaengine/engine';
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
  /** World X of a node in the viewport — proves a transform edit reached Three.js, not just state. */
  viewportObjectWorldX(objectId: string): number | null;
  /** Whether a transform gizmo is currently attached in the scene. */
  hasGizmo(): boolean;
  /** World height of the live terrain at a world X/Z — proves a sculpt reached the geometry. */
  terrainHeightAt(x: number, z: number): number | null;
  /** Client-space coordinates of an object, for driving precise clicks in tests. */
  projectObject(objectId: string): { x: number; y: number } | null;
  /** Feet position of the Play Preview character, or null when not walking. */
  playerPosition(): { x: number; y: number; z: number } | null;
  /** Whether the character controller currently has ground under it. */
  playerGrounded(): boolean | null;
  /**
   * Points the walking player somewhere specific, in radians of yaw.
   *
   * Looking around is a pointer-lock gesture, and pointer lock is one of the handful of browser
   * APIs a headless run cannot drive. Without this, a test can only ever walk in whichever
   * direction the edit camera happened to be facing.
   */
  setPlayerYaw(yaw: number): boolean;
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

let currentPlayer: PlayerController | null = null;

/**
 * Records the Play Preview character.
 *
 * The whole Sprint 10 definition of done is about where a character ends up — on a hill rather
 * than through it, in front of a wall rather than inside it. That is a claim about the simulation,
 * not about the DOM, so the tests need a way to read it.
 */
export function setPlayer(player: PlayerController | null): void {
  currentPlayer = player;
}

let lookHandler: ((yaw: number) => void) | null = null;

/** Registered by the walk preview while it owns the camera. */
export function setLookHandler(handler: ((yaw: number) => void) | null): void {
  lookHandler = handler;
}

let currentCamera: Camera | null = null;

/** Records the viewport camera, so the dev API can project world points to screen coordinates. */
export function setCamera(camera: Camera | null): void {
  currentCamera = camera;
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

    viewportObjectWorldX: (objectId) =>
      currentLoadedScene?.objects.get(objectId)?.getWorldPosition(new Vector3()).x ?? null,

    hasGizmo: () =>
      currentLoadedScene?.threeScene.getObjectByName('gizmo-proxy') !== undefined ||
      currentLoadedScene?.threeScene.children.some((child) =>
        child.type.startsWith('TransformControls'),
      ) === true,

    terrainHeightAt: (x, z) => currentLoadedScene?.terrainField?.sampleHeight(x, z) ?? null,

    projectObject: (objectId) => {
      const node = currentLoadedScene?.objects.get(objectId);
      const canvas = document.querySelector('canvas');
      if (!node || !canvas || !currentCamera) return null;

      const rect = canvas.getBoundingClientRect();
      const point = node.getWorldPosition(new Vector3());
      // Aim a little above the origin: the pivot sits at an object's base, which projects onto the
      // ground rather than onto the object itself.
      point.y += 0.5;
      point.project(currentCamera);
      return {
        x: rect.left + ((point.x + 1) / 2) * rect.width,
        y: rect.top + ((1 - point.y) / 2) * rect.height,
      };
    },

    playerPosition: () => {
      if (!currentPlayer) return null;
      const { x, y, z } = currentPlayer.position;
      return { x, y, z };
    },

    playerGrounded: () => currentPlayer?.grounded ?? null,

    setPlayerYaw: (yaw) => {
      if (!lookHandler) return false;
      lookHandler(yaw);
      return true;
    },

    viewportObjects: () =>
      [...(currentLoadedScene?.objects.entries() ?? [])].map(([id, node]) => ({
        id,
        assetId: String(node.userData['assetId'] ?? ''),
        // Placeholders are a single bare Mesh; a loaded GLB always arrives as a group of parts.
        isModel: node.children.length > 0,
      })),
  };
}
