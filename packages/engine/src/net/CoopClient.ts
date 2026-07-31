import type { MultiplayerConfig } from '@helaengine/schema';
import type { RemotePlayerSnapshot } from './RemotePlayers.js';

/** What this client wants to do next. Intent only — the server decides where it ends up. */
export interface CoopInput {
  forward: number;
  right: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  yaw: number;
}

export type CoopStatus = 'idle' | 'connecting' | 'connected' | 'failed' | 'closed';

/**
 * The transport, as this client needs it.
 *
 * An interface rather than a direct `colyseus.js` import, and for a reason that matters to the whole
 * project rather than to this file: `packages/engine` ships inside every export, and a hard
 * dependency on a networking library would put a socket client in the bundle of every
 * single-player game anybody ever makes. The host supplies one when — and only when — the document
 * asks for multiplayer.
 */
export interface CoopTransport {
  connect(options: {
    url: string;
    sceneId: string;
    scene: unknown;
    name: string;
  }): Promise<{ sessionId: string }>;
  send(type: string, payload: unknown): void;
  /** Called whenever the server's player list changes. */
  onPlayers(listener: (players: RemotePlayerSnapshot[]) => void): void;
  onMessage(type: string, listener: (payload: unknown) => void): void;
  leave(): Promise<void>;
}

export interface CoopClientOptions {
  config: MultiplayerConfig;
  transport: CoopTransport;
  sceneId: string;
  scene: unknown;
  name?: string;
  warn?: (message: string) => void;
}

/**
 * This client's half of a co-op session.
 *
 * Two jobs, and deliberately no others: send this player's intent at a fixed rate, and hand the
 * server's answer to whatever draws it. It does not simulate, does not predict and does not
 * reconcile — every position it reports came off the wire.
 *
 * Input is throttled to `inputHz` rather than sent per frame. Sixty packets a second buys detail no
 * player can perceive, and the server ticks at twenty regardless.
 */
export class CoopClient {
  readonly #transport: CoopTransport;
  readonly #config: MultiplayerConfig;
  readonly #sceneId: string;
  readonly #scene: unknown;
  readonly #name: string;
  readonly #warn: (message: string) => void;

  #status: CoopStatus = 'idle';
  #sessionId = '';
  #players: RemotePlayerSnapshot[] = [];
  #sinceSend = 0;
  #seq = 0;
  #error: string | null = null;

  constructor(options: CoopClientOptions) {
    this.#transport = options.transport;
    this.#config = options.config;
    this.#sceneId = options.sceneId;
    this.#scene = options.scene;
    this.#name = options.name ?? '';
    this.#warn = options.warn ?? ((message) => console.warn(`[helaengine] ${message}`));
  }

  get status(): CoopStatus {
    return this.#status;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  /** Everyone in the session, this player included. */
  get players(): readonly RemotePlayerSnapshot[] {
    return this.#players;
  }

  /** Why the connection failed, for a message the player can act on. */
  get error(): string | null {
    return this.#error;
  }

  async connect(): Promise<boolean> {
    if (!this.#config.enabled || this.#config.mode !== 'coop') return false;
    if (!this.#config.serverUrl) {
      // Saying so beats a silent single-player game that the author believed was co-op.
      this.#error = 'multiplayer is on but no server URL is set';
      this.#status = 'failed';
      this.#warn(this.#error);
      return false;
    }

    this.#status = 'connecting';
    try {
      const { sessionId } = await this.#transport.connect({
        url: this.#config.serverUrl,
        sceneId: this.#sceneId,
        scene: this.#scene,
        name: this.#name,
      });
      this.#sessionId = sessionId;
      this.#status = 'connected';
      this.#transport.onPlayers((players) => {
        this.#players = players;
      });
      return true;
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      this.#status = 'failed';
      // A failed connection drops to single player rather than refusing to start. Somebody who
      // wanted to play should be playing, even alone.
      this.#warn(`co-op connection failed, playing solo: ${this.#error}`);
      return false;
    }
  }

  /** One frame. Sends this player's intent when the throttle allows. */
  update(deltaSeconds: number, input: CoopInput): void {
    if (this.#status !== 'connected') return;

    this.#sinceSend += deltaSeconds;
    const interval = 1 / this.#config.inputHz;
    if (this.#sinceSend < interval) return;

    this.#sinceSend = 0;
    this.#seq += 1;
    this.#transport.send('input', { ...input, seq: this.#seq });
  }

  /** Asks the server to apply damage. It decides; this is a request, not a statement. */
  reportDamage(amount: number): void {
    if (this.#status === 'connected') this.#transport.send('damage', { amount });
  }

  /** Asks the server to remove an object for everybody. */
  reportDestroyed(objectId: string): void {
    if (this.#status === 'connected') this.#transport.send('destroy', { objectId });
  }

  onMessage(type: string, listener: (payload: unknown) => void): void {
    this.#transport.onMessage(type, listener);
  }

  async disconnect(): Promise<void> {
    if (this.#status !== 'connected') {
      this.#status = 'closed';
      return;
    }
    this.#status = 'closed';
    this.#players = [];
    await this.#transport.leave().catch(() => undefined);
  }
}
