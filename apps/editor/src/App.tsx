import { useEffect, useState } from 'react';
import { initPhysics } from '@helaengine/engine';
import { loadAssetLibrary, type AssetLibrary } from './engine/assetLibrary';
import { useEditorStore } from './store/editorStore';
import { primeUiAssetUrls } from './storage/uiAssets';
import { exposeDevApi } from './devApi';
import { AssetLibraryPanel } from './components/AssetLibraryPanel';
import { DragChip } from './components/DragChip';
import { InspectorPanel } from './components/Panels';
import { ProjectsScreen } from './components/ProjectsScreen';
import { ShortcutsModal } from './components/ShortcutsModal';
import { useShortcuts } from './useShortcuts';
import { useAutosave } from './useAutosave';
import { useProjectStore } from './store/projectStore';
import { TopBar } from './components/TopBar';
import { Viewport } from './components/Viewport';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; library: AssetLibrary }
  | { status: 'error'; message: string };

export function App(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const screen = useProjectStore((store) => store.screen);

  useShortcuts();
  useAutosave(screen === 'editor');

  useEffect(() => {
    const controller = new AbortController();

    loadAssetLibrary(controller.signal)
      .then((library) => {
        exposeDevApi(library);
        setState({ status: 'ready', library });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => controller.abort();
  }, []);

  // Rapier is WebAssembly and has to be instantiated before anything can be simulated. Starting
  // that here, once, is the sprint plan's "handle it at bootstrap" — by the time somebody presses
  // Walk the module is normally already there, and if it is not, the button says so rather than
  // every physics call having to ask whether it may run yet.
  // Uploaded UI assets are Blobs; the shell resolves them synchronously while drawing a menu, so
  // their object URLs have to exist before it asks.
  useEffect(() => {
    void primeUiAssetUrls();
  }, []);

  useEffect(() => {
    const editor = useEditorStore.getState();
    editor.setPhysicsStatus('loading');
    void initPhysics().then(
      () => editor.setPhysicsStatus('ready'),
      (error: unknown) => {
        console.error('[helaengine] physics unavailable', error);
        editor.setPhysicsStatus('error');
      },
    );
  }, []);

  if (state.status === 'loading') {
    return (
      <div className="fullscreen-message">
        <div className="spinner" aria-hidden="true" />
        <p>Loading asset library…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="fullscreen-message error" role="alert">
        <h1>Could not start the editor</h1>
        <p>{state.message}</p>
      </div>
    );
  }

  if (screen === 'projects') return <ProjectsScreen />;

  return (
    <div className="editor">
      <TopBar />
      <div className="workspace">
        <AssetLibraryPanel manifest={state.library.manifest} />
        <Viewport loader={state.library.loader} resolver={state.library.resolver} />
        <InspectorPanel manifest={state.library.manifest} />
      </div>
      <DragChip />
      <ShortcutsModal />
    </div>
  );
}
