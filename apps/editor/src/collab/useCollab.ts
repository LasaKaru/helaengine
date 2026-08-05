import { useEffect } from 'react';
import { currentSession as sessionOf } from './current';
import { CollabSession } from './session';
import { noteDocumentChanged, setCurrentSession, setPeers, setStatus } from './current';
import { currentSession as cloudSession } from '../storage/backend';

/** Where the collaboration server lives, when one is configured at all. */
export const COLLAB_ORIGIN: string | undefined = import.meta.env['VITE_COLLAB_ORIGIN'];

export function collabConfigured(): boolean {
  return typeof COLLAB_ORIGIN === 'string' && COLLAB_ORIGIN.length > 0;
}

/**
 * Joins the room for the open project, and leaves it on the way out.
 *
 * Every condition here is a reason *not* to connect, and each is a real state the editor spends
 * most of its life in: no collaboration server configured, nobody signed in, no project open, or a
 * project that lives in this browser's IndexedDB rather than in an account. A local project has no
 * room to join — there is no server that knows about it and nobody to share it with — and treating
 * that as an error rather than as the ordinary case would break the editor for everybody who never
 * made an account.
 */
export function useCollab(
  projectId: string | null,
  identity: { userId: string; displayName: string } | null,
): void {
  const token = cloudSession()?.token ?? null;
  // Destructured rather than depended on as an object: `identity` is built fresh by the caller on
  // every render, so an object dependency would tear down and rebuild the socket sixty times a
  // second. The two fields are what actually identify a seat.
  const userId = identity?.userId ?? null;
  const displayName = identity?.displayName ?? null;

  useEffect(() => {
    if (!collabConfigured() || !projectId || !userId || !displayName || !token) return;

    const session = new CollabSession({
      origin: COLLAB_ORIGIN!,
      projectId,
      token,
      identity: { userId, displayName },
      onPresence: setPeers,
      onStatus: setStatus,
      onDocumentChanged: noteDocumentChanged,
    });
    setCurrentSession(session);

    return () => {
      // Cleared before destroying, so nothing that re-renders in response finds a half-torn-down
      // session and calls into it.
      setCurrentSession(null);
      session.destroy();
    };
  }, [projectId, token, userId, displayName]);
}

/** The live session, for the handful of places that need it directly. */
export { sessionOf as collabSession };
