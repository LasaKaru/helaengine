import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { applyScene, isEmpty, readScene, seedScene } from '@helaengine/collab';
import { presenceColor, parsePresence, type Presence, type Scene } from '@helaengine/schema';
import { useSceneStore } from '../store/sceneStore';

/**
 * One editor's seat in a collaborative room.
 *
 * Two loops that must not chase each other: local edits go up, remote edits come down, and the
 * naive wiring makes each one trigger the other forever. The guard is an **origin** — every write
 * this client makes into the Y.Doc is tagged, and the downward loop ignores anything wearing that
 * tag. Not a boolean re-entrancy flag, because updates arrive asynchronously and a flag would be
 * cleared before the echo it was meant to suppress ever showed up.
 *
 * The other thing worth stating up front is **undo**. Outside a room, undo is the editor's own
 * Immer patch stack. Inside one it has to be Yjs's `UndoManager`, scoped to this client's origin —
 * otherwise Ctrl+Z replays a patch computed against a document that has since moved underneath it,
 * and at best it undoes a colleague's work instead of yours. That is not a refinement; a
 * collaborative editor whose undo silently reverts other people is worse than one with no undo.
 */

/** Tags every write this client makes, so its own echoes can be told from everybody else's edits. */
export const LOCAL_ORIGIN = Symbol('helaengine/local');

export interface CollabIdentity {
  userId: string;
  displayName: string;
}

export interface CollabOptions {
  origin: string;
  projectId: string;
  token: string;
  identity: CollabIdentity;
  /** Called whenever the set of collaborators changes. */
  onPresence?: (peers: Peer[]) => void;
  /** Called when the connection comes and goes, for the status pill. */
  onStatus?: (status: CollabStatus) => void;
  /** Called when the shared document moved, so anything reading `canUndo()` asks again. */
  onDocumentChanged?: () => void;
}

export type CollabStatus = 'connecting' | 'connected' | 'disconnected';

/**
 * A collaborator, plus the seat they are sitting in.
 *
 * Keyed by `clientId` rather than by `userId` because one account can legitimately hold two seats —
 * somebody with the editor open on two monitors is not an edge case, and keying a React list by
 * user id would collide the moment they did it.
 */
export interface Peer extends Presence {
  clientId: number;
}

export class CollabSession {
  readonly doc: Y.Doc;
  readonly provider: WebsocketProvider;
  readonly #undo: Y.UndoManager;
  readonly #identity: CollabIdentity;
  readonly #options: CollabOptions;

  /**
   * The scene as this client last agreed it to be.
   *
   * The baseline `applyScene` needs. It advances on a local push *and* on adopting a remote change,
   * because both are moments when this client and the document agree — and a baseline that lagged
   * behind a remote change would make the next local push try to revert it.
   */
  #baseline: Scene | null = null;
  #unsubscribe: (() => void) | null = null;
  #applyingRemote = false;
  #disposed = false;

