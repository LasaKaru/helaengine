import {
  SmokeReportSchema,
  type AssetManifest,
  type Scene,
  type SmokeCheckResult,
  type SmokeReport,
} from '@helaengine/schema';
import { collectUsedAssets } from '@helaengine/export';

/**
 * The gate, as the editor can run it.
 *
 * There are two of these and they check different things, which is worth being precise about
 * rather than blurring:
 *
 * - `tools/smoke` builds a real export, serves it, and plays it in a real browser. It is the
 *   authority on whether a **build** works — bundles, paths, content types, the decoder shipping.
 *   It needs Node and Playwright, so it runs in CI, not in a tab.
 * - This one drives the editor's own **Play Preview**, which is the same engine, the same physics
 *   and the same scene document. It is the authority on whether a **level** works — can the player
 *   move, do they survive standing still, do the assets this scene names exist.
 *
 * The overlap is the part users actually hit. Every scene-level failure the Node harness has ever
 * found is one this can find too, and it can find it *before* the download starts rather than after
 * it has landed on somebody's disk. The parts it cannot answer are reported as such rather than
 * assumed: a preview shares the editor's page, so "the page loaded without throwing" is a question
 * about the editor, not about the export, and this says so.
 *
 * Both produce the same `SmokeReport`, so the repair loop, the report UI and the release rule are
 * written once.
 */

export interface PreviewHandle {
  /** Enters Play Preview and resolves once physics is up and the player exists. */
  start(scene: Scene): Promise<{ physicsReady: boolean; sceneReady: boolean }>;
  /** Leaves Play Preview and restores the edit camera. */
  stop(): Promise<void>;
  position(): [number, number, number] | null;
  health(): number | null;
  /** Holds the forward key for a while. Resolves when it has been released. */
  walkForward(ms: number): Promise<void>;
  wait(ms: number): Promise<void>;
  /** Console errors seen since `start`. */
  errors(): string[];
  /** Asset ids the loader could not load, as opposed to ones the manifest never had. */
  failedAssets(): string[];
  heap(): number | null;
}

export interface ValidateOptions {
  scene: Scene;
  manifest: AssetManifest;
  preview: PreviewHandle;
  /** How long to hold forward for. Short: this runs while somebody waits. */
  moveMs?: number;
  idleMs?: number;
  onCheck?: (result: SmokeCheckResult) => void;
}

/** See the note in `tools/smoke/src/harness.ts` — the same numbers, for the same reasons. */
const MOVED_METRES = 0.5;
const FELL_METRES = 25;
const HEAP_GROWTH_BYTES = 100 * 1024 * 1024;

function check(
  id: SmokeCheckResult['id'],
  status: SmokeCheckResult['status'],
  detail: string,
  evidence: Record<string, unknown> = {},
): SmokeCheckResult {
  return { id, status, detail, evidence, durationMs: 0 };
}

