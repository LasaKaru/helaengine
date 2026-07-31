// Colyseus 0.15 is CommonJS, and Node's ESM interop cannot always see its named exports — a
// default import plus a destructure works under both `tsx` and a bundler, where the named form
// only works under one.
import colyseus, { type Client } from 'colyseus';
const { Room } = colyseus;
import { AssetManifestSchema, safeParseScene, type AssetManifest, type Scene } from '@helaengine/schema';
import { CoopSimulation } from './simulation.js';
import { PlayerState, RoomState } from './state.js';

/** How often the server simulates and broadcasts, in hertz. */
export const TICK_HZ = 20;

export interface CoopRoomOptions {
  /** The scene to simulate. Parsed and rejected if it does not validate. */
  scene: unknown;
  manifest?: unknown;
  maxPlayers?: number;
  name?: string;
}

/**
 * A co-op session: several people in one world, with the server deciding where everybody is.
 *
 * **Scope, stated rather than implied.** This is co-op — shared world, shared enemies, everyone
 * sees everyone move. It is not competitive netcode. There is no client-side prediction, no
 * rollback and no lag compensation on shots, so a player with 150 ms of latency sees themselves
 * move 150 ms late. For two friends exploring a level that is unremarkable; for a deathmatch it
 * would be unplayable, which is exactly why `mode: 'deathmatch'` exists in the schema and does
 * nothing here.
 *
 * The room owns the socket and nothing else. Everything about *what happens* lives in
 * `CoopSimulation`, which has no Colyseus in it and can therefore be tested without one.
 */
export class CoopRoom extends Room<RoomState> {
  #simulation: CoopSimulation | null = null;
  #scene: Scene | null = null;

  override async onCreate(options: CoopRoomOptions): Promise<void> {
    const parsed = safeParseScene(options.scene);
    if (!parsed.success) {
      // A room built on a document the server cannot read would desync every client in a way
      // nobody could diagnose. Refusing to open is the loud failure.
      throw new Error(`scene did not validate: ${parsed.error.issues[0]?.message ?? 'unknown'}`);
    }

    const scene = parsed.data;
    const manifest: AssetManifest = AssetManifestSchema.parse(
      options.manifest ?? { version: 1, assets: [] },
    );

    this.#scene = scene;
    this.setState(new RoomState());
    this.state.sceneId = scene.sceneId;
    this.maxClients = Math.max(
      2,
      Math.min(options.maxPlayers ?? scene.gameConfig.multiplayer.maxPlayers, 64),
    );

    this.#simulation = await CoopSimulation.create(scene, manifest);

    this.onMessage('input', (client, message) => {
      this.#simulation?.setInput(client.sessionId, message);
    });

    // Damage and destruction arrive as *requests*, and the server decides. A client saying "I took
    // 40 damage" is a client that can also say "I took none".
    this.onMessage('damage', (client, message: { amount?: number }) => {
      const health = this.#simulation?.damage(client.sessionId, Number(message?.amount) || 0);
      const player = this.state.players.get(client.sessionId);
      if (player && health !== null && health !== undefined) player.health = health;
    });

    this.onMessage('destroy', (_client, message: { objectId?: string }) => {
      const objectId = String(message?.objectId ?? '');
      if (!objectId || !this.#simulation?.destroy(objectId)) return;
      this.state.destroyedObjectIds = this.#simulation.destroyedObjectIds;
      this.broadcast('objectDestroyed', { objectId });
    });

    this.setSimulationInterval((deltaMs) => this.#tick(deltaMs / 1000), 1000 / TICK_HZ);
  }

  override onJoin(client: Client, options?: { name?: string; sceneId?: string }): void {
    const simulation = this.#simulation;
    if (!simulation) throw new Error('room is not ready');

    // A client whose document is a different scene would see everybody standing in the wrong
    // world. Better to refuse the join than to let them wander through geometry nobody else has.
    if (options?.sceneId && options.sceneId !== this.state.sceneId) {
      throw new Error(`this room is playing ${this.state.sceneId}`);
    }

    const simulated = simulation.add(client.sessionId);
    const player = new PlayerState();
    player.sessionId = client.sessionId;
    player.name = (options?.name ?? '').slice(0, 32) || `Player ${simulation.playerCount}`;
    player.health = simulated.health;
    this.#copyInto(player, client.sessionId);
    this.state.players.set(client.sessionId, player);
  }

  override onLeave(client: Client): void {
    this.#simulation?.remove(client.sessionId);
    this.state.players.delete(client.sessionId);
  }

  override onDispose(): void {
    this.#simulation?.dispose();
    this.#simulation = null;
  }

  /** The scene this room is running, for tests and for a future admin readout. */
  get scene(): Scene | null {
    return this.#scene;
  }

  #tick(deltaSeconds: number): void {
    const simulation = this.#simulation;
    if (!simulation) return;

    simulation.step(deltaSeconds);
    this.state.tick = simulation.tick;

    // Colyseus patches: only the fields that actually changed go on the wire, which is why the
    // state schema is worth keeping small.
    for (const [sessionId, player] of this.state.players) {
      this.#copyInto(player, sessionId);
    }
  }

  #copyInto(player: PlayerState, sessionId: string): void {
    const simulated = this.#simulation?.player(sessionId);
    if (!simulated) return;

    const { controller, input } = simulated;
    player.x = controller.position.x;
    player.y = controller.position.y;
    player.z = controller.position.z;
    player.yaw = input.yaw;
    player.grounded = controller.grounded;
    player.crouched = controller.crouched;
    player.speed = controller.speed;
    player.health = simulated.health;
    player.lastInputSeq = input.seq;
  }
}
