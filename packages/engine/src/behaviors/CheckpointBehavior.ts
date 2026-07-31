import * as THREE from 'three';
import { z } from 'zod';
import { CheckpointResetSchema } from '@helaengine/schema';
import type { Behavior, BehaviorDefinition, GameObject } from './Behavior.js';

export const CheckpointParamsSchema = z.object({
  /** How close the player has to get, in metres. */
  radius: z.number().min(0.2).max(30).default(2.5),
  /** What coming back here restores. */
  reset: CheckpointResetSchema,
  /**
   * Re-arm after being passed.
   *
   * Off by default: walking back over a checkpoint you already have should not re-save, or every
   * lap of a level costs a write and the "saved" notice cries wolf.
   */
  repeatable: z.boolean().default(false),
  /** Named sound event raised on activation. A name, never a path — Sprint 19 maps names to clips. */
  sfxEvent: z.string().max(64).default('checkpoint'),
});

export type CheckpointParams = z.infer<typeof CheckpointParamsSchema>;

/** How far above or below its feet the player still counts as having reached it. */
const VERTICAL_TOLERANCE = 3;

const toPlayer = new THREE.Vector3();
const here = new THREE.Vector3();

/**
 * A place the player comes back to.
 *
 * Shaped exactly like `PickupBehavior` — a radius, a proximity test, one call into the world — for
 * the good reason that they are the same gesture: walk into a thing, something happens. The engine
 * gets a second kind of world-marker without a second way of writing one.
 *
 * The reset rules travel with the request rather than being looked up at respawn time. That means
 * a checkpoint reached before its rules were edited keeps the rules it was reached under, which is
 * the honest reading of a save: it records what happened, not what the document says now.
 */
export class CheckpointBehavior implements Behavior {
  readonly #params: CheckpointParams;
  #reached = false;

  constructor(params: CheckpointParams) {
    this.#params = params;
  }

  get reached(): boolean {
    return this.#reached;
  }

  onUpdate(object: GameObject): void {
    if (this.#reached && !this.#params.repeatable) return;

    const player = object.world.playerPosition();
    if (!player) return;

    object.node.getWorldPosition(here);
    toPlayer.copy(player).sub(here);
    if (Math.abs(toPlayer.y) > VERTICAL_TOLERANCE) return;
    toPlayer.y = 0;
    if (toPlayer.lengthSq() > this.#params.radius * this.#params.radius) return;

    // The world decides whether this is news. Re-entering the checkpoint you already hold is not,
    // and it answering so is what keeps a repeatable checkpoint from saving on every frame.
    const accepted = object.world.setCheckpoint({
      objectId: object.id,
      position: [here.x, here.y, here.z],
      reset: this.#params.reset,
    });
    if (!accepted) return;

    this.#reached = true;
    object.emit(this.#params.sfxEvent, { objectId: object.id });
  }
}

export const checkpointDefinition: BehaviorDefinition<typeof CheckpointParamsSchema> = {
  type: 'checkpoint',
  label: 'Checkpoint',
  description:
    'Becomes the place the player comes back to on death, and saves progress. Configure what it restores.',
  params: CheckpointParamsSchema,
  create: (params) => new CheckpointBehavior(params),
};
