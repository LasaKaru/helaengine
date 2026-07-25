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
