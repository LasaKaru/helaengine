import { useEditorStore, type EditorTool } from '../store/editorStore';

const GRID_SIZES = [0.5, 1, 2];
const TOOLS: Array<{ tool: EditorTool; label: string; hint: string }> = [
  { tool: 'select', label: 'Select', hint: 'Place, select and transform objects (1)' },
  { tool: 'sculpt', label: 'Sculpt', hint: 'Raise, lower, smooth and flatten the ground (2)' },
  { tool: 'paint', label: 'Paint', hint: 'Blend the terrain layers (3)' },
];

/** Placement options, sitting over the viewport where they affect what the drag ghost does. */
export function PlacementToolbar(): React.JSX.Element {
  const placement = useEditorStore((state) => state.placement);
  const setPlacement = useEditorStore((state) => state.setPlacement);
  const tool = useEditorStore((state) => state.tool);
  const setTool = useEditorStore((state) => state.setTool);
  const playing = useEditorStore((state) => state.playing);
  const setPlaying = useEditorStore((state) => state.setPlaying);

  return (
    <div className="placement-toolbar" role="group" aria-label="Placement options">
      <button
        type="button"
        className={`play-toggle${playing ? ' active' : ''}`}
        aria-pressed={playing}
        title="Run the scene's behaviours (P)"
        onClick={() => setPlaying(!playing)}
      >
        {playing ? 'Stop' : 'Play'}
      </button>

      <div className="tool-switch" role="group" aria-label="Tool">
        {TOOLS.map((entry) => (
          <button
            key={entry.tool}
            type="button"
            title={entry.hint}
            className={tool === entry.tool ? 'active' : ''}
            aria-pressed={tool === entry.tool}
            onClick={() => setTool(entry.tool)}
          >
            {entry.label}
          </button>
        ))}
      </div>

      <label className={tool === 'select' ? '' : 'disabled'}>
        <input
          type="checkbox"
          disabled={tool !== 'select'}
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
