import * as THREE from 'three';
import { z } from 'zod';
import type { Behavior, BehaviorDefinition, GameObject } from './Behavior.js';

export const PatrolParamsSchema = z.object({
  /** World-space points to walk between. Fewer than two and the object simply stands still. */
  waypoints: z.array(z.tuple([z.number(), z.number(), z.number()])).default([]),
  /** Metres per second. */
  speed: z.number().min(0).max(50).default(2),
  /** `loop` returns to the first waypoint; `pingPong` walks the path back the way it came. */
  mode: z.enum(['loop', 'pingPong']).default('loop'),
  /** Turn towards the direction of travel. Off for objects with no meaningful front. */
  faceDirection: z.boolean().default(true),
  /** Seconds to wait on reaching each waypoint. */
  waitSeconds: z.number().min(0).max(60).default(0),
});

export type PatrolParams = z.infer<typeof PatrolParamsSchema>;

/** How close counts as arrived. Small enough to look precise, large enough to never orbit a point. */
const ARRIVAL_EPSILON = 0.05;

/** Patrolling is the baseline claim on an object's movement — everything else outranks it. */
const PATROL_PRIORITY = 0;

/**
 * Walks an object along a list of waypoints.
 *
 * The first behaviour, and the shape every later one follows: all state lives on the instance,
 * nothing is read from the document at runtime, and the only thing it touches is its own node.
 * That is what lets the very same class run in the editor's preview and inside an export.
 */
export class PatrolBehavior implements Behavior {
  readonly #params: PatrolParams;
  readonly #target = new THREE.Vector3();
  readonly #direction = new THREE.Vector3();

  #index = 0;
  #step = 1;
  #waiting = 0;

  constructor(params: PatrolParams) {
    this.#params = params;
  }

  onInit(object: GameObject): void {
    const [first] = this.#params.waypoints;
    if (!first) return;

    // Starting on the first waypoint rather than wherever the object was placed keeps the path
    // the thing the user drew, not the thing plus an opening lunge.
    object.node.position.set(first[0], first[1], first[2]);
    this.#index = this.#params.waypoints.length > 1 ? 1 : 0;
  }

  onUpdate(object: GameObject, deltaSeconds: number): void {
    const { waypoints, speed, mode, faceDirection, waitSeconds } = this.#params;
    if (waypoints.length < 2 || speed === 0) return;

    // The lowest claim there is: a patrol route is what an object does when nothing more urgent
    // is happening to it, so anything else on the object outranks it.
    if (!object.requestControl(PATROL_PRIORITY)) return;

    if (this.#waiting > 0) {
      this.#waiting = Math.max(0, this.#waiting - deltaSeconds);
      return;
    }

    const next = waypoints[this.#index];
    if (!next) return;

    this.#target.set(next[0], next[1], next[2]);
    this.#direction.copy(this.#target).sub(object.node.position);
    const distance = this.#direction.length();

    if (distance <= ARRIVAL_EPSILON) {
      object.node.position.copy(this.#target);
      this.#advance(waypoints.length, mode);
      this.#waiting = waitSeconds;
      return;
    }

    // Never overshoot: a slow frame would otherwise sail past the waypoint and turn a patrol into
    // a widening zig-zag.
    const travel = Math.min(speed * deltaSeconds, distance);
    this.#direction.divideScalar(distance);
    object.node.position.addScaledVector(this.#direction, travel);

    if (faceDirection) {
      object.node.rotation.y = Math.atan2(this.#direction.x, this.#direction.z);
    }
  }

  #advance(count: number, mode: PatrolParams['mode']): void {
    if (mode === 'loop') {
      this.#index = (this.#index + 1) % count;
      return;
    }

    if (this.#index + this.#step >= count || this.#index + this.#step < 0) {
      this.#step *= -1;
    }
    this.#index += this.#step;
  }
}

export const patrolDefinition: BehaviorDefinition<typeof PatrolParamsSchema> = {
  type: 'patrol',
  label: 'Patrol',
  description: 'Walks between waypoints, looping or bouncing back along the path.',
  params: PatrolParamsSchema,
  create: (params) => new PatrolBehavior(params),
};
