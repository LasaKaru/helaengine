import { useEditorStore } from '../store/editorStore';

const GRID_SIZES = [0.5, 1, 2];

/** Placement options, sitting over the viewport where they affect what the drag ghost does. */
export function PlacementToolbar(): React.JSX.Element {
  const placement = useEditorStore((state) => state.placement);
  const setPlacement = useEditorStore((state) => state.setPlacement);

  return (
    <div className="placement-toolbar" role="group" aria-label="Placement options">
      <label>
        <input
          type="checkbox"
          checked={placement.snapToGrid}
          onChange={(event) => setPlacement({ snapToGrid: event.target.checked })}
        />
        Snap to grid
      </label>

      <label className={placement.snapToGrid ? '' : 'disabled'}>
        <span className="visually-hidden">Grid size</span>
        <select
          value={placement.gridSize}
          disabled={!placement.snapToGrid}
          aria-label="Grid size"
          onChange={(event) => setPlacement({ gridSize: Number(event.target.value) })}
        >
          {GRID_SIZES.map((size) => (
            <option key={size} value={size}>
              {size} m
            </option>
          ))}
        </select>
      </label>

      <label>
        <input
          type="checkbox"
          checked={placement.randomRotation}
          onChange={(event) => setPlacement({ randomRotation: event.target.checked })}
        />
        Random rotation
      </label>

      <label>
        <input
          type="checkbox"
          checked={placement.alignToNormal}
          onChange={(event) => setPlacement({ alignToNormal: event.target.checked })}
        />
        Align to surface
      </label>
    </div>
  );
}
