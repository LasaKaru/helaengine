import { expect, test, type Page } from '@playwright/test';

/**
 * Joints, in a running world.
 *
 * The engine's own tests already step a solver and prove a hinge swings. What only a browser can
 * show is that the *document* reaches it: that a joint authored in the editor is built by the same
 * `buildScenePhysics` an export calls, and that pressing Play actually constrains the two objects
 * somebody joined. A joint that saves, exports and round-trips perfectly while constraining nothing
 * is the failure shape this codebase keeps meeting, and it is invisible from the document.
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
 * Two crates in the air: `post` fixed, `load` dynamic and one metre to its side.
 *
 * Built through the store rather than by clicking, because the claim under test is about the
 * runtime and not about the asset library — placing two objects by dragging would test the palette.
 */
async function buildPair(page: Page, joined: boolean): Promise<void> {
  await page.evaluate((withJoint) => {
    const store = window.helaengine!.store;
    const state = store.getState();

    for (const [id, body, x] of [
      ['post', 'static', 0],
      ['load', 'dynamic', 1],
    ] as const) {
      state.addObject({
        id,
        assetId: 'prop_crate_01',
        parentId: null,
        transform: { position: [x, 6, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        behaviors: [],
        physics: { body, collider: 'box' },
        animation: null,
        sway: 'none',
        material: null,
        trigger: null,
        metadata: {},
        // Parsed by the store's own schema on the way in, so anything missing takes its default.
      } as never);
    }

    if (withJoint) {
      const id = state.addJoint('hinge', 'post', 'load');
      state.updateJoint(id, {
        anchorA: [0, 0, 0],
        anchorB: [-1, 0, 0],
        axis: [0, 0, 1],
      } as never);
    }
  }, joined);
  await page.waitForTimeout(300);
}

/**
 * Into the world, through the game shell.
 *
 * Walk opens the home screen rather than dropping straight into play, so a test that only clicks
 * Walk is watching a paused world — and would see a crate that has not fallen whether or not it is
 * jointed. Mirrors `enterWalk` in `editor.spec.ts`.
 */
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

  await page.waitForTimeout(2500);
}

/** Where the crate actually is in the viewport, which is the only place the answer is honest. */
async function loadY(page: Page): Promise<number> {
  const position = await page.evaluate(() => window.helaengine!.viewportObjectPosition('load'));
  expect(position).not.toBeNull();
  return position!.y;
}

test.describe('joints', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('a hinge holds a crate that would otherwise hit the ground', async ({ page }) => {
    // The control case, and it is the whole test. "The crate is still up there" says nothing on its
    // own — it would pass against a world that never stepped, or one where physics failed to start.
    await buildPair(page, false);
    await play(page);
    const fell = await loadY(page);

    await openEditor(page);
    await buildPair(page, true);
    await play(page);
    const held = await loadY(page);

    expect(fell).toBeLessThan(2);
    expect(held).toBeGreaterThan(3);
  });

  test('the panel warns when neither end can move', async ({ page }) => {
    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      for (const id of ['a', 'b']) {
        state.addObject({
          id,
          assetId: 'prop_crate_01',
          parentId: null,
          transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          behaviors: [],
          physics: { body: 'static', collider: 'box' },
          animation: null,
          sway: 'none',
          material: null,
          trigger: null,
          metadata: {},
        } as never);
      }
      state.addJoint('hinge', 'a', 'b');
    });

    // Two static bodies is the single most common way to build a door that does not open: the
    // hinge is right in every respect and nothing in the world can move either end.
    await expect(page.getByRole('region', { name: 'Joints' })).toContainText('neither end');
  });

  test('deleting an object takes its joints with it', async ({ page }) => {
    await buildPair(page, true);
    expect(await page.evaluate(() => window.helaengine!.store.getState().scene.joints.length)).toBe(
      1,
    );

    await page.evaluate(() => window.helaengine!.store.getState().removeObjects(['load']));

    // A joint outliving its own end is a constraint the runtime skips and the panel warns about
    // forever. It goes in the same undo step as the deletion, so one Ctrl+Z brings both back.
    expect(await page.evaluate(() => window.helaengine!.store.getState().scene.joints.length)).toBe(
      0,
    );

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.helaengine!.store.getState().scene.joints.length)).toBe(
      1,
    );
  });
});
