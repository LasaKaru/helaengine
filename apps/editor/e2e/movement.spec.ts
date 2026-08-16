import { expect, test, type Page } from '@playwright/test';

/**
 * How movement feels, in a real browser.
 *
 * The controller's own tests already step a solver and prove the arithmetic. What only a browser can
 * show is that the *document* reaches it — that a number typed into the Player panel is the number
 * the character controller was built with, and that pressing the key does what the setting promised.
 *
 * Mantling is the one worth driving from the keyboard, because it is the only one of the four whose
 * failure is visible rather than felt: either the player ends up on top of the crate or they do not.
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

/**
 * A square wall of crates around the spawn, and a player who will meet it whichever way they walk.
 *
 * A single ledge in front of the spawn is the obvious build and it does not work: the preview camera
 * does not start at a yaw of zero, so holding forward walks the player diagonally straight past it.
 * Ringing the spawn removes the dependency on which way they happen to face — the test is about
 * mantling, not about the camera's starting angle.
 *
 * `prop_crate_01` is 0.94 × 0.9 × 0.94, so a scale of 1.7 in y is a wall about 1.5m high: too tall
 * to step over, and too tall for the deliberately weak jump below to clear.
 *
 * `mantleHeight` is the whole variable. Same geometry, same walk, same key.
 */
async function buildLedge(page: Page, mantleHeight: number): Promise<void> {
  await page.evaluate((mantle) => {
    const state = window.helaengine!.store.getState();

    const walls: Array<[string, [number, number, number], [number, number, number]]> = [
      ['wall_n', [0, 0, -5], [14, 1.7, 1]],
      ['wall_s', [0, 0, 5], [14, 1.7, 1]],
      ['wall_e', [5, 0, 0], [1, 1.7, 14]],
      ['wall_w', [-5, 0, 0], [1, 1.7, 14]],
    ];

    for (const [id, position, scale] of walls) {
      state.addObject({
        id,
        assetId: 'prop_crate_01',
        parentId: null,
        transform: { position, rotation: [0, 0, 0], scale },
        physics: { body: 'static', collider: 'box' },
      } as never);
    }

    // A jump that cannot clear the wall on its own: 3 m/s against the default gravity of 24 reaches
    // about 19cm. Anything the player gets above that came from mantling.
    state.setPlayer({ spawn: [0, 0, 0], mantleHeight: mantle, jumpSpeed: 3 });
  }, mantleHeight);
  await page.waitForTimeout(300);
}

async function play(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.waitForFunction(() => window.helaengine!.playerPosition() !== null, undefined, {
    timeout: 20_000,
  });

  const start = page.locator('.hela-panel button', { hasText: 'Play' });
  if ((await start.count()) > 0) {
    await expect
      .poll(
        async () => {
          if ((await start.count()) === 0) return 'gone';
          await start
            .first()
            .click({ force: true })
            .catch(() => undefined);
          return page.evaluate(() => window.helaengine!.uiScreen());
        },
        { timeout: 20_000 },
      )
      .not.toBe('home');
  }

  await page.waitForTimeout(800);
}

/**
 * Walks forward against the crates while pressing jump, and reports the highest the player got.
 *
 * Sampled during the walk rather than read at the end: a successful mantle puts the player on top
 * and they then walk straight off the far side, so the final height reports a success as a failure.
 */
async function walkIntoLedge(page: Page): Promise<number> {
  await page.keyboard.down('w');

  let peak = -Infinity;
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.down('Space');
    await page.waitForTimeout(120);
    await page.keyboard.up('Space');
    await page.waitForTimeout(120);

    const at = await page.evaluate(() => window.helaengine!.playerPosition());
    if (at) peak = Math.max(peak, at.y);
  }

  await page.keyboard.up('w');
  return peak;
}

test.describe('movement feel', () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('mantling puts the player on a ledge a jump cannot clear', async ({ page }) => {
    // The control case, and it carries the whole test: with mantling off the same walk against the
    // same crates with the same weak jump has to leave the player on the ground. Without it, "they
    // got up there" would be a claim about the jump height rather than about mantling.
    await buildLedge(page, 0);
    await play(page);
    const withoutMantle = await walkIntoLedge(page);

    await openEditor(page);
    await buildLedge(page, 2);
    await play(page);
    const withMantle = await walkIntoLedge(page);

    // 19cm of jump against a 1.5m wall. Anything approaching the top came from the mantle.
    expect(withoutMantle).toBeLessThan(0.6);
    expect(withMantle).toBeGreaterThan(1);
  });

  test('the panel writes the settings into the document', async ({ page }) => {
    const panel = page.getByRole('region', { name: 'Player' });
    await panel.getByLabel('Coyote time').fill('0.12');
    await panel.getByLabel('Coyote time').blur();

    // The Feel settings are only worth anything if they survive into the document the runtime and
    // every export read from.
    expect(
      await page.evaluate(() => window.helaengine!.store.getState().scene.player.coyoteSeconds),
    ).toBeCloseTo(0.12, 5);
  });
});
