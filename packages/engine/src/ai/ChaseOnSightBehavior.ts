import * as THREE from 'three';
import { z } from 'zod';
import { AI_STATE_ANIMATION } from '@helaengine/schema';
import type { Behavior, BehaviorDefinition, GameObject } from '../behaviors/Behavior.js';
import { StateMachine, type State } from './StateMachine.js';
import { SteeringAgent } from './SteeringAgent.js';

export const ChaseOnSightParamsSchema = z.object({
  /** How far the enemy can see, in metres. */
  sightRange: z.number().min(1).max(200).default(18),
  /** Cone of vision in degrees, centred on the way it is facing. 360 means it sees behind it. */
  fieldOfView: z.number().min(10).max(360).default(140),
  /** Metres per second while chasing. */
  chaseSpeed: z.number().min(0.5).max(30).default(4),
  /** How close it has to get before it starts swinging. */
  attackRange: z.number().min(0.5).max(20).default(2),
  attackDamage: z.number().min(0).max(1000).default(10),
  /** Seconds between blows. */
  attackInterval: z.number().min(0.1).max(30).default(1.2),
  health: z.number().min(1).max(10_000).default(30),
  /** Seconds of not seeing the player before it gives up and goes back to patrolling. */
  loseInterestAfter: z.number().min(0).max(60).default(4),
  /** Leave the corpse in the world, or remove it. */
  despawnOnDeath: z.boolean().default(true),
});

export type ChaseOnSightParams = z.infer<typeof ChaseOnSightParamsSchema>;

/**
 * How often line of sight is actually traced, in seconds.
 *
 * A raycast per enemy per frame is the first thing to fall over in a scene with dozens of them, and
 * the sprint plan calls it out. Seven checks a second is well under the ~250ms a player needs to
 * notice a reaction, and cuts the cost by an order of magnitude at 60fps.
 */
const SIGHT_CHECK_INTERVAL = 0.15;

/**
 * The priority this behaviour claims over its object's movement while chasing.
 *
 * Above `patrol`'s, so an enemy that spots the player abandons its route rather than fighting it
 * for the transform — which is what "both behaviours move the same object" would otherwise mean.
 */
const CHASE_PRIORITY = 10;

/** Health above which the enemy is alive. Kept as a name so the death check reads as intent. */
const DEAD = 0;

interface EnemyContext {
  object: GameObject;
  params: ChaseOnSightParams;
  agent: SteeringAgent;
  /** Seconds since the player was last actually visible. */
  sinceSeen: number;
  /** Countdown to the next line-of-sight trace. */
  sightCooldown: number;
  /** Countdown to the next blow while attacking. */
  attackCooldown: number;
  health: number;
  /** Last known player position, so a chase continues briefly after losing sight. */
  readonly lastSeen: THREE.Vector3;
  /** True on the frame the sight check most recently succeeded. */
  visible: boolean;
}

const toPlayer = new THREE.Vector3();
const eye = new THREE.Vector3();
const facing = new THREE.Vector3();

/** Enemy eye height above its feet, for line-of-sight traces that do not start inside the ground. */
const EYE_HEIGHT = 1.4;

function distanceToPlayer(context: EnemyContext): number | null {
  const player = context.object.world.playerPosition();
  if (!player) return null;
  toPlayer.copy(player).sub(context.object.node.position);
  return toPlayer.length();
}

/**
 * Can this enemy see the player right now?
 *
 * Three questions, cheapest first: is the player close enough, are they in front, and is there
 * anything in the way. Ordering matters — the raycast is by far the most expensive of the three
 * and most enemies in a scene fail one of the first two.
 */
function canSee(context: EnemyContext): boolean {
  const { object, params } = context;
  const player = object.world.playerPosition();
  if (!player) return false;

  toPlayer.copy(player).sub(object.node.position);
  const distance = toPlayer.length();
  if (distance > params.sightRange) return false;

  if (params.fieldOfView < 360 && distance > 0.01) {
    // The object's yaw is where it is looking; the same convention the patrol behaviour turns to.
    facing.set(Math.sin(object.node.rotation.y), 0, Math.cos(object.node.rotation.y));
    toPlayer.y = 0;
    const angle = facing.angleTo(toPlayer.normalize());
    if (angle > (params.fieldOfView * Math.PI) / 360) return false;
  }

  eye.copy(object.node.position);
  eye.y += EYE_HEIGHT;
  toPlayer.copy(player);
  // Aim at the player's chest rather than their feet: feet sit on the ground the ray would
  // otherwise clip on every slope between here and there.
  toPlayer.y += 1;
  return object.world.lineOfSight(eye, toPlayer, object.id);
}

