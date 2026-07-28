import { useSceneStore } from '../store/sceneStore';

/**
 * Application chrome. Save, undo/redo and export are stubs until the sprints that own them —
 * they are rendered disabled rather than omitted so the shape of the app is visible now.
 */
export function TopBar(): React.JSX.Element {
  const name = useSceneStore((state) => state.scene.name);
  const setName = useSceneStore((state) => state.setName);
  const objectCount = useSceneStore((state) => state.scene.objects.length);
  const history = useSceneStore((state) => state.history);
  const undo = useSceneStore((state) => state.undo);
  const redo = useSceneStore((state) => state.redo);

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">HelaEngine</span>
      </div>

      <label className="project-name">
        <span className="visually-hidden">Project name</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          aria-label="Project name"
          spellCheck={false}
        />
      </label>

      <div className="topbar-meta">{objectCount} objects</div>

      <div className="topbar-actions">
        <button
          type="button"
          onClick={undo}
          disabled={history.past.length === 0}
          title="Undo (Ctrl+Z)"
        >
          Undo
        </button>
        <button
          type="button"
          onClick={redo}
          disabled={history.future.length === 0}
          title="Redo (Ctrl+Shift+Z)"
        >
          Redo
        </button>
        <button type="button" disabled title="Local save arrives in Sprint 8">
          Save
        </button>
        <button type="button" disabled title="Export arrives in Sprint 13">
          Export
        </button>
      </div>
    </header>
  );
}