export async function validateScene(options: ValidateOptions): Promise<SmokeReport> {
  const { scene, manifest, preview } = options;
  const moveMs = options.moveMs ?? 1_500;
  const idleMs = options.idleMs ?? 1_200;
  const startedAt = new Date().toISOString();
  const began = Date.now();

  const checks: SmokeCheckResult[] = [];
  const push = (result: SmokeCheckResult): void => {
    checks.push(result);
    options.onCheck?.(result);
  };

  // Answered from the document and the library, before anything starts: an asset the scene names
  // and the library does not have will be a placeholder box in the export, and the person about to
  // download it should hear that from here rather than from a hole in their world.
  const summary = collectUsedAssets(scene, manifest);

  const heapBefore = preview.heap();
  const started = await preview.start(scene);

  push(
    started.sceneReady
      ? check('scene-loaded', 'passed', 'The scene built and the preview started.')
      : check(
          'scene-loaded',
          'failed',
          'The preview could not start this scene. Something in the document is stopping it from ' +
            'building — check the browser console for the first error.',
          { sceneReady: false },
        ),
  );

  const runtimeFailures = started.sceneReady ? preview.failedAssets() : [];
  const assetProblems = [...summary.missing, ...runtimeFailures];
  push(
    assetProblems.length === 0
      ? check('assets-resolve', 'passed', 'Every model this scene uses is in the library.')
      : check(
          'assets-resolve',
          'failed',
          `${assetProblems.length} asset${assetProblems.length === 1 ? '' : 's'} could not be ` +
            `loaded: ${assetProblems.slice(0, 3).join(', ')}. Objects using them will be empty ` +
            `boxes in the exported game.`,
          { failedAssets: assetProblems, missingFromLibrary: summary.missing },
        ),
  );

  // Deliberately not a pass. Play Preview shares the editor's page, so "did the page load without
  // throwing" is a question about the editor rather than about the export — and answering it here
  // would be answering a different question with the same name.
  push(
    check(
      'page-loads',
      'not-applicable',
      'Checked when the export itself is built and opened, not from inside the editor.',
    ),
  );

  if (!started.sceneReady) {
    for (const id of ['physics-initialises', 'player-moves', 'player-survives-idle'] as const) {
      push(check(id, 'skipped', 'The scene never started, so this could not be checked.'));
    }
    push(check('memory-stable', 'skipped', 'The scene never started.'));
    await preview.stop();
    return finish();
  }

  push(
    started.physicsReady
      ? check('physics-initialises', 'passed', 'The physics engine started.')
      : check(
          'physics-initialises',
          'failed',
          'The physics engine did not start, so nothing in this world can move.',
        ),
  );

  if (!started.physicsReady) {
    for (const id of ['player-moves', 'player-survives-idle'] as const) {
      push(check(id, 'skipped', 'Physics never started, so this could not be checked.'));
    }
    push(check('memory-stable', 'skipped', 'Physics never started.'));
    await preview.stop();
    return finish();
  }

  // Idle first, reported second — see the note in the Node harness. Walking into a hazard and being
  // hurt at the spawn look identical afterwards, and only one of them is a bug.
  const maxHealth = scene.player.health;
  await preview.wait(idleMs);
  const idleHealth = preview.health() ?? maxHealth;
  const before = preview.position() ?? [0, 0, 0];

  await preview.walkForward(moveMs);
  const after = preview.position() ?? before;

  const travelled = Math.hypot(after[0] - before[0], after[2] - before[2]);
  const fell = after[1] < scene.player.spawn[1] - FELL_METRES;

  push(
    fell
      ? check(
          'player-moves',
          'failed',
          `The player fell out of the world — ${Math.round(
            scene.player.spawn[1] - after[1],
          )}m below the start point and still going. The start point is probably off the terrain, ` +
            `or under it.`,
          { spawn: scene.player.spawn, endedAt: after, travelled },
        )
      : travelled >= MOVED_METRES
        ? check('player-moves', 'passed', 'The player walked when told to.', {
            travelled: Number(travelled.toFixed(2)),
            from: before,
            to: after,
          })
        : check(
            'player-moves',
            'failed',
            `The player could not move — ${travelled.toFixed(2)}m after holding forward. The ` +
              `start point is probably inside something solid.`,
            { spawn: scene.player.spawn, from: before, to: after, travelled },
          ),
  );

  push(
    idleHealth >= maxHealth
      ? check('player-survives-idle', 'passed', 'The player stood still unharmed.', {
          health: idleHealth,
        })
      : check(
          'player-survives-idle',
          'failed',
          `The player lost ${maxHealth - idleHealth} health while standing still at the start ` +
            `point. Something is attacking or damaging them before they can move.`,
          { startHealth: maxHealth, idleHealth, spawn: scene.player.spawn },
        ),
  );

  const heapAfter = preview.heap();
  push(
    heapBefore === null || heapAfter === null
      ? check(
          'memory-stable',
          'not-applicable',
          'This browser does not report heap usage, so there is nothing to measure.',
        )
      : heapAfter - heapBefore < HEAP_GROWTH_BYTES
        ? check('memory-stable', 'passed', 'Memory stayed steady while playing.', {
            growthBytes: heapAfter - heapBefore,
          })
        : check(
            'memory-stable',
            'failed',
            `Memory grew ${Math.round((heapAfter - heapBefore) / 1024 / 1024)}MB in a few seconds ` +
              `of play, which usually means something is being created every frame.`,
            { growthBytes: heapAfter - heapBefore },
          ),
  );

  await preview.stop();
  return finish();

  function finish(): SmokeReport {
    // Ordered before it is graded, so a report always reads in the order the checks are defined.
    const order = SmokeReportSchema.shape.checks.element.shape.id.options;
    checks.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

    return SmokeReportSchema.parse({
      buildId: scene.sceneId,
      sceneName: scene.name,
      passed: checks.every(
        (result) => result.status === 'passed' || result.status === 'not-applicable',
      ),
      checks,
      errors: preview.errors().map((message) => ({ message, source: 'console' as const })),
      startedAt,
      durationMs: Date.now() - began,
    });
  }
}
