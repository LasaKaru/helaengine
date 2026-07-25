import { useEditorStore } from '../store/editorStore';

/**
 * A small label that follows the cursor while dragging, showing what is being placed and whether
 * releasing here will actually do anything. The 3D ghost already shows *where*; this covers the
 * case where the pointer is off the terrain and there is no ghost to look at.
 */
export function DragChip(): React.JSX.Element | null {
  const drag = useEditorStore((state) => state.drag);
  if (!drag) return null;

  return (
    <div
      className={`drag-chip${drag.overSurface ? ' valid' : ''}`}
      style={{ left: drag.clientX, top: drag.clientY }}
      role="status"
      aria-live="polite"
    >
      {drag.overSurface ? `Place ${drag.assetId}` : 'Drop on the terrain'}
    </div>
  );
}
