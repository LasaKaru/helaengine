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
   *
   * **Only on the projects screen**, and that restriction is load-bearing rather than tidy. Around
   * a dozen tests reload the page and then wait for `window.helaengine` as their signal that the
   * editor is ready. That worked because the dev API used to be published from the editor and
   * nowhere else — an accidental barrier, but a correct one. Publishing unconditionally from here
   * would race the workspace's own chunk and let those waits resolve against a viewport that does
   * not exist yet, turning a reliable signal into a coin flip. On the editor screen the workspace
   * remains the only publisher, so the global still means what every caller assumes it means.
   */
  const onProjects = screen === 'projects';
  useEffect(() => {
    if (!onProjects) return;

    let live = true;
    void (async () => {
      const [{ exposeDevApi }, { assetLibraryOnce }] = await Promise.all([
        import('./devApi'),
        import('./engine/libraryOnce'),
      ]);
      const library = await assetLibraryOnce().catch(() => null);
      // Guarded against a late resolve landing after the user has already opened a project, where
      // it would replace the workspace's richer manifest with the curated list.
      if (live && library) exposeDevApi(library);
    })();
    return () => {
      live = false;
    };
  }, [onProjects]);

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
