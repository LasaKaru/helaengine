import { lazy, Suspense } from 'react';
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
