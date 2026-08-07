import { Vector3, type Camera, type WebGLRenderer } from 'three';
import { biggestDropOff, funnelFrom, type FunnelRecord, type FunnelStep } from '@helaengine/schema';
import { currentSink, LocalAnalytics } from './telemetry/funnel';
import type {
  AudioSystem,
  CoopClient,
  GameRuntime,
  LoadedScene,
  PlayerController,
} from '@helaengine/engine';
import { SceneObjectSchema, type AssetManifestEntry, type Vec3 } from '@helaengine/schema';
import type { AssetLibrary } from './engine/assetLibrary';
import { collabPeers, collabStatus, currentSession } from './collab/current';
import { useEditorStore } from './store/editorStore';
import { useProjectStore } from './store/projectStore';
import { buildHelaFile } from './storage/helaFile';
import { nextObjectId, useSceneStore } from './store/sceneStore';

export interface DevApi {
  store: typeof useSceneStore;
  /** The funnel recorded in this browser, plus its drop-off table and worst step. */
  funnel(): {
    records: FunnelRecord[];
    steps: FunnelStep[];
    worst: FunnelStep | null;
  };
  assetIds(): string[];
  /**
   * One manifest entry, whole.
   *
   * `assetIds` answers "is it offered"; this answers "offered as *what*", which is the question an
   * uploaded asset raises — its `glbPath` is an absolute URL at the API rather than a path inside
   * the export's asset folder, and that difference is invisible until something tries to fetch it.
   */
  assetEntry(assetId: string): AssetManifestEntry | null;
  addObject(assetId: string, position?: Vec3, rotationY?: number): string;
  clear(): void;
  /** Object ids currently instantiated in the Three.js scene, not merely present in the store. */
  /** Hides the editor's own furniture before a screenshot. Reports what it actually hid. */
  hideEditorFurniture(): { gridHidden: boolean; triggersHidden: number };
  /** Whether the viewport is composing through the post-processing chain right now. */
  postProcessingActive(): boolean;
  /**
   * Whether the viewport's scene has any swaying materials.
   *
   * Reported by the loader rather than read off the document, because the two can legitimately
   * differ: a wind blowing over a level with nothing but rocks in it patches nothing, and the right
   * answer there is "no wind" — a test reading `environment.wind.strength` would call that a bug.
   */
  windActive(): boolean;
  /** Scattered instances the loader actually grew, across every layer. */
  scatterCount(): number;
  viewportObjectIds(): string[];
  /** Per-object view of what the engine actually built, including whether a GLB or a placeholder. */
  viewportObjects(): Array<{ id: string; assetId: string; isModel: boolean }>;
  /** World X of a node in the viewport — proves a transform edit reached Three.js, not just state. */
  viewportObjectWorldX(objectId: string): number | null;
  /**
   * The colours a placed object is actually drawn with, as hex without the `#`.
   *
   * Reads the scene graph rather than the document, because a material override's whole risk is
   * that it reaches the *wrong* objects: materials are shared across every clone of a model, so the
   * document can say one thing and three other objects can have changed colour.
   */
  objectMaterialColors(objectId: string): string[];
  /**
   * Where a node actually is right now.
   *
   * The document position is where an object was *placed*; once the scene is running, anything with
   * a behaviour has moved. A test that aims at a chasing enemy has to ask the scene graph.
   */
  viewportObjectPosition(objectId: string): { x: number; y: number; z: number } | null;
  /**
   * Puts the edit camera exactly somewhere.
   *
   * The visual-regression suite reads an export's own camera pose and applies it here, so the
   * comparison is of what is *in* the world rather than of two cameras that happen to be
   * configured differently.
   */
  setCameraPose(position: [number, number, number], target: [number, number, number]): boolean;
  /** Whether a transform gizmo is currently attached in the scene. */
  hasGizmo(): boolean;
  /**
   * The collaborative session, or null when this tab is editing alone.
   *
   * `peers` is everybody else in the room — this seat excluded — which is what the top bar draws
   * and what the viewport highlights. A test asserting on it is asserting on the same data the UI
   * renders, rather than on a parallel bookkeeping the UI might disagree with.
   */
  collab(): {
    status: string;
    peers: Array<{ userId: string; displayName: string; selection: string[]; editing: boolean }>;
    canUndo: boolean;
  } | null;
  /**
   * The bytes of a `.hela` file for the open project.
   *
   * Exposed because a native save dialog is one of the handful of browser APIs a headless run
   * cannot drive. The container itself is what matters and this is the same function the Save-to-
   * file button calls, so a test carrying these bytes to another context is exercising the real
   * path rather than a parallel one.
   */
  buildProjectFile(): Promise<Uint8Array>;
  /** Opens `.hela` bytes as a new project, exactly as a drop on the projects screen would. */
  importProjectFile(bytes: Uint8Array): Promise<void>;
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
  /**
   * What the audio system is doing, or null when nothing is playing.
   *
   * Headless Chromium has no output device, so no test can assert that a sound was *heard*. What it
   * can assert is that the right track was selected, the state machine moved, and the mixer took
   * the value — which is the whole of the wiring and the only part a regression would break.
   */
  audioState(): {
    musicState: string | null;
    inCombat: boolean;
    mixer: { master: number; music: number; sfx: number };
  } | null;
  /**
   * The co-op session, or null when the scene is single-player.
   *
   * `players` is everyone the server says is present, this client included — which is what a test
   * needs to assert that two browsers really are in the same world.
   */
  coopState(): {
    status: string;
    sessionId: string;
    error: string | null;
    players: Array<{ sessionId: string; name: string; x: number; z: number }>;
  } | null;
  /** Object id of the checkpoint the player currently holds, or null. */
  currentCheckpoint(): string | null;
  /** Seconds of play the runtime has counted, or null. */
  playSeconds(): number | null;
  /** Secrets found so far, or null when nothing is playing. */
  unlockedSecrets(): string[] | null;
  /** Whether a node is currently visible — how a revealed area is asserted on. */
  objectVisible(objectId: string): boolean | null;
  /** Ids the running preview spawned — none of which are in the document. */
  spawnedIds(): string[];
  /** FSM state of every enemy behaviour currently running, keyed by object id. */
  enemyStates(): Record<string, string>;
  /** Raises an event on the running world's bus, the way a weapon or a script would. */
  emit(event: string, payload?: unknown): boolean;
  /**
   * A graph variable's current value in the running preview, or null when no graph is running.
   *
   * The only externally visible proof that the graph *executed*. Everything else a graph does — a
   * spawn, a message, some damage — is also reachable by a trigger or a behaviour, so asserting on
   * one of those would not distinguish "the graph ran" from "something else did".
   */
  graphVariable(name: string): number | boolean | string | null;
  /** Problems the running graph was started with, as `severity: message`. Empty when clean. */
  graphProblems(): string[];
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

/**
 * The running preview, for code inside the editor rather than for tests.
 *
 * The pre-export validation gate needs the same two facts the dev API exposes — where the player is
 * and how much health they have — and reaching them through `window.helaengine` would make a
 * shipped feature depend on a debugging surface. These are the same values, named as app code.
 */
export function livePlayerPosition(): [number, number, number] | null {
  if (!currentPlayer) return null;
  const { x, y, z } = currentPlayer.position;
  return [x, y, z];
}

export function livePlayerHealth(): number | null {
  return currentGame?.playerHealth() ?? null;
}

let cameraPoseHandler:
  ((position: [number, number, number], target: [number, number, number]) => void) | null = null;

/** Registered by the viewport, which owns the camera the editor draws with. */
export function setCameraPoseHandler(
  handler: ((position: [number, number, number], target: [number, number, number]) => void) | null,
): void {
  cameraPoseHandler = handler;
}

/**
 * Whether the viewport is drawing through the post-processing chain.
 *
 * Reported rather than inferred from the document, because the two can legitimately differ: a
 * scene can have `postProcessing.enabled` with every effect switched off, and the right answer
 * then is *no chain at all* — nobody should pay for a render target and two full-screen passes
 * that change nothing. A test that read the document would call that a bug.
 */
let postProcessingActive = false;

let windActive = false;
let scatterCount = 0;

/** Registered by the bridge when a scene is loaded, so a test can see what the loader decided. */
export function setWindActive(active: boolean): void {
  windActive = active;
}

export function setScatterCount(count: number): void {
  scatterCount = count;
}

export function setPostProcessingActive(active: boolean): void {
  postProcessingActive = active;
}

let currentAudio: AudioSystem | null = null;

/** Records the running audio system, so tests can read what it decided to play. */
export function setAudioSystem(audio: AudioSystem | null): void {
  currentAudio = audio;
}

let currentCoop: CoopClient | null = null;

/** Records the co-op client, so a test can read the session without a second browser. */
export function setCoopClient(client: CoopClient | null): void {
  currentCoop = client;
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

    /**
     * The funnel this browser has recorded, and the drop-off table computed from it.
     *
     * Exposed because there is no analytics vendor here and a funnel nobody can look at is a claim
     * rather than a feature. Reads the local sink; returns an empty table under any other sink.
     */
    funnel: () => {
      const sink = currentSink();
      const records = sink instanceof LocalAnalytics ? sink.all() : [];
      const steps = funnelFrom(records);
      return { records, steps, worst: biggestDropOff(steps) };
    },

    assetIds: () => library.manifest.assets.map((asset) => asset.id),

    assetEntry: (assetId) => library.manifest.assets.find((asset) => asset.id === assetId) ?? null,

    buildProjectFile: () => buildHelaFile({ scene: useSceneStore.getState().scene }),

    importProjectFile: (bytes) => useProjectStore.getState().importFile(bytes),

    collab: () => {
      const session = currentSession();
      if (!session) return null;
      return {
        status: collabStatus(),
        peers: collabPeers().map((peer) => ({
          userId: peer.userId,
          displayName: peer.displayName,
          selection: peer.selection,
          editing: peer.editing,
        })),
        canUndo: session.canUndo(),
      };
    },

    postProcessingActive: () => postProcessingActive,

    windActive: () => windActive,

    scatterCount: () => scatterCount,

    objectMaterialColors(objectId) {
      const node = currentLoadedScene?.objects.get(objectId);
      const colors: string[] = [];
      node?.traverse((object) => {
        const mesh = object as { isMesh?: boolean; material?: unknown };
        if (!mesh.isMesh) return;
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
          const color = (material as { color?: { getHexString(): string } }).color;
          if (color) colors.push(color.getHexString());
        }
      });
      return colors;
    },

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

