import type { Scene, SmokeCheckId, SmokeCheckResult, SmokeReport } from '@helaengine/schema';

/**
 * The slice of a scene a failure is actually about.
 *
 * Whole documents are not sent anywhere. A stress-test scene is 520 objects and a base64 heightmap;
 * a spawn that fell out of the world is explained by four numbers and whatever is standing near
 * them. Sending the rest would cost tokens, bury the signal, and hand a model a great deal of a
 * user's work for no reason — and the third of those is the one that matters most.
 */
export interface RepairContext {
  failing: SmokeCheckId;
  /** The harness's own sentence about what went wrong. */
  detail: string;
  /** Whatever the failed check measured. */
  evidence: Record<string, unknown>;
  /** Scene facts relevant to this failure, and no others. */
  facts: Record<string, unknown>;
  /** Objects worth naming in a patch, already narrowed. */
  candidates: CandidateObject[];
}

export interface CandidateObject {
  id: string;
  assetId: string;
  label?: string;
  position: [number, number, number];
  /** Metres from the spawn, when the failure is about the spawn. */
  distance?: number;
  collider: string;
  body: string;
  hasTrigger: boolean;
  /** Something is attached that acts on its own — an enemy, a patrol, a pickup. */
  hasBehaviors: boolean;
}

/**
 * How close counts as "near the spawn".
 *
 * Six metres. Wide enough to include the building somebody spawned inside and the barrel they are
 * wedged against; narrow enough that a scene with 520 objects does not offer all of them as
 * suspects. A repair that names the wrong object is worse than no repair, so the list a proposer
 * chooses from should be short.
 */
const NEAR_METRES = 6;

/**
 * Checks a scene edit can do nothing about.
 *
 * Being explicit about this is the point. `physics-initialises` fails when the engine bundle is
 * damaged and `page-loads` fails when the code throws — neither is a property of the level, and a
 * repair loop that starts proposing spawn moves at them would be a loop that changes people's work
 * at random until the retry budget runs out. The loop stops instead, and says why.
 */
const NOT_A_SCENE_PROBLEM: ReadonlySet<SmokeCheckId> = new Set([
  'page-loads',
  'scene-loaded',
  'physics-initialises',
  'memory-stable',
]);

export function isRepairable(check: SmokeCheckId): boolean {
  return !NOT_A_SCENE_PROBLEM.has(check);
}

/** The first failed check the loop should work on, or null when none can be repaired. */
export function firstRepairableFailure(report: SmokeReport): SmokeCheckResult | null {
  return report.checks.find((check) => check.status === 'failed' && isRepairable(check.id)) ?? null;
}

export function extractContext(scene: Scene, failed: SmokeCheckResult): RepairContext {
  const spawn = scene.player.spawn;
  const base = {
    failing: failed.id,
    detail: failed.detail,
    evidence: failed.evidence,
  };

  switch (failed.id) {
    case 'player-moves':
      return {
        ...base,
        facts: {
          playerSpawn: spawn,
          playerHeight: scene.player.height,
          playerRadius: scene.player.radius,
          terrainSize: scene.terrain.size,
          terrainMaxHeight: scene.terrain.maxHeight,
          // The two questions a fall-through and a stuck spawn are told apart by, handed over
          // rather than left for the reader to work out.
          spawnIsInsideTerrainBounds: withinTerrain(scene, spawn),
          objectsWithinSixMetres: near(scene, spawn).length,
        },
        candidates: near(scene, spawn),
      };

    case 'player-survives-idle': {
      // Only what could plausibly be doing it. Something near the spawn is hurting a player who is
      // standing still, and that is either a trigger volume or something with behaviour attached —
      // an enemy, most likely. A barrel is not a suspect, and offering it as one would invite a
      // repair that removes the wrong thing.
      const suspects = near(scene, spawn).filter(
        (object) => object.hasTrigger || object.hasBehaviors,
      );
      return {
        ...base,
        facts: {
          playerSpawn: spawn,
          maxHealth: scene.player.health,
          suspectsNearSpawn: suspects.length,
        },
        candidates: suspects,
      };
    }

    case 'assets-resolve': {
      const failedAssets = new Set(
        [
          ...((failed.evidence['failedAssets'] as string[] | undefined) ?? []),
          ...((failed.evidence['notFound'] as string[] | undefined) ?? []),
        ].flatMap((entry) => entry.split(/[\s/]+/)),
      );

      const referencing = scene.objects.filter(
        (object) =>
          failedAssets.has(object.assetId) ||
          [...failedAssets].some((asset) => asset.includes(object.assetId)),
      );

      return {
        ...base,
        facts: {
          objectsAffected: referencing.length,
          totalObjects: scene.objects.length,
        },
        candidates: referencing.map((object) => describe(object)),
      };
    }

    default:
      return { ...base, facts: {}, candidates: [] };
  }
}

function withinTerrain(scene: Scene, point: readonly [number, number, number]): boolean {
  const [width, depth] = scene.terrain.size;
  return Math.abs(point[0]) <= width / 2 && Math.abs(point[2]) <= depth / 2;
}

function near(scene: Scene, spawn: readonly [number, number, number]): CandidateObject[] {
  return scene.objects
    .map((object) => {
      const [x, , z] = object.transform.position;
      return { object, distance: Math.hypot(x - spawn[0], z - spawn[2]) };
    })
    .filter((entry) => entry.distance <= NEAR_METRES)
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => describe(entry.object, entry.distance));
}

function describe(object: Scene['objects'][number], distance?: number): CandidateObject {
  const label = object.metadata['label'];
  return {
    id: object.id,
    assetId: object.assetId,
    ...(typeof label === 'string' ? { label } : {}),
    position: object.transform.position,
    ...(distance === undefined ? {} : { distance: Number(distance.toFixed(2)) }),
    collider: object.physics.collider,
    body: object.physics.body,
    hasTrigger: object.trigger !== null,
    hasBehaviors: object.behaviors.length > 0,
  };
}
