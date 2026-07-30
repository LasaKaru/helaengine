import { Vector3, type Camera, type WebGLRenderer } from 'three';
import type { GameRuntime, LoadedScene, PlayerController } from '@helaengine/engine';
import { SceneObjectSchema, type Vec3 } from '@helaengine/schema';
import type { AssetLibrary } from './engine/assetLibrary';
import { useEditorStore } from './store/editorStore';
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
  /**
   * Where a node actually is right now.
   *
   * The document position is where an object was *placed*; once the scene is running, anything with
   * a behaviour has moved. A test that aims at a chasing enemy has to ask the scene graph.
   */
  viewportObjectPosition(objectId: string): { x: number; y: number; z: number } | null;
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
  /**
   * Points the player, including up and down.
   *
   * Pitch matters more than it looks like it should. The player's eye sits at 1.65m and a goblin
   * capsule is 1.70m tall, so a perfectly level shot grazes the tapering top of the capsule and
   * misses — a real player aims at the chest without thinking about it, and a test has to as well.
   */
  setPlayerLook(yaw: number, pitch: number): boolean;
  /** Player health while walking, or null. */
  playerHealth(): number | null;
  /** Camera rig currently driving the view, or null when not walking. */
  cameraMode(): string | null;
  /** Which shell screen is showing, or null when the game shell is not mounted. */
  uiScreen(): string | null;
  /** Whether the player is crouched, and how fast they are moving. */
  playerMotion(): { speed: number; crouched: boolean; grounded: boolean } | null;
  /**
   * Where the camera actually is.
   *
   * The camera rigs are the whole deliverable of Sprint 13 and every claim about them — eye height,
   * arm length, overhead distance — is a claim about this, not about the DOM.
   */
  cameraPose(): { position: [number, number, number]; fov: number } | null;
  /**
   * What the player is carrying, or null when nothing is playing.
   *
   * Combat is a claim about state — this many rounds, that weapon held, this much health — and none
   * of it is visible in the DOM beyond a HUD that rounds and formats it. Reading it directly is
   * what lets a test assert that a shot actually cost a round.
   */
  playerInventory(): {
    weaponId: string | null;
    ammo: number | null;
    reserve: number;
    carried: string[];
    shotsFired: number;
  } | null;
  /** Ids the running preview spawned — none of which are in the document. */
  spawnedIds(): string[];
  /** FSM state of every enemy behaviour currently running, keyed by object id. */
  enemyStates(): Record<string, string>;
  /** Raises an event on the running world's bus, the way a weapon or a script would. */
  emit(event: string, payload?: unknown): boolean;
  /**
   * Hurts the player, the way an enemy's swing does.
   *
   * Getting a headless browser into a real fight is slow and flaky — it depends on two goblins
   * finding the player and on their attack intervals lining up. Damage is a runtime path, not a
   * pathfinding one, so a test drives it directly and asserts on what the runtime does about it.
   */
  damagePlayer(amount: number): boolean;
  /**
   * What the renderer actually did on the last frame.
   *
   * Draw calls are the number the performance work is really about, and unlike a frame rate they
   * are the same on every machine — which is what makes them worth asserting on.
   */
  /**
   * Rolling average of what the simulation costs on the CPU, in milliseconds per frame.
   *
   * Unlike a frame rate this is not at the mercy of the GPU, so it is comparable between a laptop
   * and a CI container — which makes it the half of the performance story worth regression-testing.
   */
  simulationStats(): {
    physicsMs: number;
    gameplayMs: number;
    peakMs: number;
    frames: number;
  } | null;
  renderStats(): {
    calls: number;
    triangles: number;
    instancedObjects: number;
    sceneObjects: number;
    pooledNodes: number;
  } | null;
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

let currentGame: GameRuntime | null = null;

/** Records the running game runtime, so tests can read AI state and raise events. */
export function setGameRuntime(runtime: GameRuntime | null): void {
  currentGame = runtime;
}

let lookHandler: ((yaw: number, pitch?: number) => void) | null = null;

/** Registered by the walk preview while it owns the camera. */
export function setLookHandler(handler: ((yaw: number, pitch?: number) => void) | null): void {
  lookHandler = handler;
}

const timing = { physicsMs: 0, gameplayMs: 0, peakMs: 0, frames: 0, seen: 0 };

