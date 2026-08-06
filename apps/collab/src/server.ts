import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Rooms, type RoomStore } from './rooms.js';

/**
 * The collaboration server.
 *
 * Speaks the `y-websocket` protocol, but is not `y-websocket`'s bundled server, and the difference
 * is the reason this file exists: the stock server will put anybody who knows a room name into that
 * room. A room here is a *project*, and a project belongs to an organisation — so a socket has to
 * prove membership before it sees a single byte of somebody's level.
 *
 * A third deployable service, alongside the API and the co-op server. Same argument as the co-op
 * server's: this process holds long-lived sockets and a document per open project in memory, which
 * scales on a different axis from bursty HTTP and should not be able to stall it.
 */

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** Verifies a token against the platform API and answers who it belongs to. */
export interface Authorizer {
  /**
   * Whether this token may edit this project, and which user it is.
   *
   * Returns null for "no" without distinguishing the reasons. A socket that cannot tell "no such
   * project" from "not your project" cannot be used to enumerate other people's projects.
   */
  authorize(token: string, projectId: string): Promise<{ userId: string } | null>;
}

export interface CollabServerOptions {
  store: RoomStore;
  auth: Authorizer;
  /** Overridable so tests do not wait five seconds to observe a save. */
  saveDebounceMs?: number;
}

export function createCollabServer(options: CollabServerOptions): {
  server: Server;
  rooms: Rooms;
} {
  const rooms = new Rooms(options.store, {
    ...(options.saveDebounceMs === undefined ? {} : { debounceMs: options.saveDebounceMs }),
  });

  const server = createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      // `rss` is here for the load tool, which has no other way to ask what a connection costs:
      // this process's memory is the scaling limit, and the number is only meaningful from inside.
      response.end(
        JSON.stringify({
          ok: true,
          service: 'helaengine-collab',
          rooms: rooms.size,
          rss: process.memoryUsage().rss,
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });

  const sockets = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    // Authorised during the upgrade rather than after it. A socket that is accepted and then told
    // to go away has already been accepted — and with Yjs the first thing a client does on open is
    // ask for the whole document.
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost');
      const projectId = url.searchParams.get('project') ?? url.pathname.replace(/^\/+/, '');
      const token = url.searchParams.get('token') ?? '';

      const who = projectId && token ? await options.auth.authorize(token, projectId) : null;
      if (!who) {
        // A 401 on the upgrade rather than a close frame after it: the client never gets a socket,
        // so there is no window in which it could send or receive document data.
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      sockets.handleUpgrade(request, socket, head, (connection) => {
        void attach(connection, projectId, who.userId);
      });
    })();
  });

  async function attach(connection: WebSocket, projectId: string, userId: string): Promise<void> {
    const room = await rooms.join(projectId, connection);
    const awareness = awarenessFor(room.doc);

    /**
     * The awareness client ids this socket speaks for.
     *
     * A socket does not know its peer's client id — the id is minted inside the browser's own
     * `Y.Doc` and only ever arrives inside an awareness update. So it is learned from the updates
     * this connection sends, and it is what makes an immediate goodbye possible on disconnect
     * rather than a thirty-second timeout during which a departed collaborator still has a cursor.
     */
    const mine = new Set<number>();

    const sendUpdate = (update: Uint8Array, origin: unknown): void => {
      // Not echoed to the client that caused it. Yjs would tolerate it — applying your own update
      // is a no-op — but it doubles the traffic of every drag for no benefit.
      if (origin === connection) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      send(connection, encoding.toUint8Array(encoder));
    };

    const sendAwareness = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === connection) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;

      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      send(connection, encoding.toUint8Array(encoder));
    };

    room.doc.on('update', sendUpdate);
    awareness.on('update', sendAwareness);

    connection.on('message', (data: ArrayBuffer | Buffer) => {
      try {
        const message = new Uint8Array(data as ArrayBuffer);
        const decoder = decoding.createDecoder(message);
        const encoder = encoding.createEncoder();

        switch (decoding.readVarUint(decoder)) {
          case MESSAGE_SYNC: {
            encoding.writeVarUint(encoder, MESSAGE_SYNC);
            // The origin is the connection, which is what lets `sendUpdate` skip echoing and what
            // lets a room tell a client's edit from its own seed.
            syncProtocol.readSyncMessage(decoder, encoder, room.doc, connection);
            if (encoding.length(encoder) > 1) send(connection, encoding.toUint8Array(encoder));
            break;
          }
          case MESSAGE_AWARENESS: {
            const update = decoding.readVarUint8Array(decoder);
            // Read before applying, so the ids this socket speaks for are known even for an update
            // that changes nothing — which is exactly what a heartbeat is.
            for (const id of clientIdsIn(update)) mine.add(id);
            awarenessProtocol.applyAwarenessUpdate(awareness, update, connection);
            break;
          }
          default:
            // An unknown message type from a client on a different build. Ignored rather than
            // fatal: one stale tab must not be able to drop everybody else out of the room.
            break;
        }
      } catch (error) {
        console.error(`[collab] bad message in ${projectId} from ${userId}`, error);
      }
    });

    const close = (): void => {
      room.doc.off('update', sendUpdate);
      awareness.off('update', sendAwareness);
      // The departing client's presence is removed here rather than left to time out, so the
      // remaining editors see somebody leave immediately instead of watching a ghost cursor for
      // thirty seconds.
      if (mine.size > 0) {
        awarenessProtocol.removeAwarenessStates(awareness, [...mine], 'disconnect');
      }
      void rooms.leave(projectId, connection);
    };

    connection.on('close', close);
    connection.on('error', close);

    // Step 1 of the sync protocol: "here is my state vector, send me what I am missing".
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, room.doc);
    send(connection, encoding.toUint8Array(encoder));

    const states = awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, [...states.keys()]),
      );
      send(connection, encoding.toUint8Array(awarenessEncoder));
    }
  }

  return { server, rooms };
}

/**
 * One awareness instance per document.
 *
 * Held in a `WeakMap` rather than on the room so that a document dropped from the room map takes
 * its presence with it, instead of leaving a set of cursors belonging to a room nobody is in.
 */
const awarenessByDoc = new WeakMap<Y.Doc, awarenessProtocol.Awareness>();

/**
 * The client ids an awareness update carries.
 *
 * The wire format is a count followed by that many `(clientId, clock, json)` triples, and the ids
 * are the first field of each. Decoded here rather than inferred from the awareness instance's
 * `added`/`updated` sets, because a heartbeat update changes neither of those and would leave the
 * server unable to say goodbye for a client that had connected but never moved.
 */
function clientIdsIn(update: Uint8Array): number[] {
  const decoder = decoding.createDecoder(update);
  const count = decoding.readVarUint(decoder);
  const ids: number[] = [];

  for (let index = 0; index < count; index += 1) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }

  return ids;
}

function awarenessFor(doc: Y.Doc): awarenessProtocol.Awareness {
  let awareness = awarenessByDoc.get(doc);
  if (!awareness) {
    awareness = new awarenessProtocol.Awareness(doc);
    // The server holds no presence of its own. Without this it appears in every room as a
    // participant with no name.
    awareness.setLocalState(null);
    awarenessByDoc.set(doc, awareness);
  }
  return awareness;
}

function send(connection: WebSocket, payload: Uint8Array): void {
  if (connection.readyState !== connection.OPEN) return;
  connection.send(payload, (error) => {
    if (error) connection.close();
  });
}
