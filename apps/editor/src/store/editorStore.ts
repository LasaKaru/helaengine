import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { DEFAULT_PLACEMENT, type PlacementOptions } from '../placement';

export interface DragState {
  assetId: string;
  /** Latest pointer position in client coordinates, for the DOM drag chip. */
  clientX: number;
  clientY: number;
  /** True once the pointer is over the viewport and the ghost has a surface to sit on. */
  overSurface: boolean;
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

  beginDrag(assetId: string, clientX: number, clientY: number): void;
  updateDrag(clientX: number, clientY: number, overSurface: boolean): void;
  endDrag(): void;
  setPlacement(placement: Partial<PlacementOptions>): void;
  setAssetSearch(search: string): void;
  setAssetCategory(category: string | null): void;
}

export const useEditorStore = create<EditorState>()(
  devtools(
    (set) => ({
      drag: null,
      placement: DEFAULT_PLACEMENT,
      assetSearch: '',
      assetCategory: null,

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
    }),
    { name: 'helaengine/editor' },
  ),
);
