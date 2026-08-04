import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';
import {
  SMOKE_CHECK_ORDER,
  SmokeReportSchema,
  type CapturedError,
  type SmokeCheckId,
  type SmokeCheckResult,
  type SmokeCheckStatus,
  type SmokeReport,
} from '@helaengine/schema';
import { serveStaging } from './server.js';

/**
 * The pre-delivery smoke test.
 *
 * A deterministic robot that plays a build before a human can. Every check here is a scripted
 * assertion about observable state — a number that did or did not change, a request that did or
 * did not resolve. Nothing here judges whether a game is *good*; that is not a thing a test can
 * know, and pretending otherwise is how you get a validation step nobody trusts.
 */

export interface SmokeOptions {
  /** Identifies the build in the report. A staging path, not a public URL. */
  buildId?: string;
  /** How long to wait for the export to say it is ready. */
  loadTimeoutMs?: number;
  /** How long to hold the movement keys for. */
  moveMs?: number;
  /** How long to stand still and watch the health bar. */
  idleMs?: number;
  /** Written next to the report when a check fails, if given. */
  screenshotPath?: string;
}

/** What the export publishes about itself. Mirrors `window.helaengineExport` in `mainJs.ts`. */
interface ExportHandle {
  mode: 'static' | 'game';
  /** The document loaded and the world was built. Set before physics is even attempted. */
  sceneReady: boolean;
  /** The loop is running and there is a player to ask about. */
  ready: boolean;
  sceneName: string;
  assetsFailed: string[];
  physicsReady?: boolean;
  position?: [number, number, number];
  health?: number;
  screen?: string;
  spawn: [number, number, number];
  maxHealth: number;
  heap: number | null;
}

const DEFAULTS = {
  loadTimeoutMs: 90_000,
  moveMs: 2_000,
  idleMs: 2_000,
};

/**
 * How far the player has to travel horizontally for "it moved" to mean anything.
 *
 * Half a metre over two seconds of held input. A walking character covers several times that, and
 * a character wedged in geometry covers roughly zero — the gap is wide enough that no threshold
 * argument is needed, which is the only kind of threshold worth having.
 */
const MOVED_METRES = 0.5;

/**
 * How far below its spawn a player has to end up to count as having fallen out of the world.
 *
 * Generous on purpose: levels have drops, and a scene where the spawn is on a ledge is not broken.
 * Twenty-five metres below where you started, still falling, is not level design.
 */
const FELL_METRES = 25;

/**
 * How much the heap may grow across the play window.
 *
 * A cheap leak catch rather than a profiling pass, and the bar is set where a *runaway* shows up:
 * a few megabytes is a scene streaming in, a hundred is something allocating per frame and never
 * letting go.
 */
const HEAP_GROWTH_BYTES = 100 * 1024 * 1024;

function result(
  id: SmokeCheckId,
  status: SmokeCheckStatus,
  detail: string,
  evidence: Record<string, unknown> = {},
): SmokeCheckResult {
  return { id, status, detail, evidence, durationMs: 0 };
}

/**
 * Sorts a console error into the check that should own it, or throws it away.
 *
 * Three kinds arrive and they are not the same thing:
 *
 * - A browser asking for `/favicon.ico` and not finding one. That is a browser habit, not a broken
 *   build, and counting it cost the first run of this harness a false failure on every export.
 * - "Failed to load resource" for anything else. That is a *network* fact, and `assets-resolve`
 *   already reads it from the response side with the URL attached; recording it as `requestfailed`
 *   keeps it in the report without also failing `page-loads`, which is about thrown JavaScript.
 * - Everything else, which is the page complaining about itself.
 *
 * Warnings are never errors: the export deliberately warns about assets it could not load, and the
 * asset check reads that far more precisely than a string match would.
 */
function classify(message: ConsoleMessage): CapturedError | null {
  if (message.type() !== 'error') return null;

  const url = message.location().url;
  if (url.includes('favicon')) return null;

  if (message.text().startsWith('Failed to load resource')) {
    return { message: message.text(), source: 'requestfailed', url };
  }
  return { message: message.text(), source: 'console' };
}

