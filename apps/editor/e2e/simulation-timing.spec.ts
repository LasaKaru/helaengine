import { expect, test } from '@playwright/test';

/**
 * That the simulation is actually running when something claims to be measuring it.
 *
 * This exists because for several sprints it was not. The physics figures in `docs/PERFORMANCE.md`
 * were genuinely measured when they were written, in the sprint that added the benchmark. Two
 * sprints later the game shell arrived, and a menu in this engine does not cover the world — it
 * stops it: `PhysicsPreview` returns out of its frame callback before stepping anything. From then
 * on the benchmark clicked into Walk mode, landed on the template's main menu, sampled a paused
 * scene, and printed `simulation: null` — which the human-readable output skipped over in silence.
 *
 * Nothing about that looked wrong. The scene drew, the player existed, the frame counter moved, the
 * render numbers stayed honest. The only symptom was a blank where a line used to be, and the
 * decision that line was needed for — whether physics belongs on a worker — could not be made until
 * somebody went looking for the number.
 *
 * So both halves are pinned here: the menu really does pause, and dismissing it really does start.
 */

test.describe('simulation timing', () => {
  test.setTimeout(240_000);

  test('the world is paused behind the menu and runs once it is dismissed', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const request = indexedDB.deleteDatabase('helaengine');
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
          request.onblocked = () => resolve();
        }),
    );
    await page.reload();
    await page.getByRole('button', { name: /Stress test/ }).click();
    await page.waitForFunction(() => window.helaengine !== undefined);
    await page.waitForTimeout(6000);

    await page.getByRole('button', { name: 'Walk' }).click();
    await page.waitForFunction(() => window.helaengine!.playerPosition() !== null, {
      timeout: 60_000,
    });

    // The control, and the half that was hiding the bug. A shell on its home screen means no step
    // at all, so a long wait here still records nothing — which is correct behaviour and exactly
    // what made the benchmark's silence look like a scene that simply had no physics in it.
    await page.waitForTimeout(4000);
    expect(await page.evaluate(() => window.helaengine!.uiScreen())).toBe('home');
    expect(await page.evaluate(() => window.helaengine!.simulationStats())).toBeNull();

    await page.getByRole('button', { name: 'Play', exact: true }).click();
    await page.waitForFunction(() => window.helaengine!.uiScreen() === 'playing', {
      timeout: 30_000,
    });
    // Long enough to clear the ten warm-up frames the average deliberately ignores — the first
    // steps build Rapier's broad phase and run twenty line-of-sight traces at once, and averaging
    // those in reports a per-frame cost the game never pays.
    await page.waitForTimeout(12_000);

    const stats = await page.evaluate(() => window.helaengine!.simulationStats());
    expect(stats).not.toBeNull();
    expect(stats!.frames).toBeGreaterThan(0);
    // A real cost, not a zero that would mean the timer was reading the same instant twice.
    expect(stats!.physicsMs).toBeGreaterThan(0);
    // And a sane one: this scene is 520 objects and 20 patrolling enemies. A step costing more than
    // a whole frame's budget would mean something has gone very wrong rather than that physics is
    // expensive, and is worth failing on rather than reporting.
    expect(stats!.physicsMs).toBeLessThan(16);
  });
});
