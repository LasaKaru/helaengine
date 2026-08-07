import { expect, test, type Page } from '@playwright/test';

/**
 * Ground cover, in a real browser.
 *
 * The unit tests prove the rule produces the right transforms. What they cannot prove is that the
 * rule reaches the renderer: that the model gets fetched at all — scatter names assets nothing else
 * in the document references — and that the field is drawn rather than merely computed.
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
  await page.waitForTimeout(800);
}

/** Waits for the loader to report a grown field, which needs the model to have been fetched. */
async function grownCount(page: Page): Promise<number> {
  await expect
    .poll(async () => page.evaluate(() => window.helaengine!.scatterCount()), { timeout: 20_000 })
    .toBeGreaterThan(0);
  return page.evaluate(() => window.helaengine!.scatterCount());
}

test.describe('ground cover', () => {
  /**
   * Longer than the default thirty seconds.
   *
   * Each of these waits for a model to be fetched and a few thousand instances to be built, twice —
   * once to establish the field and once after the edit under test. That is legitimately slow, and
   * the default budget was being spent on the setup rather than on anything going wrong.
   */
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await page.evaluate(() => window.helaengine!.setCameraPose([0, 25, 45], [0, 0, 0]));
  });

  test('a layer added in the panel grows a field', async ({ page }) => {
    expect(await page.evaluate(() => window.helaengine!.scatterCount())).toBe(0);

    await page.getByRole('button', { name: 'Add layer' }).click();
    await page.getByRole('combobox', { name: /model$/i }).selectOption('grass_large');

    /**
     * This is the claim the unit tests cannot make.
     *
     * A scatter layer names a model nothing else in the document references, so `preload` had to
     * learn to walk the scatter list. Without that the loader asks its cache for a model no pass
     * ever fetched and the field simply never grows — silently, because an empty field renders
     * perfectly well.
     */
    const count = await grownCount(page);
    expect(count).toBeGreaterThan(100);
  });

  test('the same document grows the same field after a reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Add layer' }).click();
    await page.getByRole('combobox', { name: /model$/i }).selectOption('grass_large');
    const first = await grownCount(page);

    const saved = await page.evaluate(() =>
      JSON.stringify(window.helaengine!.store.getState().scene),
    );
    await page.evaluate((json) => {
      window.helaengine!.store.getState().setScene(JSON.parse(json));
    }, saved);

    // The whole reason a seed is stored instead of a list of positions: the field is a property of
    // the document, not of the run that happened to generate it.
    const second = await grownCount(page);
    expect(second).toBe(first);
  });

  test('a different seed gives a different field, and the same seed does not', async ({ page }) => {
    await page.getByRole('button', { name: 'Add layer' }).click();
    await page.getByRole('combobox', { name: /model$/i }).selectOption('grass_large');
    await grownCount(page);

    const canvas = page.locator('canvas').first();
    const before = await canvas.screenshot();

    await page.evaluate(() => {
      const store = window.helaengine!.store.getState();
      store.updateScatterLayer(store.scene.scatter[0]!.id, { seed: 4242 });
    });
    await grownCount(page);
    await page.waitForTimeout(800);
    const after = await canvas.screenshot();

    expect(before.equals(after)).toBe(false);
  });

  test('turning a layer off empties the field', async ({ page }) => {
    await page.getByRole('button', { name: 'Add layer' }).click();
    await page.getByRole('combobox', { name: /model$/i }).selectOption('grass_large');
    await grownCount(page);

    await page.evaluate(() => {
      const store = window.helaengine!.store.getState();
      store.updateScatterLayer(store.scene.scatter[0]!.id, { enabled: false });
    });

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.scatterCount()), { timeout: 15_000 })
      .toBe(0);
  });

  test('scattered grass moves in the wind', async ({ page }) => {
    // Scatter is the case wind exists for, and the case that needed `instanceMatrix` in the shader:
    // without it every blade in the batch shares one phase and the field sways as a rigid sheet.
    await page.getByRole('button', { name: 'Add layer' }).click();
    await page.getByRole('combobox', { name: /model$/i }).selectOption('grass_large');
    await grownCount(page);

    const canvas = page.locator('canvas').first();
    const stillA = await canvas.screenshot();
    await page.waitForTimeout(400);
    const stillB = await canvas.screenshot();
    expect(stillA.equals(stillB)).toBe(true);

    await page.evaluate(() => {
      const store = window.helaengine!.store.getState();
      store.setEnvironment({ wind: { ...store.scene.environment.wind, strength: 2, speed: 3 } });
    });
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(true);

    const windyA = await canvas.screenshot();
    await page.waitForTimeout(400);
    const windyB = await canvas.screenshot();
    expect(windyA.equals(windyB)).toBe(false);
  });
});
