import * as Y from 'yjs';
import { isEmpty, readScene, seedScene } from '@helaengine/collab';
import type { Scene } from '@helaengine/schema';

/**
 * The rooms this process is holding, and what happens to them when everybody leaves.
 *
 * A room is a `Y.Doc` plus the sockets watching it. The interesting part is not either of those —
 * it is the persistence boundary, because a CRDT held only in memory is a CRDT that loses a
 * session's work the first time the process restarts.
 *
 * So: the room is **seeded from the project's saved scene** when the first person joins, and
 * **written back as a new version** when the last person leaves or after a quiet period. That makes
 * the existing version history the durable store and the CRDT the live layer, rather than
 * introducing a second source of truth that the two have to be reconciled against later.
 */

export interface RoomStore {
  /** The scene to seed a new room from, or null if the project has never been saved. */
  loadScene(projectId: string): Promise<Scene | null>;
  /** Persists the room's current state. Called on quiesce, not on every keystroke. */
  saveScene(projectId: string, scene: Scene): Promise<void>;
}

export interface Room {
  projectId: string;
  doc: Y.Doc;
  /** Everyone currently connected. Used to decide when a room is finished. */
  readonly clients: Set<object>;
  /** Whether anything has changed since the last successful save. */
  dirty: boolean;
  saveTimer: NodeJS.Timeout | null;
}

/**
 * How long a room waits after an edit before writing a version.
 *
 * Long enough that a drag does not produce forty versions, short enough that a browser crash costs
 * seconds rather than an afternoon. It is a debounce rather than an interval on purpose: a room
 * where nobody is typing should not be writing rows.
 */
export const SAVE_DEBOUNCE_MS = 5_000;

export class Rooms {
  readonly #store: RoomStore;
  readonly #rooms = new Map<string, Room>();
  readonly #debounceMs: number;

  constructor(store: RoomStore, options: { debounceMs?: number } = {}) {
    this.#store = store;
    this.#debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
  }

  /**
   * The room for a project, created and seeded if this is the first arrival.
   *
   * Seeding reads the saved scene. If the project has never been saved there is nothing to seed
   * from, and the room starts empty rather than inventing a document — an empty room is a truthful
   * representation of an empty project, and a fabricated one would be a scene the user never made.
   */
  async join(projectId: string, client: object): Promise<Room> {
    let room = this.#rooms.get(projectId);

    if (!room) {
      room = {
        projectId,
        doc: new Y.Doc(),
        clients: new Set<object>(),
        dirty: false,
        saveTimer: null,
      };
      this.#rooms.set(projectId, room);

      const saved = await this.#store.loadScene(projectId);
      // Re-checked after the await: a second client can arrive while the first one's load is in
      // flight, and seeding twice would apply the saved scene over live edits.
      if (saved && isEmpty(room.doc)) seedScene(room.doc, saved, 'server');

      room.doc.on('update', (_update: Uint8Array, origin: unknown) => {
        // The server's own seed is not an edit. Marking it dirty would write a version identical to
        // the one just read, on every single room that anybody opens.
        if (origin === 'server') return;
        this.#markDirty(room!);
      });
    }

    room.clients.add(client);
    return room;
  }

  /**
   * Removes a client, and saves if that was the last one.
   *
   * The room is kept in memory for now rather than dropped the instant it empties: a reload takes
   * a second or two, and evicting the document in that window would mean the returning client
   * re-seeds from the last saved version and loses anything not yet written.
   */
  async leave(projectId: string, client: object): Promise<void> {
    const room = this.#rooms.get(projectId);
    if (!room) return;

    room.clients.delete(client);
    if (room.clients.size > 0) return;

    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    await this.save(room);
  }

  /** Writes the room's document back as a scene, if it has changed. */
  async save(room: Room): Promise<void> {
    if (!room.dirty) return;
    if (isEmpty(room.doc)) return;

    let scene: Scene;
    try {
      scene = readScene(room.doc);
    } catch (error) {
      // A document that does not parse is a document that must not be written over a version that
      // does. Reported loudly and left alone — the live clients still have their own valid copies,
      // and overwriting good history with bad is the one unrecoverable outcome here.
      console.error(`[collab] room ${room.projectId} holds a scene that does not validate`, error);
      return;
    }

    // Cleared *before* the write, so an edit that lands during it re-dirties the room rather than
    // being folded into a save that had already read the document.
    room.dirty = false;
    try {
      await this.#store.saveScene(room.projectId, scene);
    } catch (error) {
      room.dirty = true;
      console.error(`[collab] room ${room.projectId} could not be saved`, error);
    }
  }

  /** For shutdown: flush every room that has unsaved work. */
  async saveAll(): Promise<void> {
    await Promise.all([...this.#rooms.values()].map((room) => this.save(room)));
  }

  get size(): number {
    return this.#rooms.size;
  }

  peek(projectId: string): Room | undefined {
    return this.#rooms.get(projectId);
  }

  #markDirty(room: Room): void {
    room.dirty = true;
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      void this.save(room);
    }, this.#debounceMs);
    // Unref'd so a pending save never holds the process open past a shutdown that has already
    // flushed everything.
    room.saveTimer.unref?.();
  }
}
