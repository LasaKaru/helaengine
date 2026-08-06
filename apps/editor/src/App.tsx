import { lazy, Suspense, useEffect } from 'react';
import { ProjectsScreen } from './components/ProjectsScreen';
import { useShortcuts } from './useShortcuts';
import { useAutosave } from './useAutosave';
import { useProjectStore } from './store/projectStore';
import { useCollab } from './collab/useCollab';
import { usePublishPresence } from './collab/usePublishPresence';
import { currentSession as cloudSession, isCloud } from './storage/backend';

/**
 * The shell: which screen, and the things that outlive a screen change.
 *
 * Deliberately thin, and deliberately free of anything 3D. This module and what it statically
 * imports are the entry chunk — the bytes every visitor downloads before seeing anything — so the
 * editor itself is behind `lazy` and arrives when a project is opened. The autosave, collaboration
 * and shortcut hooks stay here because they have to survive the transition between screens; they
 * are a few kilobytes of logic, not an engine.
 */

const EditorWorkspace = lazy(() => import('./components/EditorWorkspace'));

/**
 * Who this browser is, in a room.
 *
 * Read from the cloud session rather than kept separately: a collaborator's identity *is* their
 * account, and a second copy would be a second thing to keep in step.
 */
function useCollabIdentity(): { userId: string; displayName: string } | null {
  const session = cloudSession();
  if (!session?.userId) return null;
  return { userId: session.userId, displayName: session.displayName || 'Someone' };
}

export function App(): React.JSX.Element {
  const screen = useProjectStore((store) => store.screen);

  useShortcuts();
  useAutosave(screen === 'editor');

  /**
   * Join the room for the open project.
   *
   * Only for a *cloud* project. One stored in this browser's IndexedDB has no room to join — the
   * collaboration server has never heard of it and there is nobody to share it with — so the editor
   * runs exactly as it always has, which is what it does for everyone without an account.
   */
  const projectId = useProjectStore((store) => store.projectId);
  const identity = useCollabIdentity();
  useCollab(screen === 'editor' && isCloud() ? projectId : null, identity);
  usePublishPresence();

  /**
   * Publishes the dev API from the shell, not only from the editor.
   *
   * `window.helaengine` is the e2e suite's handle on the app, and several of its suites reach for
   * it on the *projects* screen — opening a `.hela` file is a projects-screen gesture, and the drop
   * zone lives there. Publishing it only from the workspace, as the first version of this split
   * did, left those tests waiting forever for a global that now arrived a screen too late.
   *
   * The import is dynamic, which is the point: the dev API needs the asset library, the asset
   * library pulls in the engine, and a static import here would put Three.js straight back into the
   * entry chunk this split exists to empty. This way the shell renders first and the engine is
   * fetched afterwards — so it is honest to say the projects screen no longer *waits* on the
   * engine, and dishonest to say it never downloads it.
   */
  useEffect(() => {
    let live = true;
    void (async () => {
      const [{ exposeDevApi }, { assetLibraryOnce }] = await Promise.all([
        import('./devApi'),
        import('./engine/libraryOnce'),
      ]);
      const library = await assetLibraryOnce().catch(() => null);
      // The workspace republishes with the merged manifest once it mounts, so this is the floor
      // rather than the final answer — and it must not overwrite the richer one on a late resolve.
      if (live && library && window.helaengine === undefined) exposeDevApi(library);
    })();
    return () => {
      live = false;
    };
  }, []);

  if (screen === 'projects') return <ProjectsScreen />;

  return (
    <Suspense
      fallback={
        <div className="fullscreen-message">
          <div className="spinner" aria-hidden="true" />
          <p>Loading the editor…</p>
        </div>
      }
    >
      <EditorWorkspace />
    </Suspense>
  );
}