async function readHandle(page: Page): Promise<ExportHandle | null> {
  return page.evaluate(() => {
    const handle = (window as unknown as { helaengineExport?: Record<string, unknown> })
      .helaengineExport;
    if (!handle) return null;

    const position = handle['playerPosition'] as undefined | (() => [number, number, number]);
    const health = handle['playerHealth'] as undefined | (() => number);
    const screen = handle['screen'] as undefined | (() => string);
    const scene = handle['scene'] as
      { name?: string; player?: { spawn?: number[]; health?: number } } | undefined;
    // Chromium-only, and absent behind some flags even there. `null` means "cannot tell", which
    // the memory check reports as such rather than inventing a number.
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;

    return {
      mode: (handle['mode'] as 'static' | 'game') ?? 'static',
      sceneReady: handle['sceneReady'] === true,
      ready: handle['ready'] === true,
      sceneName: scene?.name ?? 'unnamed',
      assetsFailed: (handle['assetsFailed'] as string[] | undefined) ?? [],
      physicsReady: handle['physicsReady'] as boolean | undefined,
      position: position ? position() : undefined,
      health: health ? health() : undefined,
      screen: screen ? screen() : undefined,
      spawn: (scene?.player?.spawn as [number, number, number] | undefined) ?? [0, 0, 0],
      maxHealth: scene?.player?.health ?? 100,
      heap: memory ? memory.usedJSHeapSize : null,
    };
  });
}