/**
 * Frames ignored before the average starts.
 *
 * The first steps of a simulation are not representative of any of the ones after them: Rapier
 * builds its broad phase, every enemy runs its first line-of-sight trace at once, and the JIT has
 * seen none of it yet. Averaging those in reports a per-frame cost the game never actually pays.
 * `peakMs` still records them, so a genuine spike is not hidden by this.
 */
const WARMUP_FRAMES = 10;

/**
 * Folds one frame's simulation cost into a rolling average.
 *
 * An exponential average rather than a full history: it needs to be readable at any moment without
 * the caller having to say when to start, and a per-frame array would be its own allocation
 * problem in exactly the code being measured.
 */
export function recordSimulationTiming(physicsMs: number, gameplayMs: number): void {
  timing.seen += 1;
  timing.peakMs = Math.max(timing.peakMs, physicsMs + gameplayMs);
  if (timing.seen <= WARMUP_FRAMES) return;

  const weight = timing.frames === 0 ? 1 : 0.05;
  timing.physicsMs += (physicsMs - timing.physicsMs) * weight;
  timing.gameplayMs += (gameplayMs - timing.gameplayMs) * weight;
  timing.frames += 1;
}

/** Forgets the timings, so a new run does not average against the last one. */
export function resetSimulationTiming(): void {
  timing.physicsMs = 0;
  timing.gameplayMs = 0;
  timing.peakMs = 0;
  timing.frames = 0;
  timing.seen = 0;
}

let currentRenderer: WebGLRenderer | null = null;

/** Records the renderer, so the dev API can report what it drew. */
export function setRenderer(renderer: WebGLRenderer | null): void {
  currentRenderer = renderer;
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

    viewportObjectPosition: (objectId) => {
      const node = currentLoadedScene?.objects.get(objectId);
      if (!node) return null;
      const { x, y, z } = node.getWorldPosition(new Vector3());
      return { x, y, z };
    },

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

    setPlayerLook: (yaw, pitch) => {
      if (!lookHandler) return false;
      lookHandler(yaw, pitch);
      return true;
    },

    playerHealth: () => currentGame?.playerHealth() ?? null,

    cameraMode: () => useEditorStore.getState().cameraMode,

    uiScreen: () => useEditorStore.getState().uiScreen,

    cameraPose: () =>
      currentCamera
        ? {
            position: currentCamera.position.toArray() as [number, number, number],
            fov: (currentCamera as { fov?: number }).fov ?? 0,
          }
        : null,

    playerMotion: () =>
      currentPlayer
        ? {
            speed: Number(currentPlayer.speed.toFixed(3)),
            crouched: currentPlayer.crouched,
            grounded: currentPlayer.grounded,
          }
        : null,

    damagePlayer: (amount) => {
      if (!currentGame) return false;
      currentGame.damagePlayer(amount);
      return true;
    },

    playerInventory: () => {
      if (!currentGame) return null;
      const { inventory, weapons } = currentGame;
      return {
        weaponId: inventory.current?.weapon.id ?? null,
        ammo: inventory.ammo,
        reserve: inventory.reserve,
        carried: inventory.carried.map((entry) => entry.weapon.id),
        shotsFired: weapons.shotsFired,
      };
    },

    spawnedIds: () => [...(currentGame?.spawnedIds ?? [])],

    enemyStates: () => {
      const states: Record<string, string> = {};
      if (!currentGame) return states;

      for (const objectId of currentLoadedScene?.objects.keys() ?? []) {
        for (const behavior of currentGame.behaviors.behaviorsFor(objectId)) {
          const state = (behavior as { state?: string | null }).state;
          if (typeof state === 'string') states[objectId] = state;
        }
      }
      return states;
    },

    emit: (event, payload) => {
      if (!currentGame) return false;
      currentGame.emit(event, payload);
      return true;
    },

    simulationStats: () =>
      timing.frames === 0
        ? null
        : {
            physicsMs: Number(timing.physicsMs.toFixed(3)),
            gameplayMs: Number(timing.gameplayMs.toFixed(3)),
            peakMs: Number(timing.peakMs.toFixed(3)),
            frames: timing.frames,
          },

    renderStats: () => {
      if (!currentRenderer) return null;
      const { render } = currentRenderer.info;
      return {
        calls: render.calls,
        triangles: render.triangles,
        instancedObjects: currentLoadedScene?.instances?.instancedObjectIds.length ?? 0,
        sceneObjects: currentLoadedScene?.objects.size ?? 0,
        pooledNodes: library.loader.pooledCount(),
      };
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
