import { expect, test, type Page } from '@playwright/test';

/**
 * Sprint 3 smoke test — it asserts the one thing this sprint claims: that a change to the store
 * puts a real asset in the viewport, through the shared engine, with no editor-side placement code.
 *
 * It drives the app through the dev API rather than the UI because the UI for placing objects does
 * not exist until Sprint 4. When it does, this test switches to clicking, and the assertion below
 * stays exactly the same.
 */
test.describe('editor shell', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('banner')).toBeVisible();
    await page.waitForFunction(() => window.helaengine !== undefined);
  });

  test('renders the shell with a live canvas', async ({ page }) => {
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Assets' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Inspector' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('0 objects');
  });

  test('loads the manifest produced by the ingest pipeline', async ({ page }) => {
    const assetIds = await page.evaluate(() => window.helaengine!.assetIds());
    expect(assetIds).toContain('tree_pine_01');
    expect(assetIds.length).toBeGreaterThanOrEqual(10);
  });

  test('adding an object to the store puts a real model in the scene', async ({ page }) => {
    await page.evaluate(() => window.helaengine!.addObject('building_hut_01', [0, 0, 0]));

    await expect(page.getByRole('status')).toContainText('1 objects');
    await expect(page.getByRole('region', { name: 'Scene' })).toContainText('building_hut_01');

    // The real assertion: the object reached the Three.js scene graph, not just React state.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds()))
      .toEqual(['obj_0001']);
  });

  test('renders loaded GLB models rather than placeholder boxes', async ({ page }) => {
    // Regression test. The bridge preloads models and builds the scene in two steps, so an object
    // added before its GLB arrives is drawn as a placeholder. If the rebuild after preload does not
    // fire, the editor silently shows grey boxes forever while claiming everything loaded.
    await page.evaluate(() => window.helaengine!.addObject('building_hut_01'));

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjects()))
      .toEqual([{ id: 'obj_0001', assetId: 'building_hut_01', isModel: true }]);
  });

  test('removing an object takes it back out of the viewport', async ({ page }) => {
    await page.evaluate(() => window.helaengine!.addObject('rock_boulder_01'));
    await expect(page.getByRole('status')).toContainText('1 objects');

    await page.evaluate(() => window.helaengine!.clear());

    await expect(page.getByRole('status')).toContainText('0 objects');
    await expect(page.getByRole('region', { name: 'Scene' })).toContainText('This scene is empty');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds()))
      .toEqual([]);
  });

  test('reports no console errors during a normal session', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.evaluate(() => window.helaengine!.addObject('tree_pine_01', [3, 0, 2]));
    await expect(page.getByRole('status')).toContainText('1 objects');

    expect(errors).toEqual([]);
  });
});

/**
 * Drag-to-place is the one flow in this sprint that unit tests genuinely cannot reach: it needs a
 * real pointer, a real camera and a real raycast against real terrain.
 */
test.describe('drag to place', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.helaengine !== undefined);
    await expect(page.getByRole('region', { name: 'Assets' })).toBeVisible();
  });

  async function dragAssetTo(
    page: Page,
    assetId: string,
    target: { x: number; y: number },
  ): Promise<void> {
    const card = page.locator(`[data-asset-id="${assetId}"]`);
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Two moves: the first enters the viewport, the second settles on the target so the ghost has
    // a frame to follow the pointer before release.
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.move(target.x, target.y);
    await page.mouse.up();
  }

  test('dropping an asset on the terrain adds it to the scene', async ({ page }) => {
    const canvas = page.locator('canvas');
    const canvasBox = (await canvas.boundingBox())!;

    await dragAssetTo(page, 'building_hut_01', {
      x: canvasBox.x + canvasBox.width / 2,
      y: canvasBox.y + canvasBox.height * 0.62,
    });

    await expect(page.getByRole('status').last()).toContainText('1 objects');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjects()))
      .toEqual([{ id: 'obj_0001', assetId: 'building_hut_01', isModel: true }]);

    // Placed where it was dropped, and resting on the ground rather than floating.
    const placed = await page.evaluate(
      () => window.helaengine!.store.getState().scene.objects[0]!.transform,
    );
    expect(placed.position[1]).toBeCloseTo(0, 3);
    expect(Math.abs(placed.position[0]) + Math.abs(placed.position[2])).toBeGreaterThan(0);
  });

  test('dropping on the sky places nothing', async ({ page }) => {
    const canvasBox = (await page.locator('canvas').boundingBox())!;

    // Near the top of the viewport the camera is looking above the horizon, so the ray misses.
    await dragAssetTo(page, 'rock_boulder_01', {
      x: canvasBox.x + canvasBox.width / 2,
      y: canvasBox.y + 8,
    });

    await expect(page.getByRole('status').last()).toContainText('0 objects');
  });

  test('snap to grid rounds the dropped position to whole metres', async ({ page }) => {
    await page.getByLabel('Snap to grid').check();
    const canvasBox = (await page.locator('canvas').boundingBox())!;

    await dragAssetTo(page, 'prop_crate_01', {
      x: canvasBox.x + canvasBox.width * 0.42,
      y: canvasBox.y + canvasBox.height * 0.68,
    });

    const [x, , z] = await page.evaluate(
      () => window.helaengine!.store.getState().scene.objects[0]!.transform.position,
    );
    expect(x % 1).toBe(0);
    expect(z % 1).toBe(0);
  });

  test('search narrows the library', async ({ page }) => {
    await page.getByLabel('Search assets').fill('goblin');
    await expect(page.getByText(/1 of 10/)).toBeVisible();
    await expect(page.locator('[data-asset-id="enemy_goblin_01"]')).toBeVisible();
  });
});

