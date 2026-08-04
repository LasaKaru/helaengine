import type { RepairProposal, Scene, Vec3 } from '@helaengine/schema';
import type { CandidateObject, RepairContext } from './context.js';
import type { RepairModel } from './model.js';

/**
 * A repair proposer that is arithmetic rather than a language model.
 *
 * It exists for three reasons, in order of importance:
 *
 * 1. **The gate must work with no API key, no network and no spend.** A validation step that only
 *    functions when a paid service answers is a validation step that will be switched off.
 * 2. **It makes the loop testable.** "Three broken scenes are detected and repaired" is a claim
 *    that has to be reproducible; a claim that depends on what a model said this morning is not.
 * 3. **It is the honest default.** The failures this catches — a spawn off the map, a spawn inside
 *    a wall, a damage volume on the start point — have arithmetic answers. Asking a model to
 *    compute a clear position when a search over the same numbers will find one is paying for
 *    uncertainty.
 *
 * The language-model proposer earns its place on the failures this one shrugs at, which is why the
 * loop can take either, or take this one first and fall back.
 */
export class RuleBasedRepairModel implements RepairModel {
  readonly name = 'rules';

  propose(context: RepairContext, scene: Scene): Promise<unknown> {
    // Synchronous work behind an async interface, because the other implementation of it is a
    // network call. The loop must not be able to tell the two apart.
    return Promise.resolve(proposeByRule(context, scene));
  }
}

export function proposeByRule(context: RepairContext, scene: Scene): RepairProposal | null {
  switch (context.failing) {
    case 'player-moves':
      return repairMovement(context, scene);
    case 'player-survives-idle':
      return repairSpawnDamage(context, scene);
    case 'assets-resolve':
      return repairMissingAsset(context);
    default:
      // Everything else is a broken build rather than a broken level, and `isRepairable` should
      // have stopped the loop before it got here. Returning null rather than guessing.
      return null;
  }
}

function repairMovement(context: RepairContext, scene: Scene): RepairProposal | null {
  const spawn = scene.player.spawn;
  const insideTerrain = context.facts['spawnIsInsideTerrainBounds'] !== false;

  if (!insideTerrain) {
    // Off the edge of the world: there is no ground under the spawn to stand on, so nothing about
    // the objects nearby matters. Put it back over the terrain and let the export's own clamp
    // settle the height against the heightmap.
    const landing = clearPointNear(scene, [0, spawn[1], 0]);
    return {
      patch: { op: 'setPlayerSpawn', spawn: landing },
      fixes: 'player-moves',
      reason:
        `Your start point was at ${format(spawn)}, outside the ${scene.terrain.size[0]}×` +
        `${scene.terrain.size[1]}m terrain, so the player had no ground to stand on and fell. ` +
        `We moved it to ${format(landing)}, over the terrain.`,
    };
  }

  // Inside the terrain but not moving: something solid is in the way. The blocker is worth naming
  // in the explanation even though the patch moves the player rather than the building — moving
  // somebody's hut to make room is a bigger decision than a test result should make on its own.
  const blocker = context.candidates.find((object) => object.collider !== 'none');
  const landing = clearPointNear(scene, spawn);

  if (samePoint(landing, spawn)) return null;

  return {
    patch: { op: 'setPlayerSpawn', spawn: landing },
    fixes: 'player-moves',
    reason: blocker
      ? `Your start point was inside ${name(blocker)}, so the player spawned stuck and could not ` +
        `walk. We moved the start point to ${format(landing)}, just clear of it.`
      : `The player could not move from ${format(spawn)}, so we moved the start point to ` +
        `${format(landing)}, on open ground.`,
  };
}

