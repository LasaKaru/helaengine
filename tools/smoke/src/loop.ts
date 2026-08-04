import type { Scene, SmokeReport } from '@helaengine/schema';
import { runRepairLoop, type RepairLoopResult, type RepairModel } from '@helaengine/repair';
import type { ExportMode } from '@helaengine/export';
import { runSmokeTest, type SmokeOptions } from './harness.js';
import { stageExport } from './stage.js';

/**
 * The repair loop, wired to real exports.
 *
 * The policy — three attempts, revert what does not help, log the refusals — lives in
 * `@helaengine/repair` and is shared with the editor, which runs the same loop against its own Play
 * Preview. All this adds is what "verify" means out here: stage a real build and play it.
 */

export interface SmokeRepairOptions {
  scene: Scene;
  buildId: string;
  /** Staging root. Rebuilt every attempt — a stale build must not pass for a fresh one. */
  into: string;
  mode?: ExportMode;
  model?: RepairModel;
  maxAttempts?: number;
  /** Applied to every staged build, so a fault in the *build* stays present across rebuilds. */
  breakBuild?: (root: string) => Promise<void>;
  smoke?: SmokeOptions;
}

export async function repairLoop(options: SmokeRepairOptions): Promise<RepairLoopResult> {
  const verify = async (scene: Scene): Promise<SmokeReport> => {
    const root = await stageExport(scene, {
      into: options.into,
      ...(options.mode ? { mode: options.mode } : {}),
    });
    // Re-applied every time: a fault in the build rather than the document does not go away because
    // the document was edited, and a loop that quietly rebuilt its way out of one would be
    // reporting a repair it did not make.
    if (options.breakBuild) await options.breakBuild(root);

    return runSmokeTest(root, { buildId: options.buildId, ...options.smoke });
  };

  return runRepairLoop({
    scene: options.scene,
    buildId: options.buildId,
    verify,
    ...(options.model ? { model: options.model } : {}),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
}
