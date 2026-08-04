import {
  isReleasable,
  RepairLogSchema,
  type RepairAttempt,
  type RepairLog,
  type RepairProposal,
  type Scene,
  type SmokeReport,
} from '@helaengine/schema';
import { applyPatch } from './apply.js';
import { extractContext, firstRepairableFailure } from './context.js';
import { validateProposal, type RepairModel } from './model.js';
import { RuleBasedRepairModel } from './rules.js';

/**
 * Detect, propose, apply, re-verify — bounded.
 *
 * The policy lives here, away from anything that knows how a build gets tested, because there are
 * two callers with nothing else in common: the Node harness, which stages an export and plays it in
 * a real browser, and the editor, which runs the same checks against its own Play Preview. Both
 * hand in a `verify` function and get the same guarantees, which is the point — a gate whose rules
 * depend on where it runs is two gates that will drift.
 *
 * Every decision here is about limiting blast radius:
 *
 * - **Bounded attempts.** Three. An unbounded loop against a paid model is an unbounded bill, and
 *   one that keeps editing until something passes will eventually edit away what it protected.
 * - **Re-verified before kept.** A patch that does not make the report better is reverted. The
 *   proposer does not get to decide whether it helped.
 * - **Everything logged, including refusals.** A trail of successful edits cannot answer "did the
 *   model try something it should not have been able to do".
 * - **Only scene problems.** A damaged engine bundle is not repaired by moving a spawn point.
 */

/** Builds and plays a candidate scene, and reports what happened. */
export type VerifyScene = (scene: Scene, attempt: number) => Promise<SmokeReport>;

export interface RepairLoopOptions {
  scene: Scene;
  buildId: string;
  verify: VerifyScene;
  model?: RepairModel;
  maxAttempts?: number;
  /** Called before each verification, so a caller can show progress rather than a spinner. */
  onProgress?: (stage: 'verifying' | 'proposing' | 'applying', attempt: number) => void;
}

export interface RepairLoopResult {
  /** The scene as it ended up — the original if nothing was kept. */
  scene: Scene;
  /** The last report produced. */
  report: SmokeReport;
  log: RepairLog;
}

export async function runRepairLoop(options: RepairLoopOptions): Promise<RepairLoopResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const model = options.model ?? new RuleBasedRepairModel();

  let scene = options.scene;
  options.onProgress?.('verifying', 0);
  let report = await options.verify(scene, 0);

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
      attempts.push({ attempt, failing: failed.id, outcome, proposedBy: model.name, ...extra });
    };

    options.onProgress?.('proposing', attempt);
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

    options.onProgress?.('applying', attempt);
    const patched = applyPatch(scene, validated.proposal.patch);
    if (!patched.ok) {
      record('invalid-result', { proposal: validated.proposal, rejection: patched.reason });
      continue;
    }

    tried.add(validated.proposal.patch.op);

    options.onProgress?.('verifying', attempt);
    const after = await options.verify(patched.scene, attempt);
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
