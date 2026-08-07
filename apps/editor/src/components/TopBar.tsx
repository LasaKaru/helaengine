import { useState } from 'react';
import type { AssetManifest } from '@helaengine/schema';
import { ExportWizard } from './ExportWizard';
import { VersionHistory } from './VersionHistory';
import { useProjectStore } from '../store/projectStore';
import { useSceneStore } from '../store/sceneStore';
import { useEditorStore } from '../store/editorStore';
import { useCollabPeers, useHistoryControls } from '../collab/current';
import { Collaborators } from './Collaborators';

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
/**
 * `manifest` is optional so the bar can render before the asset library has loaded — and so its
 * unit tests, which are about undo and saving, do not have to construct one. Export needs it, and
 * says so rather than exporting a scene whose assets it cannot look up.
 */
export function TopBar({ manifest }: { manifest?: AssetManifest } = {}): React.JSX.Element {
  const [exporting, setExporting] = useState(false);
  const [showingHistory, setShowingHistory] = useState(false);
  const name = useSceneStore((state) => state.scene.name);
  const setName = useSceneStore((state) => state.setName);
  const objectCount = useSceneStore((state) => state.scene.objects.length);
  // Undo comes from whichever history is in charge — this browser's patch stack alone, or Yjs's
  // per-client stack in a room. See `collab/current.ts` for why the two cannot be the same thing.
  const { undo, redo, canUndo, canRedo } = useHistoryControls();
  const peers = useCollabPeers();
  const saveState = useProjectStore((state) => state.saveState);
  const dirty = useProjectStore((state) => state.dirty);
  const save = useProjectStore((state) => state.save);
  const saveToFile = useProjectStore((state) => state.saveToFile);
  const saveFileAs = useProjectStore((state) => state.saveFileAs);
  const fileName = useProjectStore((state) => state.fileName);
  const fileNotice = useProjectStore((state) => state.fileNotice);
  const dismissFileNotice = useProjectStore((state) => state.dismissFileNotice);
  const goHome = useProjectStore((state) => state.goHome);
  const setGraphOpen = useEditorStore((state) => state.setGraphOpen);

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

      {fileNotice !== null && (
        <p className="file-notice" role="status">
          {fileNotice}{' '}
          <button type="button" onClick={dismissFileNotice}>
            Got it
          </button>
        </p>
      )}

      {peers.length > 0 && <Collaborators peers={peers} />}

      <div className="topbar-actions">
        <button type="button" onClick={undo} disabled={!canUndo} title="Undo (Ctrl+Z)">
          Undo
        </button>
        <button type="button" onClick={redo} disabled={!canRedo} title="Redo (Ctrl+Shift+Z)">
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
        {/*
          Two buttons rather than one with a dropdown. "Save to file" is the one people press
          repeatedly once they have chosen a location; burying it a click deep behind a menu is how
          a feature ends up unused. The label carries the filename so it is obvious *which* file is
          about to be written — and says "Save as" when there is nothing bound yet.
        */}
        <button
          type="button"
          onClick={() => void saveToFile()}
          disabled={saveState.status === 'saving'}
          title={
            fileName ? `Write ${fileName} on your computer` : 'Save a .hela file to your computer'
          }
        >
          {fileName ? `Save ${fileName}` : 'Save to file…'}
        </button>
        {fileName && (
          <button
            type="button"
            onClick={() => void saveFileAs()}
            disabled={saveState.status === 'saving'}
            title="Save a .hela file somewhere else"
          >
            Save as…
          </button>
        )}
        <button
          type="button"
          onClick={() => setGraphOpen(true)}
          title="Wire up what happens, without writing code"
        >
          Graph
        </button>
        <button
          type="button"
          onClick={() => setShowingHistory(true)}
          title="Every save, and a way back to any of them"
        >
          History
        </button>
        <button
          type="button"
          onClick={() => setExporting(true)}
          disabled={!manifest}
          title={manifest ? 'Download a runnable copy' : 'Waiting for the asset library'}
        >
          Export
        </button>
      </div>
      {exporting && manifest && (
        <ExportWizard manifest={manifest} onClose={() => setExporting(false)} />
      )}
      {showingHistory && <VersionHistory onClose={() => setShowingHistory(false)} />}
    </header>
  );
}