    /**
     * Hides the editor's own furniture inside the 3D scene.
     *
     * DOM overlays can be hidden with a stylesheet; the reference grid cannot, because it is a mesh
     * in the scene graph. The export QA suite screenshots the editor and an export of the same
     * scene and expects them to match — and an editor that draws a 200×200 grid the export
     * correctly omits fails that comparison at around 8% of pixels on an empty level, which is a
     * test comparing two things that are supposed to differ rather than a rendering bug.
     */
    hideEditorFurniture: () => {
      // The grid is React's to draw, so it is React that stops drawing it. The first version looked
      // the mesh up by name; drei's `<Grid>` does not forward one, so it hid nothing and reported
      // success — which survived a sixteen-minute run and a confident claim that it was fixed.
      useEditorStore.getState().setFurnitureHidden(true);

      /**
       * Trigger volumes, which are ours and therefore findable.
       *
       * A trigger is a yellow wireframe the editor draws so you can see where the volume is, and an
       * export never renders one — `PhysicsPreview` already hides them when play starts, for
       * exactly this reason.
       */
      let hidden = 0;
      for (const node of currentLoadedScene?.objects.values() ?? []) {
        if (node.userData['isTrigger']) {
          node.visible = false;
          hidden += 1;
        }
      }

      return { gridHidden: true, triggersHidden: hidden };
    },

