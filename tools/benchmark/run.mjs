/**
 * The recurring performance benchmark.
 *
 * Loads the Stress Test template (500 static props, 20 patrolling goblins with AI and kinematic
 * bodies, sculpted terrain), then reports the numbers that are worth comparing between sprints.
 *
 * Two of them are hardware-independent and are the ones to hold to account: **draw calls** and
 * **triangles**. The third, frame time, is measured on whatever GPU is present — in CI that is
 * SwiftShader, a software rasteriser roughly two orders of magnitude slower than real hardware, so
 * it is reported as a floor and never as the acceptance bar. See docs/PERFORMANCE.md.
 *
 *   pnpm bench                 # against a preview server already on :5174
 *   pnpm bench -- --json       # machine-readable, for a regression check
 */
import { chromium } from 'playwright';

const url = process.env.BENCH_URL ?? 'http://localhost:5174';
const asJson = process.argv.includes('--json');
const executablePath = process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium';

const browser = await chromium.launch({
  executablePath,
  args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

const errors = [];
page.on('pageerror', (error) => errors.push(String(error.message)));
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));

await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(
  () =>
    new Promise((resolve) => {
      const request = indexedDB.deleteDatabase('helaengine');
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;
    }),
);
await page.reload();

await page.getByRole('button', { name: /Stress test/ }).click();
await page.getByRole('banner').waitFor();
await page.waitForFunction(() => window.helaengine !== undefined);
// The manifest's models arrive asynchronously; benchmarking placeholder boxes would flatter it.
await page.waitForTimeout(6000);

/** Samples frame intervals for a while and returns the distribution. */
async function sampleFrames(seconds) {
  return page.evaluate(
    (duration) =>
      new Promise((resolve) => {
        const samples = [];
        let last = performance.now();
        const stopAt = last + duration * 1000;

        const tick = (now) => {
          samples.push(now - last);
          last = now;
          if (now < stopAt) requestAnimationFrame(tick);
          else resolve(samples.slice(1));
        };
        requestAnimationFrame(tick);
      }),
    seconds,
  );
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
  const mean = sorted.reduce((total, value) => total + value, 0) / (sorted.length || 1);
  return {
    frames: sorted.length,
    meanMs: Number(mean.toFixed(2)),
    medianMs: Number((at(0.5) ?? 0).toFixed(2)),
    p95Ms: Number((at(0.95) ?? 0).toFixed(2)),
    worstMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
  };
}

const editing = {
  ...(await page.evaluate(() => window.helaengine.renderStats())),
  ...summarise(await sampleFrames(4)),
};
const objectCount = await page.evaluate(
  () => window.helaengine.store.getState().scene.objects.length,
);

await page.getByRole('button', { name: 'Walk' }).click();
await page.waitForFunction(() => window.helaengine.playerPosition() !== null, { timeout: 30_000 });

/**
 * Dismiss the game's own main menu, and the reason is the whole point of this benchmark.
 *
 * The Stress Test template ships a UI shell, so entering Walk mode lands on its home screen — and a
 * menu here is not an overlay, it genuinely stops the world: `PhysicsPreview` returns out of its
 * frame callback before stepping anything.
 *
 * This benchmark was written before the shell existed, and its physics numbers were real when they
 * were taken. Since the shell arrived, every "playing" figure has been measured against a *paused*
 * simulation. The giveaway sat in the output the whole time as `simulation: null`, which the
 * human-readable report skipped over in silence. The render numbers stayed honest — the scene draws
 * behind the menu — but the one figure that would say whether physics belongs on a worker had been
 * missing for sprints.
 */
await page
  .getByRole('button', { name: 'Play', exact: true })
  .click()
  .catch(() => {});
await page.waitForFunction(() => window.helaengine.uiScreen() === 'playing', { timeout: 30_000 });
await page.waitForTimeout(1500);

const playing = {
  ...(await page.evaluate(() => window.helaengine.renderStats())),
  ...summarise(await sampleFrames(6)),
  enemies: Object.keys(await page.evaluate(() => window.helaengine.enemyStates())).length,
  simulation: await page.evaluate(() => window.helaengine.simulationStats()),
};

// The same scene with batching switched off. A draw-call count with nothing to compare it against
// is not a measurement, and this is the comparison the whole sprint is about.
await page.goto(`${url}?instances=off`, { waitUntil: 'networkidle' });
await page
  .getByRole('button', { name: /Stress Test/ })
  .first()
  .click();
await page.getByRole('banner').waitFor();
await page.waitForFunction(() => window.helaengine !== undefined);
await page.waitForTimeout(6000);

const unbatched = {
  ...(await page.evaluate(() => window.helaengine.renderStats())),
  ...summarise(await sampleFrames(4)),
};

const report = {
  url,
  objects: objectCount,
  unbatched,
  editing,
  playing,
  errors,
};

/**
 * A missing measurement has to look like a failure rather than like a blank.
 *
 * This check is here rather than in the human-readable output because `--json` is what the
 * regression check reads, and the silent version of this is how a paused simulation was benchmarked
 * for several sprints without anybody noticing.
 */
if (!report.playing.simulation) {
  errors.push(
    'no simulation timing was recorded — the world was never stepped, so the "playing" numbers ' +
      'are of a paused scene. Check that the game reached its playing screen.',
  );
}

await page.screenshot({ path: new URL('./stress.png', import.meta.url).pathname });
await browser.close();

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const row = (label, stats) =>
    `${label.padEnd(12)} calls ${String(stats.calls).padStart(4)}   tris ${String(
      stats.triangles,
    ).padStart(7)}   instanced ${String(stats.instancedObjects).padStart(4)}   ` +
    `median ${String(stats.medianMs).padStart(6)}ms   p95 ${String(stats.p95Ms).padStart(6)}ms`;

  console.log(`\nHelaEngine stress benchmark — ${report.objects} objects`);
  console.log(row('no batching', unbatched));
  console.log(row('editing', editing));
  console.log(row('playing', playing));
  console.log(`\nactive enemies: ${playing.enemies}   pooled nodes: ${playing.pooledNodes}`);
  if (playing.simulation) {
    console.log(
      `simulation cost per frame: physics ${playing.simulation.physicsMs}ms   ` +
        `gameplay ${playing.simulation.gameplayMs}ms   peak ${playing.simulation.peakMs}ms   ` +
        `over ${playing.simulation.frames} frames (CPU only, comparable across machines)`,
    );
  }
  console.log(
    'frame times are SwiftShader (software) and are a floor, not the target — see docs/PERFORMANCE.md',
  );
  if (errors.length > 0) console.log(`\nconsole errors:\n  ${errors.join('\n  ')}`);
}

process.exit(errors.length > 0 ? 1 : 0);