/**
 * Selection and transforms. These need a real raycast against real geometry and a real gizmo, so
 * they live here rather than in the component tests.
 */
test.describe('selection and transforms', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.helaengine !== undefined);
    await page.evaluate(() => {
      window.helaengine!.addObject('building_hut_01', [0, 0, 0]);
      // Off the camera-to-origin line, so it never occludes the hut when clicking.
      window.helaengine!.addObject('tree_pine_01', [-9, 0, 7]);
    });
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(2);
  });

  test('clicking an object selects it and fills the inspector', async ({ page }) => {
    // Projected rather than guessed: the object's own screen position is the only reliable target.
    const point = (await page.evaluate(() => window.helaengine!.projectObject('obj_0001')))!;
    await page.mouse.click(point.x, point.y);

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.store.getState().selectedIds))
      .toEqual(['obj_0001']);
    await expect(page.getByRole('region', { name: 'Inspector' })).toContainText('building_hut_01');
    await expect(page.getByLabel('Position X')).toBeVisible();
  });

  test('clicking empty space clears the selection', async ({ page }) => {
    await page.evaluate(() => window.helaengine!.store.getState().select(['obj_0001']));
    const canvasBox = (await page.locator('canvas').boundingBox())!;

    await page.mouse.click(
      canvasBox.x + canvasBox.width * 0.12,
      canvasBox.y + canvasBox.height * 0.9,
    );

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.store.getState().selectedIds))
      .toEqual([]);
  });

  test('shift-clicking in the scene list extends the selection', async ({ page }) => {
    const list = page.getByRole('region', { name: 'Scene' });
    await list.getByRole('button').first().click();
    await list
      .getByRole('button')
      .nth(1)
      .click({ modifiers: ['Shift'] });

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.store.getState().selectedIds))
      .toEqual(['obj_0001', 'obj_0002']);
    await expect(page.getByRole('region', { name: 'Inspector' })).toContainText(
      '2 objects selected',
    );
  });

  test('editing a numeric field moves the object in the viewport', async ({ page }) => {
    await page.getByRole('region', { name: 'Scene' }).getByRole('button').first().click();

    const field = page.getByLabel('Position X');
    await field.fill('12.5');
    await field.press('Enter');

    await expect
      .poll(async () =>
        page.evaluate(
          () => window.helaengine!.store.getState().scene.objects[0]!.transform.position[0],
        ),
      )
      .toBe(12.5);

    // The node itself moved, not just the document — this is the incremental sync path.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectWorldX('obj_0001')))
      .toBeCloseTo(12.5, 3);
  });

  test('W / E / R switch the transform mode', async ({ page }) => {
    await page.getByRole('region', { name: 'Scene' }).getByRole('button').first().click();

    await page.keyboard.press('e');
    await expect(page.getByRole('button', { name: 'rotate' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.keyboard.press('r');
    await expect(page.getByRole('button', { name: 'scale' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('Ctrl+D duplicates and Delete removes', async ({ page }) => {
    await page.getByRole('region', { name: 'Scene' }).getByRole('button').first().click();

    await page.keyboard.press('Control+d');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(3);

    await page.keyboard.press('Delete');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(2);
  });

  test('the shortcuts modal opens with ? and closes with Escape', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
  });

  test('the gizmo appears for a selection and survives a transform edit', async ({ page }) => {
    await page.getByRole('region', { name: 'Scene' }).getByRole('button').first().click();

    // A gizmo attached to a node that gets rebuilt on every edit would vanish here. It must not.
    await expect.poll(async () => page.evaluate(() => window.helaengine!.hasGizmo())).toBe(true);

    const field = page.getByLabel('Position Z');
    await field.fill('4');
    await field.press('Enter');

    await expect.poll(async () => page.evaluate(() => window.helaengine!.hasGizmo())).toBe(true);
  });
});
