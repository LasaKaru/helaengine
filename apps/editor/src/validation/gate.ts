import { runRepairLoop } from '@helaengine/repair';
import {
  describeRepairs,
  isReleasable,
  type AssetManifest,
  type RepairLog,
  type Scene,
  type SmokeCheckResult,
  type SmokeReport,
} from '@helaengine/schema';
import { createPreviewHandle } from './previewHandle';
import { validateScene } from './validateScene';

/**
 * The release gate the user meets.
 *
 * Plays the scene, and if it is broken tries a bounded, disclosed repair before deciding. The rule
 * it enforces is `isReleasable`, which lives in the schema and is shared with the CI gate — there
 * is one definition of "may this be handed to somebody", not one per surface.
 *
 * Three outcomes, and **there is no fourth**: passed, passed-after-repair, or blocked with a
 * specific reason. A spinner that never resolves is the failure mode this whole sprint exists to
 * prevent, so every path through here ends in one of the three.
 */

export type GateStage =
  | { kind: 'playing'; attempt: number }
  | { kind: 'thinking'; attempt: number }
  | { kind: 'fixing'; attempt: number }
  | { kind: 'done' };

export interface GateResult {
  releasable: boolean;
  report: SmokeReport;
  log: RepairLog;
  /** The scene as it ended up. Differs from the input only when a repair was kept. */
  scene: Scene;
  /** What to tell the user about changes made on their behalf. Empty when nothing changed. */
  disclosure: string[];
}

export interface GateOptions {
  scene: Scene;
  manifest: AssetManifest;
  onStage?: (stage: GateStage) => void;
  onCheck?: (result: SmokeCheckResult) => void;
  /** Off means "tell me what is wrong and change nothing", which some people will want. */
  repair?: boolean;
}

export async function runGate(options: GateOptions): Promise<GateResult> {
  const preview = createPreviewHandle();

  const verify = async (scene: Scene, attempt: number): Promise<SmokeReport> => {
    options.onStage?.({ kind: 'playing', attempt });
    return validateScene({
      scene,
      manifest: options.manifest,
      preview,
      ...(options.onCheck ? { onCheck: options.onCheck } : {}),
    });
  };

  if (options.repair === false) {
    const report = await verify(options.scene, 0);
    options.onStage?.({ kind: 'done' });
    return {
      releasable: isReleasable(report),
      report,
      log: {
        buildId: options.scene.sceneId,
        attempts: [],
        releasable: isReleasable(report),
        applied: [],
      },
      scene: options.scene,
      disclosure: [],
    };
  }

  const result = await runRepairLoop({
    scene: options.scene,
    buildId: options.scene.sceneId,
    verify,
    onProgress: (stage, attempt) => {
      if (stage === 'proposing') options.onStage?.({ kind: 'thinking', attempt });
      if (stage === 'applying') options.onStage?.({ kind: 'fixing', attempt });
    },
  });

  options.onStage?.({ kind: 'done' });

  return {
    releasable: result.log.releasable,
    report: result.report,
    log: result.log,
    scene: result.scene,
    disclosure: describeRepairs(result.log),
  };
}

/**
 * The sentence shown when a build is blocked.
 *
 * Built from the failing check rather than from an error object, because "Cannot read properties of
 * undefined" tells the person who built a level nothing about their level. Where the harness has
 * already written a human sentence, that sentence is used — it was written for exactly this.
 */
export function explainBlock(report: SmokeReport): { headline: string; suggestion: string } {
  const failed = report.checks.find((check) => check.status === 'failed');
  if (!failed) {
    return {
      headline: 'Some checks could not be run, so this build has not been proved to work.',
      suggestion: 'Try again — and if it keeps happening, the browser console will say why.',
    };
  }

  return { headline: failed.detail, suggestion: SUGGESTIONS[failed.id] };
}

/**
 * What to try, per failure.
 *
 * A suggestion the person can act on without reading any of this code. Deliberately keyed on the
 * closed check vocabulary, so a new check cannot ship without somebody writing the sentence that
 * goes with it.
 */
const SUGGESTIONS: Record<SmokeCheckResult['id'], string> = {
  'page-loads': 'This is a problem with the build rather than your level. Please report it.',
  'assets-resolve':
    'Open the scene tree and look for objects with a missing model — delete them, or re-add them from the asset library.',
  'scene-loaded':
    'Something in the document is stopping the world from building. Undo your most recent change and try again.',
  'physics-initialises':
    'This is a problem with the build rather than your level. Please report it.',
  'player-moves':
    'Move the player start point somewhere open: select nothing, then set the spawn in the scene settings, or drag whatever is on top of it out of the way.',
  'player-survives-idle':
    'Something near the start point is damaging the player. Move the start point, or move the enemy or trigger volume away from it.',
  'memory-stable':
    'Something in the scene is allocating every frame. Try removing recently added behaviours one at a time.',
};