const idleState: State<EnemyContext> = {
  onEnter: (context) => context.agent.setMode('none'),
  onUpdate: (context) => {
    if (context.visible) return 'chase';
    // Patrolling is not a state that does anything here — it is the patrol behaviour, if one is
    // attached, being allowed to move the object because this one is not holding it.
    return 'patrol';
  },
};

const patrolState: State<EnemyContext> = {
  onEnter: (context) => {
    context.agent.setMode('none');
    context.object.releaseControl();
  },
  onUpdate: (context) => (context.visible ? 'chase' : undefined),
};

const chaseState: State<EnemyContext> = {
  onEnter: (context) => {
    context.agent.maxSpeed = context.params.chaseSpeed;
    context.agent.reset(context.object.node.position);
    context.agent.setMode('seek');
    context.object.emit('enemyAlerted', { objectId: context.object.id });
  },
  onUpdate: (context, delta) => {
    const distance = distanceToPlayer(context);
    if (distance === null) return 'patrol';

    if (context.visible) context.sinceSeen = 0;
    if (context.sinceSeen > context.params.loseInterestAfter) return 'patrol';
    if (distance <= context.params.attackRange) return 'attack';

    // Movement is a claim, not a right: if something with a stronger claim holds the object this
    // frame, the chase still tracks the player but does not fight over the transform.
    if (!context.object.requestControl(CHASE_PRIORITY)) return;

    const target = context.visible
      ? (context.object.world.playerPosition() ?? context.lastSeen)
      : context.lastSeen;
    context.agent.setTarget(target);

    const next = context.agent.step(context.object.node.position, delta);
    next.y = context.object.world.groundHeight(next.x, next.z);
    context.object.world.moveTo(context.object.id, next);

    const heading = next.clone().sub(context.object.node.position);
    if (heading.lengthSq() > 1e-6) {
      context.object.node.rotation.y = Math.atan2(heading.x, heading.z);
    }
  },
};

const attackState: State<EnemyContext> = {
  onEnter: (context) => {
    context.agent.setMode('none');
    context.object.requestControl(CHASE_PRIORITY);
    // Swing on arrival rather than after a full interval, so closing the distance has consequences.
    context.attackCooldown = 0;
  },
  onUpdate: (context, delta) => {
    const distance = distanceToPlayer(context);
    if (distance === null) return 'patrol';
    // A little hysteresis: leaving at exactly `attackRange` makes an enemy flicker between
    // chasing and swinging when the player strafes on the boundary.
    if (distance > context.params.attackRange * 1.25) return 'chase';

    context.attackCooldown -= delta;
    if (context.attackCooldown > 0) return;

    context.attackCooldown = context.params.attackInterval;
    context.object.world.damagePlayer(context.params.attackDamage);
    context.object.emit('enemyAttacked', {
      objectId: context.object.id,
      damage: context.params.attackDamage,
    });
  },
};

const deadState: State<EnemyContext> = {
  onEnter: (context) => {
    context.agent.setMode('none');
    context.object.releaseControl();
    context.object.emit('enemyDied', { objectId: context.object.id });
    // Tipping the model over is the whole death animation for now, and it reads instantly.
    context.object.node.rotation.x = -Math.PI / 2;
    if (context.params.despawnOnDeath) context.object.world.destroy(context.object.id);
  },
};

/**
 * An enemy that patrols until it sees the player, then chases and attacks.
 *
 * Composes with `patrol` rather than replacing it: attach both and the object walks its route
 * until this behaviour takes the movement claim off it. That split is deliberate — a path is a
 * thing the level designer drew, and reacting to the player is a thing the enemy does, and folding
 * them into one behaviour would mean re-implementing waypoints inside every AI type that has them.
 */
