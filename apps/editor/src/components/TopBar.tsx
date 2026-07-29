import { useProjectStore } from '../store/projectStore';
import { useSceneStore } from '../store/sceneStore';

function saveLabel(
  state: ReturnType<typeof useProjectStore.getState>['saveState'],
  dirty: boolean,
): string {
  if (state.status === 'saving') return 'Saving…';
  if (state.status === 'error') return 'Save failed';
  if (dirty) return 'Unsaved changes';
  if (state.status === 'saved') return 'Saved';
  return '';
}

/** Application chrome: project name, history, save state, and the way back to the projects list. */
export function TopBar(): React.JSX.Element {
  const name = useSceneStore((state) => state.scene.name);
  const setName = useSceneStore((state) => state.setName);
  const objectCount = useSceneStore((state) => state.scene.objects.length);
  const history = useSceneStore((state) => state.history);
  const undo = useSceneStore((state) => state.undo);
  const redo = useSceneStore((state) => state.redo);
  const saveState = useProjectStore((state) => state.saveState);
  const dirty = useProjectStore((state) => state.dirty);
  const save = useProjectStore((state) => state.save);
  const goHome = useProjectStore((state) => state.goHome);

  return (
    <header className="topbar">
      <button type="button" className="brand brand-button" onClick={() => void goHome()}>
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Projects</span>
      </button>

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
      <div
        className={`save-state${saveState.status === 'error' ? ' error' : ''}`}
        role="status"
        aria-label="Save state"
        aria-live="polite"
      >
        {saveLabel(saveState, dirty)}
      </div>

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
        <button
          type="button"
          onClick={() => void save()}
          disabled={saveState.status === 'saving'}
          title="Save to this browser"
        >
          Save
        </button>
        <button type="button" disabled title="Export arrives in Sprint 21">
          Export
        </button>
      </div>
    </header>
  );
}
