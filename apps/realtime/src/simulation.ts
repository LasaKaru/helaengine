import * as THREE from 'three';
import {
  ManifestAssetResolver,
  PhysicsWorld,
  SceneLoader,
  buildScenePhysics,
  type PlayerController,
} from '@helaengine/engine';
import type { AssetManifest, Scene } from '@helaengine/schema';

/** One frame of intent from a client. The only thing a client is allowed to send. */
export interface PlayerInput {
  forward: number;
  right: number;
  jump: boolean;
  sprint: boolean;
  crouch: boolean;
  yaw: number;
  /** Monotonic per client. Echoed back so a future prediction layer can reconcile against it. */
  seq: number;
}

export interface SimulatedPlayer {
  sessionId: string;
  controller: PlayerController;
  input: PlayerInput;
  health: number;
}

const ZERO_INPUT: PlayerInput = {
  forward: 0,
  right: 0,
  jump: false,
  sprint: false,
  crouch: false,
  yaw: 0,
  seq: 0,
};

/**
 * Clamp on a single input.
 *
 * A client sending `forward: 1e9` is not a faster player, it is a client sending nonsense — either
 * a bug or somebody trying it on. Clamping here rather than trusting the wire is the difference
 * between a server that is authoritative and one that merely runs on a server.
 */
function sanitise(raw: unknown): PlayerInput {
  const input = raw as Partial<PlayerInput> | undefined;
  const axis = (value: unknown): number => {
    const number = typeof value === 'number' && Number.isFinite(value) ? value : 0;
    return Math.max(-1, Math.min(1, number));
  };

  return {
    forward: axis(input?.forward),
    right: axis(input?.right),
    jump: input?.jump === true,
    sprint: input?.sprint === true,
    crouch: input?.crouch === true,
    yaw:
      typeof input?.yaw === 'number' && Number.isFinite(input.yaw) ? input.yaw : 0,
    seq:
      typeof input?.seq === 'number' && Number.isFinite(input.seq)
        ? Math.max(0, Math.floor(input.seq))
        : 0,
  };
}

/**
 * The authoritative world, running the engine's own physics in Node.
 *
 * This class is the strongest test the "engine never imports the editor" rule has had. The very
 * same `PhysicsWorld`, `PlayerController` and `SceneLoader` that draw the editor's preview run here
 * with no browser, no renderer and no DOM — which is exactly the property that makes an export
 * possible, checked somewhere it cannot be faked.
 *
 * Deliberately free of Colyseus: this simulates, and the room broadcasts. That split is what lets
 * the whole simulation be tested without a socket.
 */
export class CoopSimulation {
  readonly scene: Scene;
  readonly #players = new Map<string, SimulatedPlayer>();
  readonly #physics: PhysicsWorld;
  readonly #spawn: THREE.Vector3;
  readonly #destroyed = new Set<string>();
  #tick = 0;

  private constructor(scene: Scene, physics: PhysicsWorld, spawn: THREE.Vector3) {
    this.scene = scene;
    this.#physics = physics;
    this.#spawn = spawn;
  }

  /**
   * Builds a world from a scene document.
   *
   * Async because Rapier is WebAssembly and has to be fetched and instantiated once — the same
   * single async door into physics the browser goes through.
   */
  static async create(scene: Scene, manifest: AssetManifest): Promise<CoopSimulation> {
    const resolver = new ManifestAssetResolver(manifest);
    // Placeholders rather than GLBs: the server needs bounds and colliders, and it has no business
    // downloading art it will never draw. `SceneLoader` builds those synchronously.
    const loader = new SceneLoader({ resolver, warn: () => {} });
    const loaded = loader.load(scene);

    const physics = await PhysicsWorld.create({ gravity: scene.player.gravity });
    buildScenePhysics({ world: physics, scene, loaded, resolver });

    const [x, y, z] = scene.player.spawn;
    const ground = loaded.terrainField?.sampleHeight(x, z) ?? 0;
    const spawn = new THREE.Vector3(x, Math.max(y, ground + 0.5), z);

    return new CoopSimulation(scene, physics, spawn);
  }

  get playerCount(): number {
    return this.#players.size;
  }

  get tick(): number {
    return this.#tick;
  }

  get destroyedObjectIds(): string[] {
    return [...this.#destroyed];
  }

  players(): Iterable<SimulatedPlayer> {
    return this.#players.values();
  }

  player(sessionId: string): SimulatedPlayer | undefined {
    return this.#players.get(sessionId);
  }

  /** Adds a character for a joining client, at the scene's spawn point. */
  add(sessionId: string): SimulatedPlayer {
    this.remove(sessionId);

    // Fanned out around the spawn so two players joining together do not start inside each other,
    // which the character controller resolves by shoving one of them somewhere surprising.
    const angle = (this.#players.size * Math.PI * 2) / 6;
    const offset = this.#players.size === 0 ? 0 : 1.2;
    const at = new THREE.Vector3(
      this.#spawn.x + Math.cos(angle) * offset,
      this.#spawn.y,
      this.#spawn.z + Math.sin(angle) * offset,
    );

    const player: SimulatedPlayer = {
      sessionId,
      controller: this.#physics.createPlayer(this.scene.player, at),
      input: { ...ZERO_INPUT },
      health: this.scene.player.health,
    };
    this.#players.set(sessionId, player);
    return player;
  }

  remove(sessionId: string): void {
    const player = this.#players.get(sessionId);
    if (!player) return;

    player.controller.dispose();
    this.#players.delete(sessionId);
  }

  /**
   * Records what a client wants to do next.
   *
   * Stored rather than applied: the simulation advances on its own clock, so an input that arrives
   * three times between two ticks counts once and one that arrives late still counts. A client that
   * stops sending simply keeps its last intent, which is what a dropped packet should look like.
   */
  setInput(sessionId: string, raw: unknown): void {
    const player = this.#players.get(sessionId);
    if (!player) return;

    const input = sanitise(raw);
    // Out-of-order arrivals are dropped rather than rewinding the player's intent.
    if (input.seq > 0 && input.seq < player.input.seq) return;
    player.input = input;
  }

  /** Marks an object as gone for everybody. Returns whether it was news. */
  destroy(objectId: string): boolean {
    if (this.#destroyed.has(objectId)) return false;
    this.#destroyed.add(objectId);
    this.#physics.removeObject(objectId);
    return true;
  }

  /** Applies damage. Returns the new health, or null when there is no such player. */
  damage(sessionId: string, amount: number): number | null {
    const player = this.#players.get(sessionId);
    if (!player) return null;

    player.health = Math.max(0, player.health - Math.max(0, amount));
    if (player.health === 0) {
      player.health = this.scene.player.health;
      player.controller.teleport(this.#spawn);
    }
    return player.health;
  }

  /** One server tick. Every character is moved by its own stored input, then the solver runs. */
  step(deltaSeconds: number): void {
    this.#tick += 1;
    this.#physics.step(deltaSeconds, (fixedStep) => {
      for (const player of this.#players.values()) {
        player.controller.move(player.input, fixedStep);
      }
    });
  }

  dispose(): void {
    for (const sessionId of [...this.#players.keys()]) this.remove(sessionId);
    this.#physics.dispose();
  }
}