export class ChaseOnSightBehavior implements Behavior {
  readonly #params: ChaseOnSightParams;
  #machine: StateMachine<EnemyContext> | null = null;
  #context: EnemyContext | null = null;

  constructor(params: ChaseOnSightParams) {
    this.#params = params;
  }

  /** Current FSM state, for tests and the editor's debug readout. */
  get state(): string | null {
    return this.#machine?.current ?? null;
  }

  get health(): number {
    return this.#context?.health ?? this.#params.health;
  }

  onInit(object: GameObject): void {
    const context: EnemyContext = {
      object,
      params: this.#params,
      agent: new SteeringAgent({ maxSpeed: this.#params.chaseSpeed, maxForce: 30 }),
      sinceSeen: Number.POSITIVE_INFINITY,
      sightCooldown: 0,
      attackCooldown: 0,
      health: this.#params.health,
      lastSeen: new THREE.Vector3(),
      visible: false,
    };

    this.#context = context;
    this.#machine = new StateMachine(context)
      .add('idle', idleState)
      .add('patrol', patrolState)
      .add('chase', chaseState)
      .add('attack', attackState)
      .add('dead', deadState);
    this.#machine.changeTo('idle');
  }

  onUpdate(object: GameObject, deltaSeconds: number): void {
    const context = this.#context;
    const machine = this.#machine;
    if (!context || !machine || machine.current === 'dead') return;

    context.sinceSeen += deltaSeconds;
    context.sightCooldown -= deltaSeconds;
    if (context.sightCooldown <= 0) {
      context.sightCooldown = SIGHT_CHECK_INTERVAL;
      context.visible = canSee(context);
      if (context.visible) {
        const player = context.object.world.playerPosition();
        if (player) context.lastSeen.copy(player);
      }
    }

    machine.update(deltaSeconds);
    this.#showState(object);
  }

  /**
   * Pushes the AI's own state onto the object's rig.
   *
   * Called after the machine has settled rather than inside each state's `onEnter`, because the
   * machine follows transitions until one holds — so a frame can pass through `chase` on its way to
   * `attack`, and animating every intermediate state would flicker.
   *
   * Unconditional: `setAnimationState` is a no-op on an object with no rig, which is what lets one
   * AI behaviour serve both a rigged Mixamo character and a box.
   */
  #showState(object: GameObject): void {
    const state = this.#machine?.current;
    if (!state) return;
    const animation = AI_STATE_ANIMATION[state];
    if (animation) object.setAnimationState(animation);
  }

  /**
   * Damage arrives as an event rather than a method call.
   *
   * The event bus is the only way one piece of gameplay reaches another without the two importing
   * each other, and it is what a trigger, a weapon or a script can all use identically.
   */
  onEvent(object: GameObject, event: string, payload: unknown): void {
    if (event !== 'damage') return;

    const data = payload as { targetId?: string; amount?: number } | undefined;
    if (data?.targetId !== object.id) return;

    const context = this.#context;
    const machine = this.#machine;
    if (!context || !machine || machine.current === 'dead') return;

    context.health = Math.max(DEAD, context.health - (data.amount ?? 0));
    if (context.health <= DEAD) {
      machine.changeTo('dead');
      this.#showState(object);
      return;
    }

    if (machine.current === 'patrol' || machine.current === 'idle') machine.changeTo('chase');
    // The flinch goes on *after* the state change, and deliberately: it plays over whatever is
    // looping and hands back to it when it finishes, so being shot while running does not stop the
    // enemy running. A model with no `hit` clip simply carries on, which is the right fallback.
    this.#showState(object);
    object.setAnimationState('hit');
  }

  onDestroy(object: GameObject): void {
    this.#machine?.stop();
    object.releaseControl();
  }
}

export const chaseOnSightDefinition: BehaviorDefinition<typeof ChaseOnSightParamsSchema> = {
  type: 'chaseOnSight',
  label: 'Chase on sight',
  description:
    'Patrols until it sees the player, then chases and attacks. Composes with a Patrol behaviour.',
  params: ChaseOnSightParamsSchema,
  create: (params) => new ChaseOnSightBehavior(params),
};