export async function runSmokeTest(root: string, options: SmokeOptions = {}): Promise<SmokeReport> {
  const settings = { ...DEFAULTS, ...options };
  const startedAt = new Date().toISOString();
  const began = Date.now();

  const site = await serveStaging(root);
  const browser: Browser = await chromium.launch({
    // Software WebGL: the machines this runs on — CI, containers, a server — have no GPU, and a
    // build that fails to render because the *runner* has no renderer is a false failure.
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
    ...(process.env['CHROMIUM_PATH'] ? { executablePath: process.env['CHROMIUM_PATH'] } : {}),
  });

  const errors: CapturedError[] = [];
  const checks: SmokeCheckResult[] = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });

    page.on('pageerror', (error) => errors.push({ message: error.message, source: 'pageerror' }));
    page.on('console', (message) => {
      const captured = classify(message);
      if (captured) errors.push(captured);
    });
    page.on('requestfailed', (request) => {
      errors.push({
        message: request.failure()?.errorText ?? 'request failed',
        source: 'requestfailed',
        url: request.url(),
      });
    });

    const notFound: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400 && !response.url().includes('favicon')) {
        notFound.push(`${response.status()} ${new URL(response.url()).pathname}`);
      }
    });

    await page.goto(site.origin, { waitUntil: 'domcontentloaded' });

    // Waited for in two stages, because the export publishes itself in two stages. `sceneReady`
    // goes up the moment the world is built — before physics is even attempted — so a build that
    // dies during physics init can still be asked how far it got, instead of being reported as a
    // scene that never loaded. That distinction is the whole value of a per-check report.
    const waitFor = async (field: 'sceneReady' | 'ready', timeout: number): Promise<boolean> => {
      try {
        await page.waitForFunction(
          (name) =>
            (window as unknown as { helaengineExport?: Record<string, unknown> })
              .helaengineExport?.[name] === true,
          field,
          { timeout },
        );
        return true;
      } catch {
        return false;
      }
    };

    const sceneReady = await waitFor('sceneReady', settings.loadTimeoutMs);
    // Short, because by now the only thing between here and `ready` is physics starting. Waiting
    // the full load budget again would turn a fast, clear failure into a slow, vague one.
    const ready = sceneReady ? await waitFor('ready', 30_000) : false;
    const handle = sceneReady ? await readHandle(page) : null;

    const loadErrors = errors.filter((error) => error.source !== 'requestfailed');
    checks.push(
      loadErrors.length === 0
        ? result('page-loads', 'passed', 'The page loaded and threw nothing.')
        : result(
            'page-loads',
            'failed',
            `The page threw ${loadErrors.length} uncaught error${
              loadErrors.length === 1 ? '' : 's'
            }: ${loadErrors[0]!.message}`,
            { errors: loadErrors },
          ),
    );

    const failedAssets = handle?.assetsFailed ?? [];
    const assetProblems = [...notFound, ...failedAssets];
    checks.push(
      assetProblems.length === 0
        ? result('assets-resolve', 'passed', 'Every file the build asked for came back.')
        : result(
            'assets-resolve',
            'failed',
            `${assetProblems.length} asset request${
              assetProblems.length === 1 ? '' : 's'
            } did not resolve: ${assetProblems.slice(0, 3).join(', ')}`,
            { notFound, failedAssets },
          ),
    );

    checks.push(
      sceneReady
        ? result('scene-loaded', 'passed', 'The engine reported the scene ready.', {
            sceneName: handle?.sceneName,
          })
        : result(
            'scene-loaded',
            'failed',
            `The engine never reported the scene ready within ${
              settings.loadTimeoutMs / 1000
            }s. The build hangs rather than starting.`,
            { timeoutMs: settings.loadTimeoutMs },
          ),
    );

    if (!sceneReady || !handle) {
      // Everything below needs a running world to ask questions of. Skipped, not passed — see the
      // note on `SmokeCheckStatusSchema`.
      for (const id of ['physics-initialises', 'player-moves', 'player-survives-idle'] as const) {
        checks.push(result(id, 'skipped', 'The scene never loaded, so this could not be checked.'));
      }
      checks.push(
        result('memory-stable', 'skipped', 'The scene never loaded, so this could not be checked.'),
      );
    } else if (handle.mode === 'static') {
      // A static export renders the world and stops. It has no physics, no player and no menu; the
      // checks below are not failures waiting to happen, they are questions that do not apply.
      for (const id of ['physics-initialises', 'player-moves', 'player-survives-idle'] as const) {
        checks.push(
          result(id, 'not-applicable', 'This is a static export: it draws the world and stops.'),
        );
      }
      checks.push(await memoryCheck(page, handle.heap, settings.idleMs));
    } else {
      const physicsUp = handle.physicsReady === true;
      checks.push(
        physicsUp
          ? result('physics-initialises', 'passed', "Rapier's WebAssembly compiled and ran.")
          : result(
              'physics-initialises',
              'failed',
              'The scene loaded but the physics engine never started, so nothing in this world ' +
                'can move. The WebAssembly is bundled inside engine/runtime.js rather than ' +
                'fetched, so this means the bundle itself is damaged.',
              { sceneReady: true, ready },
            ),
      );

      if (!physicsUp || !ready) {
        for (const id of ['player-moves', 'player-survives-idle'] as const) {
          checks.push(
            result(id, 'skipped', 'The game never reached its loop, so this could not be checked.'),
          );
        }
        checks.push(result('memory-stable', 'skipped', 'The game never reached its loop.'));
      } else {
        checks.push(...(await playChecks(page, handle, settings)));
        checks.push(await memoryCheck(page, handle.heap, 0));
      }
    }

    if (options.screenshotPath && checks.some((check) => check.status === 'failed')) {
      await page.screenshot({ path: options.screenshotPath });
    }
  } finally {
    await browser.close();
    await site.close();
  }

  // Ordered before it is graded, so a report always reads in the order the checks are defined —
  // which is what makes a skip mean "the thing above it failed" rather than "somewhere earlier".
  checks.sort((a, b) => SMOKE_CHECK_ORDER.indexOf(a.id) - SMOKE_CHECK_ORDER.indexOf(b.id));

  return SmokeReportSchema.parse({
    buildId: options.buildId ?? root,
    sceneName: checks.find((check) => check.id === 'scene-loaded')?.evidence['sceneName'] ?? root,
    passed: checks.every((check) => check.status === 'passed' || check.status === 'not-applicable'),
    checks,
    errors,
    startedAt,
    durationMs: Date.now() - began,
  });
}

