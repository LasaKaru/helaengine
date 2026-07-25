import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { DEFAULT_PLACEMENT, type PlacementOptions } from '../placement';
import type { GizmoMode } from '../transform';

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
  gizmoMode: GizmoMode;
  /** True while a gizmo drag owns the pointer, so selection and orbit stay out of the way. */
  gizmoActive: boolean;
  marquee: Marquee | null;
  shortcutsOpen: boolean;

  beginDrag(assetId: string, clientX: number, clientY: number): void;
  updateDrag(clientX: number, clientY: number, overSurface: boolean): void;
  endDrag(): void;
  setPlacement(placement: Partial<PlacementOptions>): void;
  setAssetSearch(search: string): void;
  setAssetCategory(category: string | null): void;
  setGizmoMode(mode: GizmoMode): void;
  setGizmoActive(active: boolean): void;
  setMarquee(marquee: Marquee | null): void;
  setShortcutsOpen(open: boolean): void;
}

export const useEditorStore = create<EditorState>()(
  devtools(
    (set) => ({
      drag: null,
      placement: DEFAULT_PLACEMENT,
      assetSearch: '',
      assetCategory: null,
      gizmoMode: 'translate',
      gizmoActive: false,
      marquee: null,
      shortcutsOpen: false,

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
      setGizmoMode: (gizmoMode) => set({ gizmoMode }, false, 'gizmo/mode'),
      setGizmoActive: (gizmoActive) => set({ gizmoActive }, false, 'gizmo/active'),
      setMarquee: (marquee) => set({ marquee }, false, 'selection/marquee'),
      setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }, false, 'ui/shortcuts'),
    }),
    { name: 'helaengine/editor' },
  ),
);