    viewportObjectIds: () => [...(currentLoadedScene?.objects.keys() ?? [])],

    viewportObjectWorldX: (objectId) =>
      currentLoadedScene?.objects.get(objectId)?.getWorldPosition(new Vector3()).x ?? null,

    setCameraPose: (position, target) => {
      if (!cameraPoseHandler) return false;
      cameraPoseHandler(position, target);
      return true;
    },

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

    audioState: () =>
      currentAudio
        ? {
            musicState: currentAudio.music.state,
            inCombat: currentAudio.inCombat,
            mixer: { ...currentAudio.mixer },
          }
        : null,

    coopState: () =>
      currentCoop
        ? {
            status: currentCoop.status,
            sessionId: currentCoop.sessionId,
            error: currentCoop.error,
            players: currentCoop.players.map((player) => ({
              sessionId: player.sessionId,
              name: player.name,
              x: Number(player.x.toFixed(2)),
              z: Number(player.z.toFixed(2)),
            })),
          }
        : null,

    currentCheckpoint: () => currentGame?.checkpointId ?? null,

    playSeconds: () => currentGame?.elapsedSeconds ?? null,

    unlockedSecrets: () => currentGame?.unlocks.unlockedIds ?? null,

    objectVisible: (objectId) => currentLoadedScene?.objects.get(objectId)?.visible ?? null,

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

    graphVariable: (name) => currentGame?.graph?.variable(name) ?? null,

    graphProblems: () =>
      (currentGame?.graph?.problems ?? []).map(
        (problem) => `${problem.severity}: ${problem.message}`,
      ),

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
