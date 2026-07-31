import * as THREE from 'three';
import type { Player } from '@helaengine/schema';
import { createPlayerAvatar, type PlayerAvatar } from '../camera/PlayerAvatar.js';

/** One other player, as this client last heard of them. */
export interface RemotePlayerSnapshot {
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

interface Remote {
  avatar: PlayerAvatar;
  /** Where the server last said they were. */
  readonly target: THREE.Vector3;
  /** Where this client is drawing them, which lags the target and catches up smoothly. */
  readonly shown: THREE.Vector3;
  targetYaw: number;
  shownYaw: number;
  crouched: boolean;
}

/**
 * How fast a remote avatar closes the gap to where the server says it is, per second.
 *
 * Interpolation rather than teleporting to each update: the server broadcasts twenty times a
 * second and the client draws sixty, so snapping means every remote player visibly stutters. Twelve
 * is fast enough that the lag is imperceptible and slow enough to smooth a late packet.
 */
const CATCH_UP_RATE = 12;

/** Beyond this, catching up smoothly would be a long glide through the scenery. */
const TELEPORT_DISTANCE = 8;

const scratch = new THREE.Vector3();

/**
 * The other people in the world.
 *
 * Draws an avatar per remote player and moves it towards wherever the server last said they were.
 * Nothing here simulates: a remote player's position is a fact received, never a guess, which is
 * what "server-authoritative" means on the client side of the wire.
 *
 * Interpolating rather than predicting is also the honest scope line for a co-op slice. Prediction
 * is what a competitive shooter needs and it brings rollback and reconciliation with it; a remote
 * player who is 100 ms behind is not something two friends exploring a level will ever notice.
 */
export class RemotePlayers {
  readonly #root: THREE.Object3D;
  readonly #player: Player;
  readonly #remotes = new Map<string, Remote>();

  constructor(root: THREE.Object3D, player: Player) {
    this.#root = root;
    this.#player = player;
  }

  get count(): number {
    return this.#remotes.size;
  }

  ids(): string[] {
    return [...this.#remotes.keys()];
  }

  /** Where a remote avatar is being drawn, which is what a test should assert on. */
  positionOf(sessionId: string): THREE.Vector3 | null {
    return this.#remotes.get(sessionId)?.shown ?? null;
  }

  /**
   * Reconciles against the server's list.
   *
   * `localSessionId` is excluded: this client draws itself through the camera rig, and a second
   * avatar standing in its own eye would be the first thing anybody reported.
   */
  sync(snapshots: readonly RemotePlayerSnapshot[], localSessionId: string): void {
    const seen = new Set<string>();

    for (const snapshot of snapshots) {
      if (snapshot.sessionId === localSessionId) continue;
      seen.add(snapshot.sessionId);

      let remote = this.#remotes.get(snapshot.sessionId);
      if (!remote) {
        const avatar = createPlayerAvatar(this.#player);
        this.#root.add(avatar.node);
        remote = {
          avatar,
          target: new THREE.Vector3(snapshot.x, snapshot.y, snapshot.z),
          shown: new THREE.Vector3(snapshot.x, snapshot.y, snapshot.z),
          targetYaw: snapshot.yaw,
          shownYaw: snapshot.yaw,
          crouched: snapshot.crouched,
        };
        this.#remotes.set(snapshot.sessionId, remote);
      }

      remote.target.set(snapshot.x, snapshot.y, snapshot.z);
      remote.targetYaw = snapshot.yaw;
      remote.crouched = snapshot.crouched;
    }

    for (const [sessionId, remote] of this.#remotes) {
      if (seen.has(sessionId)) continue;
      remote.avatar.node.removeFromParent();
      remote.avatar.dispose();
      this.#remotes.delete(sessionId);
    }
  }

  /** Advances the interpolation. Called every frame, not every packet. */
  update(deltaSeconds: number): void {
    const blend = 1 - Math.exp(-CATCH_UP_RATE * deltaSeconds);

    for (const remote of this.#remotes.values()) {
      // A player who respawned or was teleported has moved further than any walk could; gliding
      // them there would be a long, silly slide through the level.
      if (remote.shown.distanceTo(remote.target) > TELEPORT_DISTANCE) {
        remote.shown.copy(remote.target);
        remote.shownYaw = remote.targetYaw;
      } else {
        remote.shown.lerp(remote.target, blend);
        remote.shownYaw = interpolateAngle(remote.shownYaw, remote.targetYaw, blend);
      }

      remote.avatar.update(remote.shown, remote.shownYaw, remote.crouched);
    }
  }

  dispose(): void {
    for (const remote of this.#remotes.values()) {
      remote.avatar.node.removeFromParent();
      remote.avatar.dispose();
    }
    this.#remotes.clear();
    scratch.set(0, 0, 0);
  }
}

/**
 * Blends two angles the short way round.
 *
 * A plain lerp from 3.1 to -3.1 radians spins the avatar the whole way around rather than the few
 * degrees it actually turned — the classic wrap bug, and very visible on a character.
 */
export function interpolateAngle(from: number, to: number, blend: number): number {
  let difference = (to - from) % (Math.PI * 2);
  if (difference > Math.PI) difference -= Math.PI * 2;
  if (difference < -Math.PI) difference += Math.PI * 2;
  return from + difference * blend;
}