  constructor(options: CollabOptions) {
    this.#options = options;
    this.#identity = options.identity;
    this.doc = new Y.Doc();

    this.provider = new WebsocketProvider(options.origin, options.projectId, this.doc, {
      params: { token: options.token, project: options.projectId },
    });

    /**
     * Undo, scoped to this client's own operations.
     *
     * `trackedOrigins` is the whole point: without it the manager would happily undo an operation
     * that arrived from somebody else's browser. With it, Ctrl+Z walks back only what this seat
     * did — which is what every user means by undo and what no shared patch stack can provide.
     */
    this.#undo = new Y.UndoManager([this.doc.getMap('objects'), this.doc.getMap('document')], {
      trackedOrigins: new Set([LOCAL_ORIGIN]),
    });

    this.provider.on('status', ({ status }: { status: string }) => {
      options.onStatus?.(status === 'connected' ? 'connected' : 'disconnected');
    });

    this.provider.on('sync', (synced: boolean) => {
      if (synced) this.#onSynced();
    });

    this.doc.on('update', this.#onDocUpdate);
    this.provider.awareness.on('change', this.#onAwareness);

    options.onStatus?.('connecting');
  }

  /**
   * The room is ready.
   *
   * Two cases, and getting them the wrong way round is how a collaborative session eats somebody's
   * level. An **empty** room means the server had nothing to seed from — a project that was never
   * saved — so this client's document becomes the room's. A **populated** room is the truth, and
   * this client adopts it, discarding whatever unsaved local state it arrived with.
   *
   * The second case is the one that feels wrong and is right: joining a room is joining a document
   * somebody else is already in, and quietly merging your stale copy into theirs would resurrect
   * every object they had deleted since.
   */
  #onSynced(): void {
    if (this.#disposed) return;
    const store = useSceneStore.getState();

    if (isEmpty(this.doc)) {
      seedScene(this.doc, store.scene, LOCAL_ORIGIN);
      this.#baseline = store.scene;
    } else {
      const remote = this.#readSafely();
      if (!remote) return;
      this.#adopt(remote);
    }

    this.#watchStore();
    this.#publishPresence();
    this.#options.onStatus?.('connected');
  }

  /** Local store changes go up. */
  #watchStore(): void {
    if (this.#unsubscribe) return;

    this.#unsubscribe = useSceneStore.subscribe((state, previous) => {
      if (this.#disposed) return;
      if (state.scene === previous.scene) return;
      // The store change this session itself just caused. Pushing it back would be a no-op that
      // still costs a transaction and a message to everybody in the room.
      if (this.#applyingRemote) return;

      const baseline = this.#baseline;
      if (!baseline) return;

      applyScene(this.doc, state.scene, baseline, LOCAL_ORIGIN);
      this.#baseline = state.scene;
      this.#options.onDocumentChanged?.();
    });
  }

  /** Remote document changes come down. */
  readonly #onDocUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (this.#disposed) return;
    // This client's own write, echoed by Yjs to its own observers. Adopting it would be harmless
    // but pointless; the interesting case is everything else.
    if (origin === LOCAL_ORIGIN) return;

    const remote = this.#readSafely();
    if (remote) this.#adopt(remote);
    // Undoability can have moved — an operation of this client's may have been redone away, or a
    // remote change may have landed on top of one. React has no other way to notice.
    this.#options.onDocumentChanged?.();
  };

  #adopt(scene: Scene): void {
    // The baseline moves with the adoption, not after it: this client and the document now agree,
    // and a stale baseline would make the next local push try to undo what was just adopted.
    this.#baseline = scene;
    this.#applyingRemote = true;
    try {
      useSceneStore.getState().applyRemoteScene(scene);
    } finally {
      this.#applyingRemote = false;
    }
  }

  /**
   * A partially-synced document is normal, not broken.
   *
   * Updates arrive in pieces, so there are moments when the document holds an object whose fields
   * have not all landed. Reading it then fails validation — correctly. Waiting for the next update
   * is the right response; throwing would turn an ordinary network frame into a crashed editor.
   */
  #readSafely(): Scene | null {
    try {
      return readScene(this.doc);
    } catch {
      return null;
    }
  }

  readonly #onAwareness = (): void => {
    if (this.#disposed) return;

    const peers: Peer[] = [];
    for (const [clientId, state] of this.provider.awareness.getStates()) {
      if (clientId === this.doc.clientID) continue;
      const presence = parsePresence(state);
      // A peer on a build this one cannot read is a peer this one does not draw, rather than an
      // exception that takes the panel down with it.
      if (presence) peers.push({ ...presence, clientId });
    }

    this.#options.onPresence?.(peers);
  };

  /** Publishes where this user is and what they are touching. */
  setPresence(patch: Partial<Pick<Presence, 'camera' | 'selection' | 'editing'>>): void {
    if (this.#disposed) return;
    const current = (this.provider.awareness.getLocalState() ?? {}) as Partial<Presence>;
    this.provider.awareness.setLocalState({
      ...this.#basePresence(),
      camera: patch.camera ?? current.camera ?? null,
      selection: patch.selection ?? current.selection ?? [],
      editing: patch.editing ?? current.editing ?? false,
    });
  }

  #publishPresence(): void {
    this.provider.awareness.setLocalState({
      ...this.#basePresence(),
      camera: null,
      selection: useSceneStore.getState().selectedIds,
      editing: false,
    });
  }

  #basePresence(): Pick<Presence, 'userId' | 'displayName' | 'color' | 'updatedAt'> {
    return {
      userId: this.#identity.userId,
      displayName: this.#identity.displayName,
      // Derived from the id rather than assigned by the server, so everybody independently agrees
      // on it and a reconnect does not change somebody's colour mid-session.
      color: presenceColor(this.#identity.userId),
      updatedAt: Date.now(),
    };
  }

  undo(): boolean {
    if (!this.#undo.canUndo()) return false;
    this.#undo.undo();
    this.#afterHistory();
    this.#options.onDocumentChanged?.();
    return true;
  }

  redo(): boolean {
    if (!this.#undo.canRedo()) return false;
    this.#undo.redo();
    this.#afterHistory();
    this.#options.onDocumentChanged?.();
    return true;
  }

  canUndo(): boolean {
    return this.#undo.canUndo();
  }

  canRedo(): boolean {
    return this.#undo.canRedo();
  }

  /**
   * Pulls the store back in line after an undo.
   *
   * `UndoManager` writes with its own origin, not this client's, so the downward loop does adopt
   * it — but only on the next update event, and an undo is a user action that should be on screen
   * before the next frame. Doing it here makes the redraw synchronous.
   */
  #afterHistory(): void {
    const scene = this.#readSafely();
    if (scene) this.#adopt(scene);
  }

  destroy(): void {
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.doc.off('update', this.#onDocUpdate);
    this.provider.awareness.off('change', this.#onAwareness);
    this.#undo.destroy();
    // Destroys the socket *and* the awareness state, so the other editors see this seat empty
    // rather than watching a cursor that has stopped moving.
    this.provider.destroy();
    this.doc.destroy();
  }
}
