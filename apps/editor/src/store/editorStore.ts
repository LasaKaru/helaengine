import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { DEFAULT_PLACEMENT, type PlacementOptions } from '../placement';
import type { SculptMode } from '@helaengine/engine';
import type { GizmoMode } from '../transform';

/** Where the asynchronous Rapier bootstrap has got to. */
export type PhysicsStatus = 'idle' | 'loading' | 'ready' | 'error';

/** What a pointer drag on the terrain does. */
export type EditorTool = 'select' | 'sculpt' | 'paint';

export interface BrushSettings {
  radius: number;
  strength: number;
  sculptMode: SculptMode;
  /** Index into the terrain's four blend layers. */
  layer: number;
}

export const DEFAULT_BRUSH: BrushSettings = {
  radius: 8,
  strength: 0.35,
  sculptMode: 'raise',
  layer: 1,
};

export interface DragState {
  assetId: string;
  /** Latest pointer position in client coordinates, for the DOM drag chip. */
  clientX: number;
  clientY: number;
  /** True once the pointer is over the viewport and the ghost has a surface to sit on. */
  overSurface: boolean;
}

export interface Marquee {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Editor-only state: what the user is dragging, how placement should behave, which panel is open.
 *
 * Kept separate from `sceneStore` on purpose. That store is the scene document and everything in
 * it gets saved and exported; none of this does. Mixing them is how "hidden state" creeps into a
 * schema-driven editor.
 */
export interface EditorState {
  drag: DragState | null;
  placement: PlacementOptions;
  assetSearch: string;
  assetCategory: string | null;
  tool: EditorTool;
  brush: BrushSettings;
  gizmoMode: GizmoMode;
  /** True while a gizmo drag owns the pointer, so selection and orbit stay out of the way. */
  gizmoActive: boolean;
  marquee: Marquee | null;
  shortcutsOpen: boolean;
  /** True while behaviours are running in the viewport. */
  playing: boolean;
  /** True while the viewport is in Play Preview: physics on, camera driven by the player. */
  walking: boolean;
  /** Rapier is WASM and loads asynchronously; the Walk button reflects this. */
  physicsStatus: PhysicsStatus;
  /** Player health while walking, mirrored out of the runtime so the HUD can render it. */
  playerHealth: number | null;
  /** `objectId:index` of the behaviour whose waypoints are being edited, if any. */
  editingWaypoints: string | null;

  beginDrag(assetId: string, clientX: number, clientY: number): void;
  updateDrag(clientX: number, clientY: number, overSurface: boolean): void;
  endDrag(): void;
  setPlacement(placement: Partial<PlacementOptions>): void;
  setAssetSearch(search: string): void;
  setAssetCategory(category: string | null): void;
  setTool(tool: EditorTool): void;
  setBrush(brush: Partial<BrushSettings>): void;
  setGizmoMode(mode: GizmoMode): void;
  setGizmoActive(active: boolean): void;
  setMarquee(marquee: Marquee | null): void;
  setShortcutsOpen(open: boolean): void;
  setPlaying(playing: boolean): void;
  setWalking(walking: boolean): void;
  setPhysicsStatus(status: PhysicsStatus): void;
  setPlayerHealth(health: number | null): void;
  setEditingWaypoints(key: string | null): void;
}

export const useEditorStore = create<EditorState>()(
  devtools(
    (set) => ({
      drag: null,
      placement: DEFAULT_PLACEMENT,
      assetSearch: '',
      assetCategory: null,
      tool: 'select',
      brush: DEFAULT_BRUSH,
      gizmoMode: 'translate',
      gizmoActive: false,
      marquee: null,
      shortcutsOpen: false,
      playing: false,
      walking: false,
      physicsStatus: 'idle',
      playerHealth: null,
      editingWaypoints: null,

      beginDrag: (assetId, clientX, clientY) =>
        set({ drag: { assetId, clientX, clientY, overSurface: false } }, false, 'drag/begin'),

      updateDrag: (clientX, clientY, overSurface) =>
        set(
          (state) => (state.drag ? { drag: { ...state.drag, clientX, clientY, overSurface } } : {}),
          false,
          'drag/update',
        ),

      endDrag: () => set({ drag: null }, false, 'drag/end'),

      setPlacement: (placement) =>
        set(
          (state) => ({ placement: { ...state.placement, ...placement } }),
          false,
          'placement/set',
        ),

      setAssetSearch: (assetSearch) => set({ assetSearch }, false, 'assets/search'),
      setAssetCategory: (assetCategory) => set({ assetCategory }, false, 'assets/category'),
      setTool: (tool) => set({ tool }, false, 'tool/set'),
      setBrush: (brush) =>
        set((state) => ({ brush: { ...state.brush, ...brush } }), false, 'brush/set'),
      setGizmoMode: (gizmoMode) => set({ gizmoMode }, false, 'gizmo/mode'),
      setGizmoActive: (gizmoActive) => set({ gizmoActive }, false, 'gizmo/active'),
      setMarquee: (marquee) => set({ marquee }, false, 'selection/marquee'),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }, false, 'ui/shortcuts'),
      setPlaying: (playing) =>
        // Leaving waypoint editing on during play would keep clicks adding points to a moving path.
        set({ playing, ...(playing ? { editingWaypoints: null } : {}) }, false, 'play/set'),
      setWalking: (walking) =>
        // Walking is Play plus a body: the simulation has to be running for there to be anything
        // to walk around in, so the two are set together rather than left for the user to pair up.
        set(
          walking
            ? { walking: true, playing: true, editingWaypoints: null, tool: 'select' }
            : { walking: false, playing: false, playerHealth: null },
          false,
          'walk/set',
        ),
      setPhysicsStatus: (physicsStatus) => set({ physicsStatus }, false, 'physics/status'),
      setPlayerHealth: (playerHealth) => set({ playerHealth }, false, 'play/health'),
      setEditingWaypoints: (editingWaypoints) =>
        set({ editingWaypoints }, false, 'waypoints/editing'),
    }),
    { name: 'helaengine/editor' },
  ),
);
