import { useEffect, useMemo, useState } from 'react';
import { initPhysics } from '@helaengine/engine';
import type { AssetLibrary } from '../engine/assetLibrary';
import { assetLibraryOnce } from '../engine/libraryOnce';
import { useEditorStore } from '../store/editorStore';
import { primeUiAssetUrls } from '../storage/uiAssets';
import { exposeDevApi } from '../devApi';
import { AssetLibraryPanel } from './AssetLibraryPanel';
import { DragChip } from './DragChip';
import { ErrorBoundary } from './ErrorBoundary';
import { InspectorPanel } from './Panels';
import { FirstRunTour } from './FirstRunTour';
import { ShortcutsModal } from './ShortcutsModal';
import { useUploadedAssets } from '../storage/useUploadedAssets';
import { useImportedAssets } from '../storage/useImportedAssets';
import { TopBar } from './TopBar';
import { Viewport } from './Viewport';

/**
 * The editor proper: top bar, asset library, viewport, inspector.
 *
 * Split out of `App` so it can be loaded on demand, and the split is the reason this file exists.
 * Everything the editor needs — Three.js, react-three-fiber, the gizmos, the physics engine — was
 * previously in the entry chunk, which meant a user who signed in to look at their project list
 * downloaded a 3D engine to read six lines of text. It is now behind a dynamic import, so those
 * bytes arrive when somebody opens a project, which is the moment they become useful.
 *
 * Everything that only the editor uses moved with it, including the asset library load and the
 * WebAssembly physics init. Leaving either in `App` would have moved the *code* out of the entry
 * chunk while still triggering the download at boot — a split that looks good in a bundle report
 * and changes nothing a user experiences.
 */

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; library: AssetLibrary }
  | { status: 'error'; message: string };

export function EditorWorkspace(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  const library = state.status === 'ready' ? state.library : null;
  const uploads = useUploadedAssets(library);
  const imported = useImportedAssets(library);

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
    if (uploads.entries.length === 0 && imported.length === 0) return library.manifest;

    const byId = new Map(library.manifest.assets.map((asset) => [asset.id, asset]));
    for (const entry of uploads.entries) byId.set(entry.id, entry);
    // Imported last: a project opened from a file brought its own copy of the model, and that copy
    // is the one that scene was built against. An account asset sharing the id may be a different
    // model entirely.
    for (const entry of imported) byId.set(entry.id, entry);
    return { ...library.manifest, assets: [...byId.values()] };
  }, [library, uploads.entries, imported]);

  useEffect(() => {
    const controller = new AbortController();

    assetLibraryOnce(controller.signal)
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

  // Uploaded UI assets are Blobs; the shell resolves them synchronously while drawing a menu, so
  // their object URLs have to exist before it asks.
  useEffect(() => {
    void primeUiAssetUrls();
  }, []);

  // Rapier is WebAssembly and has to be instantiated before anything can be simulated. Starting
  // that here, once, is the sprint plan's "handle it at bootstrap" — by the time somebody presses
  // Walk the module is normally already there, and if it is not, the button says so rather than
  // every physics call having to ask whether it may run yet.
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

  return (
    <div className="editor">
      <TopBar manifest={manifest ?? state.library.manifest} />
      <div className="workspace">
        {/*
          A boundary per panel rather than one around the editor (Sprint 33).

          One outer boundary would be less code and much worse: a properties panel that throws on a
          malformed field would take the viewport, the toolbar and the asset library down with it,
          and the user would lose sight of a scene that is still perfectly fine in memory. Scoped
          like this, a broken panel is a broken panel.
        */}
        <ErrorBoundary where="the asset library">
          <AssetLibraryPanel manifest={manifest ?? state.library.manifest} uploads={uploads} />
        </ErrorBoundary>
        <ErrorBoundary where="the level view">
          <Viewport loader={state.library.loader} resolver={state.library.resolver} />
        </ErrorBoundary>
        <ErrorBoundary where="the properties panel">
          <InspectorPanel manifest={manifest ?? state.library.manifest} />
        </ErrorBoundary>
      </div>
      <DragChip />
      <ShortcutsModal />
      {/*
        Mounted last, and inside the editor rather than the shell: every element it points at lives
        in this subtree, so rendering it any earlier would measure elements that do not exist yet.
      */}
      <FirstRunTour />
    </div>
  );
}

// A default export as well, because `React.lazy` wants a module whose default *is* the component,
// and the named export is what every other file in this app imports by.
export default EditorWorkspace;
