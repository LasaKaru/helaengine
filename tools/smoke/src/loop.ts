import {
  isReleasable,
  RepairLogSchema,
  type RepairAttempt,
  type RepairLog,
  type RepairProposal,
  type Scene,
  type SmokeReport,
} from '@helaengine/schema';
import {
  applyPatch,
  extractContext,
  firstRepairableFailure,
  RuleBasedRepairModel,
  validateProposal,
  type RepairModel,
} from '@helaengine/repair';
import type { ExportMode } from '@helaengine/export';
import { runSmokeTest, type SmokeOptions } from './harness.js';
import { stageExport } from './stage.js';

/**
 * Detect, propose, apply, re-verify — bounded.
 *
 * The loop is the part that makes automatic repair defensible rather than alarming, and every
 * decision in it is about limiting blast radius:
 *
 * - **Bounded attempts.** Three. Not because three is magic, but because an unbounded loop against
 *   a paid model is an unbounded bill, and a loop that keeps editing until something passes will
 *   eventually edit away the thing it was asked to protect.
 * - **Re-verified before kept.** A patch that does not make the report better is *reverted*. The
 *   model does not get to decide whether it helped; the play-test does.
 * - **Everything logged, including refusals.** An audit trail that lists only successful edits
 *   cannot answer "did the model try something it should not have been able to do", which is the
 *   first question anybody will ask.
 * - **Only scene problems.** A damaged engine bundle is not repaired by moving a spawn point, and
 *   the loop stops rather than spending its budget rearranging a level to fix a build.
 */

export interface RepairLoopOptions {
  scene: Scene;
  buildId: string;
  /** Staging root. Each attempt rebuilds into it — a stale build must not pass for a fresh one. */
  into: string;
  mode?: ExportMode;
  model?: RepairModel;
  maxAttempts?: number;
  /** Applied to every staged build. Used by the tests to keep a build-level fault present. */
  breakBuild?: (root: string) => Promise<void>;
  smoke?: SmokeOptions;
}

export interface RepairLoopResult {
  /** The scene as it ended up — the original if nothing was kept. */
  scene: Scene;
  /** The last report produced. */
  report: SmokeReport;
  log: RepairLog;
}

export async function repairLoop(options: RepairLoopOptions): Promise<RepairLoopResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const model = options.model ?? new RuleBasedRepairModel();

  let scene = options.scene;
  let report = await stageAndTest(scene, options);

  const attempts: RepairAttempt[] = [];
  const applied: RepairProposal[] = [];
  // Tracked across reverts on purpose. "We already tried moving the spawn" stays true even when the
  // move was undone, so the proposer escalates instead of suggesting the same thing three times.
  const tried = new Set<string>();

  for (let attempt = 1; attempt <= maxAttempts && !isReleasable(report); attempt += 1) {
    const failed = firstRepairableFailure(report);
    if (!failed) break;

    const context = extractContext(scene, failed);
    if (tried.has('setPlayerSpawn')) context.evidence['spawnMovedOnce'] = true;

    const record = (
      outcome: RepairAttempt['outcome'],
      extra: Partial<RepairAttempt> = {},
    ): void => {
      attempts.push({
        attempt,
        failing: failed.id,
        outcome,
        proposedBy: model.name,
        ...extra,
      });
    };

    const raw = await model.propose(context, scene);
    if (raw === null || raw === undefined) {
      record('no-proposal');
      break;
    }

    const validated = validateProposal(raw);
    if (!validated.ok) {
      record('rejected', { rejection: validated.reason });
      continue;
    }

    const patched = applyPatch(scene, validated.proposal.patch);
    if (!patched.ok) {
      record('invalid-result', { proposal: validated.proposal, rejection: patched.reason });
      continue;
    }

    tried.add(validated.proposal.patch.op);

    const after = await stageAndTest(patched.scene, options);
    if (isReleasable(after)) {
      scene = patched.scene;
      report = after;
      applied.push(validated.proposal);
      record('repaired', { proposal: validated.proposal });
      break;
    }

    // Not fixed. Keep the patch only if it made things measurably better — otherwise a loop with
    // three attempts leaves three unhelpful edits in somebody's level and calls it a day.
    if (failedCount(after) < failedCount(report)) {
      scene = patched.scene;
      report = after;
      applied.push(validated.proposal);
    }
    record('still-failing', { proposal: validated.proposal });
  }

  return {
    scene,
    report,
    log: RepairLogSchema.parse({
      buildId: options.buildId,
      attempts,
      releasable: isReleasable(report),
      applied,
    }),
  };
}

function failedCount(report: SmokeReport): number {
  return report.checks.filter((check) => check.status === 'failed').length;
}

async function stageAndTest(scene: Scene, options: RepairLoopOptions): Promise<SmokeReport> {
  const root = await stageExport(scene, {
    into: options.into,
    ...(options.mode ? { mode: options.mode } : {}),
  });
  // Re-applied every time: a fault in the *build* rather than the document does not go away because
  // the document was edited, and a loop that quietly rebuilt its way out of one would be reporting
  // a repair it did not make.
  if (options.breakBuild) await options.breakBuild(root);

  return runSmokeTest(root, { buildId: options.buildId, ...options.smoke });
}
