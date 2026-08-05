import { useCallback, useSyncExternalStore } from 'react';
import { useSceneStore } from '../store/sceneStore';
import type { CollabSession, CollabStatus, Peer } from './session';

/**
 * The collaborative session this tab is in, if any.
 *
 * Module-level and subscribable, the same shape `storage/backend.ts` uses for the cloud clients.
 * The alternative — threading a session object through the component tree — would put a prop on
 * every panel for a feature most of them do not care about, and the panels that *do* care (the top
 * bar's undo buttons, the viewport's highlights) are nowhere near each other.
 *
 * There is no session outside a room, and every consumer has to work in that case, because editing
 * alone is not a degraded mode — it is what the editor does by default.
 */

let session: CollabSession | null = null;
let peers: Peer[] = [];
let status: CollabStatus = 'disconnected';

/**
 * Bumped whenever the shared document changes.
 *
 * Yjs's `UndoManager` exposes `canUndo()` as a method, not as observable state, so React has no way
 * to know it has become true. This is the signal that says "ask again" — cheap, and honest about
 * being a version counter rather than pretending the answer is stored anywhere.
 */
let revision = 0;

const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) listener();
}

export function subscribeToCollab(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setCurrentSession(next: CollabSession | null): void {
  session = next;
  if (!next) {
    peers = [];
    status = 'disconnected';
  }
  announce();
}

export function currentSession(): CollabSession | null {
  return session;
}

export function setPeers(next: Peer[]): void {
  peers = next;
  announce();
}

export function setStatus(next: CollabStatus): void {
  status = next;
  announce();
}

/** Told by the session that the document moved, so anything reading `canUndo()` asks again. */
export function noteDocumentChanged(): void {
  revision += 1;
  announce();
}

function readPeers(): Peer[] {
  return peers;
}

function readStatus(): CollabStatus {
  return status;
}

/** Non-hook readers, for the dev API and anything else outside React. */
export const collabPeers = readPeers;
export const collabStatus = readStatus;

const NO_PEERS: Peer[] = [];

export function useCollabPeers(): Peer[] {
  return useSyncExternalStore(subscribeToCollab, readPeers, () => NO_PEERS);
}

export function useCollabStatus(): CollabStatus {
  return useSyncExternalStore(subscribeToCollab, readStatus, () => 'disconnected' as const);
}

export function useIsCollaborating(): boolean {
  return useSyncExternalStore(
    subscribeToCollab,
    () => session !== null,
    () => false,
  );
}

/**
 * Undo and redo, from whichever history is in charge.
 *
 * Alone, that is the editor's Immer patch stack. In a room it is Yjs's `UndoManager`, scoped to
 * this client's own operations — because replaying an Immer patch against a document that three
 * other people have edited since either targets the wrong thing or takes back somebody else's
 * work. Both are real failures and the second is the one users would never forgive.
 *
 * One hook rather than a conditional at each call site, so the top bar and the keyboard shortcuts
 * cannot disagree about which history they are driving.
 */
export interface HistoryControls {
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
}

/**
 * Undo, from outside React.
 *
 * The keyboard handler lives in an effect closure and cannot hold a hook's result without going
 * stale, so the decision of *which* history to drive is made here, at call time, rather than
 * captured when the listener was registered.
 */
export function runUndo(): void {
  const active = currentSession();
  if (active) {
    active.undo();
    return;
  }
  useSceneStore.getState().undo();
}

export function runRedo(): void {
  const active = currentSession();
  if (active) {
    active.redo();
    return;
  }
  useSceneStore.getState().redo();
}

export function useHistoryControls(): HistoryControls {
  const collaborating = useIsCollaborating();
  const history = useSceneStore((state) => state.history);
  // Re-read on every document change, because `canUndo()` is a method call whose answer moves
  // without anything React watches changing.
  useSyncExternalStore(
    subscribeToCollab,
    () => revision,
    () => 0,
  );

  const undo = useCallback(() => runUndo(), []);
  const redo = useCallback(() => runRedo(), []);

  return {
    undo,
    redo,
    canUndo: collaborating ? (currentSession()?.canUndo() ?? false) : history.past.length > 0,
    canRedo: collaborating ? (currentSession()?.canRedo() ?? false) : history.future.length > 0,
  };
}
