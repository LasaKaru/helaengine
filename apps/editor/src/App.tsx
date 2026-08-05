import { useEffect, useMemo, useState } from 'react';
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
import { useUploadedAssets } from './storage/useUploadedAssets';
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

  const library = state.status === 'ready' ? state.library : null;
  const uploads = useUploadedAssets(library);

  /**
   * The curated library plus this organisation's own, as one manifest.
   *
   * Merged here rather than inside `loadAssetLibrary` because uploads arrive *after* boot — a new
   * one appears the moment it finishes processing, and the inspector, the top bar and the library
   * panel all have to see it without a reload.
   *
   * Keyed by id, with the upload winning, because the *resolver* already works that way — `add`
   * overwrites. Concatenating instead would let the two disagree: the engine would draw an
   * organisation's model while the inspector read the curated entry's bounds and the panel showed
   * two cards with the same name. An id can only mean one asset.
   */
  const manifest = useMemo(() => {
    if (!library) return null;
    if (uploads.entries.length === 0) return library.manifest;

    const byId = new Map(library.manifest.assets.map((asset) => [asset.id, asset]));
    for (const entry of uploads.entries) byId.set(entry.id, entry);
    return { ...library.manifest, assets: [...byId.values()] };
  }, [library, uploads.entries]);

  useEffect(() => {
    const controller = new AbortController();

    loadAssetLibrary(controller.signal)
      .then((library) => {
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

  /**
   * Re-published whenever the manifest grows.
   *
   * The dev API closes over the library it was handed, so publishing once at boot would leave
   * `assetIds()` answering with the curated list forever — and the e2e suite asking whether an
   * upload is placeable would get "no" from a stale closure while the panel showed the card.
   */
  useEffect(() => {
    if (library && manifest) exposeDevApi({ ...library, manifest });
  }, [library, manifest]);

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
      <TopBar manifest={manifest ?? state.library.manifest} />
      <div className="workspace">
        <AssetLibraryPanel manifest={manifest ?? state.library.manifest} uploads={uploads} />
        <Viewport loader={state.library.loader} resolver={state.library.resolver} />
        <InspectorPanel manifest={manifest ?? state.library.manifest} />
      </div>
      <DragChip />
      <ShortcutsModal />
    </div>
  );
}