/**
 * Starts the game and asks it two questions: does the player survive standing still, and does the
 * player move when told to.
 *
 * Idle is measured *first* even though it is reported second. Walking into a hazard and being
 * damaged at spawn look identical in the health number afterwards, and only one of them is a bug.
 */
async function playChecks(
  page: Page,
  handle: ExportHandle,
  settings: Required<Pick<SmokeOptions, 'moveMs' | 'idleMs'>> & { loadTimeoutMs: number },
): Promise<SmokeCheckResult[]> {
  const play = page.locator('.hela-panel button', { hasText: 'Play' }).first();

  try {
    await play.click({ timeout: 30_000 });
    await page.locator('.hela-hud').waitFor({ state: 'visible', timeout: 60_000 });
  } catch {
    return [
      result(
        'player-moves',
        'failed',
        'The game never started: its Play button did not lead to a running world.',
      ),
      result('player-survives-idle', 'skipped', 'The game never started.'),
    ];
  }

  // Compared against the scene's *declared* maximum rather than against a reading taken a moment
  // earlier: a damage volume sitting on the spawn does its work in the first frame, and two
  // readings taken after it would agree perfectly about a player who is already hurt.
  const startHealth = handle.maxHealth;
  await page.waitForTimeout(settings.idleMs);
  const idle = await readHandle(page);
  const idleHealth = idle?.health ?? 0;
  const restingAt = idle?.position ?? [0, 0, 0];

  const before = restingAt;
  await page.keyboard.down('w');
  await page.waitForTimeout(settings.moveMs);
  await page.keyboard.up('w');
  const after = (await readHandle(page))?.position ?? before;

  const travelled = Math.hypot(after[0] - before[0], after[2] - before[2]);
  const fell = after[1] < handle.spawn[1] - FELL_METRES;

  const movement = fell
    ? result(
        'player-moves',
        'failed',
        `The player fell out of the world — ${Math.round(
          handle.spawn[1] - after[1],
        )}m below the spawn and still going. The spawn point is probably inside or under the terrain.`,
        { spawn: handle.spawn, endedAt: after, travelled },
      )
    : travelled >= MOVED_METRES
      ? result('player-moves', 'passed', `Held forward for ${settings.moveMs}ms and moved.`, {
          travelled: Number(travelled.toFixed(2)),
          from: before,
          to: after,
        })
      : result(
          'player-moves',
          'failed',
          `The player did not move: ${travelled.toFixed(
            2,
          )}m after ${settings.moveMs}ms of held input. The spawn is probably stuck inside geometry.`,
          { spawn: handle.spawn, from: before, to: after, travelled },
        );

  const survival =
    idleHealth >= startHealth
      ? result('player-survives-idle', 'passed', `Stood still for ${settings.idleMs}ms unharmed.`, {
          health: idleHealth,
        })
      : result(
          'player-survives-idle',
          'failed',
          `The player lost ${
            startHealth - idleHealth
          } health while standing still at the spawn. Something is damaging them before they move.`,
          { startHealth, idleHealth, spawn: handle.spawn },
        );

  return [movement, survival];
}

/** A cheap leak catch: sample the heap, wait, sample again. */
async function memoryCheck(
  page: Page,
  before: number | null,
  settleMs: number,
): Promise<SmokeCheckResult> {
  if (before === null) {
    return result(
      'memory-stable',
      'not-applicable',
      'This browser does not report heap usage, so there is nothing to measure.',
    );
  }

  if (settleMs > 0) await page.waitForTimeout(settleMs);
  const after = (await readHandle(page))?.heap ?? before;
  const growth = after - before;

  return growth < HEAP_GROWTH_BYTES
    ? result('memory-stable', 'passed', 'The heap did not run away over the play window.', {
        beforeBytes: before,
        afterBytes: after,
        growthBytes: growth,
      })
    : result(
        'memory-stable',
        'failed',
        `The heap grew ${Math.round(growth / 1024 / 1024)}MB over a few seconds of play, which is ` +
          'something allocating every frame and never letting go.',
        { beforeBytes: before, afterBytes: after, growthBytes: growth },
      );
}
