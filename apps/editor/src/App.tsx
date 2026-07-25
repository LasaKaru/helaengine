import { useEffect, useState } from 'react';
import { loadAssetLibrary, type AssetLibrary } from './engine/assetLibrary';
import { exposeDevApi } from './devApi';
import { AssetLibraryPanel } from './components/AssetLibraryPanel';
import { DragChip } from './components/DragChip';
import { InspectorPanel } from './components/Panels';
import { TopBar } from './components/TopBar';
import { Viewport } from './components/Viewport';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; library: AssetLibrary }
  | { status: 'error'; message: string };

export function App(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

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
      <TopBar />
      <div className="workspace">
        <AssetLibraryPanel manifest={state.library.manifest} />
        <Viewport loader={state.library.loader} />
        <InspectorPanel />
      </div>
      <DragChip />
    </div>
  );
}
