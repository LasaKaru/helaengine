import { expect, test, type Page } from '@playwright/test';

/**
 * The look presets and world size, in a real browser.
 *
 * Both are settings that are easy to store and easy to not apply — this codebase has already been
 * bitten twice by a value that saved, exported and round-tripped correctly while doing nothing at
 * all in the viewport. So the claims here are made against pixels and against the height field,
 * never against the document.
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
  await page.getByRole('button', { name: /Forest clearing/ }).click();
  await page.waitForFunction(() => window.helaengine !== undefined);
  await page.waitForTimeout(1500);
}

/** A settled frame: shot once the canvas has stopped changing between reads. */
async function settledFrame(page: Page): Promise<Buffer> {
  const canvas = page.locator('canvas').first();
  let previous = await canvas.screenshot();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(250);
    const next = await canvas.screenshot();
    if (next.equals(previous)) return next;
    previous = next;
  }
  return previous;
}

test.describe('look presets', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await page.evaluate(() => window.helaengine!.setCameraPose([18, 12, 24], [0, 1, 0]));
  });

  test('realistic changes the image, and stylised puts it back', async ({ page }) => {
    await page.getByRole('button', { name: 'Stylised' }).click();
    const flat = await settledFrame(page);

    await page.getByRole('button', { name: 'Realistic' }).click();
    // The composer has to actually be running, or "the pixels changed" is just the ambient dropping.
    expect(await page.evaluate(() => window.helaengine!.postProcessingActive())).toBe(true);
    const lit = await settledFrame(page);
    expect(lit.equals(flat)).toBe(false);

    await page.getByRole('button', { name: 'Stylised' }).click();
    expect(await page.evaluate(() => window.helaengine!.postProcessingActive())).toBe(false);
    const back = await settledFrame(page);

    // The round trip is the claim: a preset that only ever added would leave bloom and a filmic
    // curve sitting under a look whose entire point is to be flat.
    expect(back.equals(flat)).toBe(true);
  });

  test('the preset survives a save and reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Realistic' }).click();
    await settledFrame(page);

    const saved = await page.evaluate(() =>
      JSON.stringify(window.helaengine!.store.getState().scene),
    );
    await page.evaluate((json) => {
      window.helaengine!.store.getState().setScene(JSON.parse(json));
    }, saved);
    await page.waitForTimeout(1000);

    expect(await page.evaluate(() => window.helaengine!.postProcessingActive())).toBe(true);
    const environment = await page.evaluate(
      () => window.helaengine!.store.getState().scene.environment,
    );
    expect(environment.toneMapping).toBe('aces');
    expect(environment.lighting.hemisphere).not.toBeNull();
  });
});

test.describe('world size', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('resizing keeps the sculpted landscape, stretched to fit', async ({ page }) => {
    // Sculpt a hill, then measure it at the same *fraction* across the map before and after.
    await page.getByRole('button', { name: 'Sculpt' }).click();
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.57, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);

    const before = await page.evaluate(() => ({
      size: window.helaengine!.store.getState().scene.terrain.size,
      height: window.helaengine!.terrainHeightAt(0, 0),
    }));
    expect(Math.abs(before.height!)).toBeGreaterThan(0.01);

    await page.getByRole('button', { name: 'Select' }).click();
    await page.getByRole('combobox', { name: 'World size' }).selectOption('256');
    await page.waitForTimeout(800);

    const after = await page.evaluate(() => ({
      size: window.helaengine!.store.getState().scene.terrain.size,
      height: window.helaengine!.terrainHeightAt(0, 0),
    }));

    expect(after.size).toEqual([256, 256]);
    /**
     * The heightmap is normalised heights stretched over the extent, not samples at fixed world
     * positions — so resizing scales the landscape horizontally and keeps every hill. The centre of
     * the map is the centre of the map at any size, so the height there is unchanged.
     */
    expect(after.height).toBeCloseTo(before.height!, 3);
    expect(before.size).not.toEqual(after.size);
  });

  test('a bigger world grows more ground cover at the same density', async ({ page }) => {
    await page.getByRole('button', { name: 'Add layer' }).click();
    await page.getByRole('combobox', { name: /model$/i }).selectOption('grass_large');

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.scatterCount()), { timeout: 30_000 })
      .toBeGreaterThan(0);
    const small = await page.evaluate(() => window.helaengine!.scatterCount());

    await page.getByRole('combobox', { name: 'World size' }).selectOption('256');

    // Density is per unit area, so this is the whole point of that unit: the field covers the new
    // world rather than sitting in a patch in the middle of it.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.scatterCount()), { timeout: 30_000 })
      .toBeGreaterThan(small * 1.5);
  });
});
