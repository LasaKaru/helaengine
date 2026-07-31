import { Client, type Room } from 'colyseus.js';
import type { CoopTransport, RemotePlayerSnapshot } from '@helaengine/engine';

/** The player fields the room broadcasts. Mirrors the server's `PlayerState`. */
interface WirePlayer {
  sessionId: string;
  name: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  health: number;
  crouched: boolean;
  speed: number;
}

interface WireState {
  players: Map<string, WirePlayer> & { onAdd?: unknown; onRemove?: unknown };
  sceneId: string;
  tick: number;
  destroyedObjectIds: string[];
}

/**
 * Colyseus, behind the engine's transport interface.
 *
 * It lives in the editor rather than in `packages/engine` on purpose. The engine ships inside every
 * exported project, and a hard dependency on a socket library would put a networking client in the
 * bundle of every single-player game anybody ever makes. The host supplies one when the document
 * asks for multiplayer, and Sprint 22's exporter will do exactly the same thing.
 */
export class ColyseusTransport implements CoopTransport {
  #room: Room<WireState> | null = null;
  #onPlayers: ((players: RemotePlayerSnapshot[]) => void) | null = null;

  async connect(options: {
    url: string;
    sceneId: string;
    scene: unknown;
    name: string;
  }): Promise<{ sessionId: string }> {
    const client = new Client(options.url);
    // `joinOrCreate` is what makes "send your friend the link" work: the first person through the
    // door opens the room, everybody after joins it.
    const room = await client.joinOrCreate<WireState>('coop', {
      scene: options.scene,
      sceneId: options.sceneId,
      name: options.name,
    });

    this.#room = room;
    room.onStateChange(() => this.#publish());
    return { sessionId: room.sessionId };
  }

  send(type: string, payload: unknown): void {
    this.#room?.send(type, payload);
  }

  onPlayers(listener: (players: RemotePlayerSnapshot[]) => void): void {
    this.#onPlayers = listener;
    this.#publish();
  }

  onMessage(type: string, listener: (payload: unknown) => void): void {
    this.#room?.onMessage(type, listener);
  }

  async leave(): Promise<void> {
    const room = this.#room;
    this.#room = null;
    this.#onPlayers = null;
    await room?.leave();
  }

  #publish(): void {
    const room = this.#room;
    if (!room || !this.#onPlayers) return;

    const players: RemotePlayerSnapshot[] = [];
    room.state.players.forEach((player, sessionId) => {
      players.push({
        // The map key is the session id; the field is a convenience the server also sets, and
        // trusting the key means one fewer thing that can disagree.
        sessionId,
        name: player.name,
        x: player.x,
        y: player.y,
        z: player.z,
        yaw: player.yaw,
        health: player.health,
        crouched: player.crouched,
        speed: player.speed,
      });
    });
    this.#onPlayers(players);
  }
}