function repairSpawnDamage(context: RepairContext, scene: Scene): RepairProposal | null {
  const spawn = scene.player.spawn;
  const hazard = context.candidates[0];
  if (!hazard) return null;

  // First try moving the player away, because it changes nothing about the level. Only if the
  // spawn has already been moved once — which the loop signals by the failure recurring — is
  // taking the trigger off the object the smaller of the two remaining options.
  const alreadyMoved = context.evidence['spawnMovedOnce'] === true;

  // What to do about the hazard itself, if moving the player was not enough. Which one is smaller
  // depends on what the hazard *is*: a trigger volume can be switched off without removing
  // anything, while an enemy that belongs in the level is better relocated than deleted.
  const disarm = (): RepairProposal =>
    hazard.hasTrigger
      ? {
          patch: { op: 'clearObjectTrigger', objectId: hazard.id },
          fixes: 'player-survives-idle',
          reason:
            `${name(hazard)} was hurting the player as soon as the game started. We turned that ` +
            `trigger off — check whether it was meant to cover so much ground.`,
        }
      : {
          patch: {
            op: 'setObjectPosition',
            objectId: hazard.id,
            position: pushedAway(hazard.position, spawn, 14),
          },
          fixes: 'player-survives-idle',
          reason:
            `${name(hazard)} was attacking the player before they could move. We moved it back ` +
            `so the game does not start mid-fight.`,
        };

  if (alreadyMoved) return disarm();

  const landing = clearPointNear(scene, spawn, { avoidTriggers: true });
  if (samePoint(landing, spawn)) return disarm();

  return {
    patch: { op: 'setPlayerSpawn', spawn: landing },
    fixes: 'player-survives-idle',
    reason:
      `The player was taking damage while standing still at ${format(spawn)}, from ` +
      `${name(hazard)}. We moved the start point to ${format(landing)}, out of its reach.`,
  };
}

function repairMissingAsset(context: RepairContext): RepairProposal | null {
  const orphan = context.candidates[0];
  if (!orphan) return null;

  // The last-resort patch, and the reason says so plainly. There is no smaller edit available:
  // the model this object refers to is not in the build, so it can only be a hole in the world or
  // not be there at all.
  return {
    patch: { op: 'removeObject', objectId: orphan.id },
    fixes: 'assets-resolve',
    reason:
      `${name(orphan)} uses the model "${orphan.assetId}", which is not in this build, so the ` +
      `game could not load it. We removed that object — if you still want it, re-add it from the ` +
      `asset library and export again.`,
  };
}

/**
 * Finds a point near a target with nothing solid on it.
 *
 * A spiral search over fixed rings and angles rather than anything clever: deterministic, so the
 * same broken scene is repaired the same way every time, and cheap enough to run over a 520-object
 * scene without noticing. Clearance is the player's radius plus a metre — enough that the capsule
 * is not touching whatever it was stuck in, since a repair that leaves the player *nearly* free is
 * a repair that fails re-verification and burns an attempt.
 */
function clearPointNear(
  scene: Scene,
  target: Vec3,
  options: { avoidTriggers?: boolean } = {},
): Vec3 {
  const clearance = scene.player.radius + 1;
  const [width, depth] = scene.terrain.size;
  const solid = scene.objects.filter((object) => {
    if (options.avoidTriggers) return object.trigger !== null || object.physics.collider !== 'none';
    return object.physics.collider !== 'none' && object.trigger === null;
  });

  const isClear = (x: number, z: number): boolean => {
    if (Math.abs(x) > width / 2 - 2 || Math.abs(z) > depth / 2 - 2) return false;
    return solid.every((object) => {
      const [ox, , oz] = object.transform.position;
      // Objects are treated as a radius rather than their real shape. The manifest knows the true
      // bounds, but this runs on the document alone — and re-verification is what decides whether
      // the guess was good, so a rough radius plus a real play-test beats a precise radius alone.
      const footprint = 1.5 * Math.max(...object.transform.scale);
      return Math.hypot(x - ox, z - oz) >= clearance + footprint;
    });
  };

  if (isClear(target[0], target[2])) return target;

  for (const radius of [3, 5, 8, 12, 18, 25]) {
    for (let step = 0; step < 12; step += 1) {
      const angle = (step / 12) * Math.PI * 2;
      const x = round(target[0] + Math.cos(angle) * radius);
      const z = round(target[2] + Math.sin(angle) * radius);
      if (isClear(x, z)) return [x, target[1], z];
    }
  }

  return target;
}

/** Moves a point directly away from another, to a fixed distance. Deterministic, like everything here. */
function pushedAway(from: Vec3, away: Vec3, metres: number): Vec3 {
  const dx = from[0] - away[0];
  const dz = from[2] - away[2];
  const length = Math.hypot(dx, dz);
  // Directly on top of each other: pick an axis rather than dividing by zero.
  const [ux, uz] = length < 0.001 ? [1, 0] : [dx / length, dz / length];
  return [round(away[0] + ux * metres), from[1], round(away[2] + uz * metres)];
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function samePoint(a: Vec3, b: Vec3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function format(point: Vec3): string {
  return `[${point.map((value) => Number(value.toFixed(1))).join(', ')}]`;
}

function name(object: CandidateObject): string {
  return object.label ? `"${object.label}"` : `the ${object.assetId} at ${format(object.position)}`;
}
