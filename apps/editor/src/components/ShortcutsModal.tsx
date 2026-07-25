import { useEditorStore } from '../store/editorStore';
import { SHORTCUTS } from '../useShortcuts';

/** Keyboard reference. Opened with `?`, closed with Escape or the button. */
export function ShortcutsModal(): React.JSX.Element | null {
  const open = useEditorStore((state) => state.shortcutsOpen);
  const setOpen = useEditorStore((state) => state.setShortcutsOpen);
  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={() => setOpen(false)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Keyboard shortcuts</h2>
        <dl className="shortcut-list">
          {SHORTCUTS.map((shortcut) => (
            <div key={shortcut.keys}>
              <dt>{shortcut.keys}</dt>
              <dd>{shortcut.description}</dd>
            </div>
          ))}
        </dl>
        <button type="button" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
    </div>
  );
}
