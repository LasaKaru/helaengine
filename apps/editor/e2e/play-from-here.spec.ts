import { expect, test, type Page } from '@playwright/test';

/**
 * Play From Here, and ejecting.
 *
 * Both are about the *editing loop* rather than about the game, so both claims are about what does
 * not happen: starting somewhere must not move the spawn point, and ejecting must not stop the
 * world. Either failure leaves a feature that appears to work and quietly ruins a level.
 */

async function openEditor(page: Page): Promise<void> {
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
  await page.getByRole('button', { name: /Empty field/ }).click();
  await page.waitForFunction(() => window.helaengine !== undefined);
  await page.waitForTimeout(1000);
}

async function startPlaying(page: Page): Promise<void> {
  const play = page.locator('.hela-panel button', { hasText: 'Play' });
  if ((await play.count()) === 0) return;
  await expect
    .poll(
      async () => {
        if ((await play.count()) === 0) return 'gone';
        await play
          .first()
          .click({ force: true })
          .catch(() => undefined);
        return page.evaluate(() => window.helaengine!.uiScreen());
      },
      { timeout: 20_000 },
    )
    .not.toBe('home');
}

/** The dev API reports a point as `{x, y, z}`, not a tuple. */
async function waitForPlayer(page: Page): Promise<{ x: number; y: number; z: number }> {
  await page.waitForFunction(() => window.helaengine!.playerPosition() !== null, undefined, {
    timeout: 20_000,
  });
  await startPlaying(page);
  return (await page.evaluate(() => window.helaengine!.playerPosition()))!;
}

/**
 * Leaves Play Preview.
 *
 * Escape *pauses* once the game shell is up, which is what a player expects it to do — Quit on the
 * pause menu is the gesture that actually leaves. Mirrors the helper in `editor.spec.ts`.
 */
async function exitWalk(page: Page): Promise<void> {
  if ((await page.locator('.hela-ui').count()) === 0) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    return;
  }

  if ((await page.evaluate(() => window.helaengine!.uiScreen())) === 'playing') {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  await page.locator('.hela-panel button', { hasText: 'Quit' }).click();
  await page.waitForTimeout(600);
}

test.describe('play from here', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('drops the player where asked, without moving the spawn point', async ({ page }) => {
    const before = await page.evaluate(
      () => window.helaengine!.store.getState().scene.player.spawn,
    );

    await page.evaluate(() => window.helaengine!.playFrom([24, 2, -18]));
    const position = await waitForPlayer(page);

    expect(position.x).toBeCloseTo(24, 0);
    expect(position.z).toBeCloseTo(-18, 0);

    /**
     * The claim that makes this editor state rather than document state.
     *
     * Somebody testing the boss room twenty times has not decided the game should start there, and
     * a Play From Here that quietly rewrote `player.spawn` would ship a game beginning at whichever
     * corner its author last checked.
     */
    const after = await page.evaluate(() => window.helaengine!.store.getState().scene.player.spawn);
    expect(after).toEqual(before);
  });

  test('the next plain Walk goes back to the spawn point', async ({ page }) => {
    await page.evaluate(() => window.helaengine!.playFrom([30, 2, 30]));
    const moved = await waitForPlayer(page);
    expect(moved.x).toBeCloseTo(30, 0);

    await exitWalk(page);

    await page.getByRole('button', { name: 'Walk' }).click();
    const home = await waitForPlayer(page);
    const spawn = await page.evaluate(() => window.helaengine!.store.getState().scene.player.spawn);
    expect(home.x).toBeCloseTo(spawn[0], 0);
    expect(home.z).toBeCloseTo(spawn[2], 0);
  });
});

test.describe('ejecting', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: 'Walk' }).click();
    await waitForPlayer(page);
  });

  test('keeps the world running while the camera comes free', async ({ page }) => {
    expect(await page.evaluate(() => window.helaengine!.possessed())).toBe(true);
    // The counter starts at zero for a frame or two, and "did it advance" needs somewhere to start.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.simulationStats()), {
        timeout: 15_000,
      })
      .not.toBeNull();

    await page.keyboard.press('F8');
    expect(await page.evaluate(() => window.helaengine!.possessed())).toBe(false);
    await expect(page.getByLabel('Walk mode')).toContainText('Ejected');

    /**
     * The simulation is still going.
     *
     * `frames` is incremented by the walk loop each time it steps physics and updates the runtime,
     * so it only advances while the world is actually being simulated. That is the thing that must
     * not stop — pausing to look at a patrol is what makes a patrol unobservable.
     */
    const first = (await page.evaluate(() => window.helaengine!.simulationStats()))!.frames;
    await expect
      .poll(
        async () => (await page.evaluate(() => window.helaengine!.simulationStats()))?.frames ?? 0,
        { timeout: 10_000 },
      )
      .toBeGreaterThan(first + 10);
  });

  test('the player stops taking input while ejected', async ({ page }) => {
    const before = (await page.evaluate(() => window.helaengine!.playerPosition()))!;

    await page.keyboard.press('F8');
    await page.keyboard.down('w');
    await page.waitForTimeout(900);
    await page.keyboard.up('w');

    const after = (await page.evaluate(() => window.helaengine!.playerPosition()))!;
    // An ejected pawn is nobody's. Left driveable, you would walk it blindly into a wall while
    // looking somewhere else entirely.
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeLessThan(0.5);
  });

  test('taking control again moves the player', async ({ page }) => {
    await page.keyboard.press('F8');
    await page.keyboard.press('F8');
    expect(await page.evaluate(() => window.helaengine!.possessed())).toBe(true);
    await expect(page.getByLabel('Walk mode')).toContainText('Walking');

    const before = (await page.evaluate(() => window.helaengine!.playerPosition()))!;
    await page.keyboard.down('w');
    await page.waitForTimeout(900);
    await page.keyboard.up('w');
    const after = (await page.evaluate(() => window.helaengine!.playerPosition()))!;

    // The control test: without this, "ejected does not move" would pass on a build where nothing
    // moves at all.
    expect(Math.hypot(after.x - before.x, after.z - before.z)).toBeGreaterThan(1);
  });

  test('leaving the preview takes control back', async ({ page }) => {
    await page.keyboard.press('F8');
    expect(await page.evaluate(() => window.helaengine!.possessed())).toBe(false);

    await exitWalk(page);

    // Otherwise the next Walk starts ejected, and the WASD keys do nothing for no visible reason.
    expect(await page.evaluate(() => window.helaengine!.possessed())).toBe(true);
  });
});
