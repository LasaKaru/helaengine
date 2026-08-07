import { expect, test, type Page } from '@playwright/test';

/**
 * Wind, in a real browser with a real GPU pipeline.
 *
 * The unit tests check the generated shader source. They cannot check that it *compiles* — a GLSL
 * error in an `onBeforeCompile` patch does not throw, it logs and leaves the material rendering
 * nothing or rendering unmoved. So the claim here is made the only way it can be: place a plant,
 * turn the wind on, and prove the pixels change between two frames while nothing else does.
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

/** Places one object of an asset at the origin, by editing the document directly. */
async function place(page: Page, assetId: string): Promise<void> {
  await page.evaluate((id) => {
    const store = window.helaengine!.store.getState();
    store.addObject({
      id: 'subject',
      assetId: id,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [8, 8, 8] },
      behaviors: [],
      physics: { body: 'static', collider: 'auto' },
      animation: null,
      material: null,
      trigger: null,
      sway: 'auto',
      metadata: {},
    } as never);
  }, assetId);

  /**
   * Point the camera at it, close.
   *
   * Without this the subject may be off screen, and then *both* halves of the comparison are a
   * picture of empty sky — the still case passes because nothing moved and the windy case fails for
   * the same reason. The first version of this test did exactly that, and reported the shader as
   * broken when what was broken was the framing.
   */
  await page.evaluate(() => window.helaengine!.setCameraPose([0, 3, 9], [0, 2, 0]));
  await page.waitForTimeout(600);
}

async function setWind(page: Page, strength: number): Promise<void> {
  await page.evaluate((value) => {
    const store = window.helaengine!.store.getState();
    store.setEnvironment({ wind: { ...store.scene.environment.wind, strength: value, speed: 3 } });
  }, strength);
  await page.waitForTimeout(600);
}

/** Two canvas frames a short time apart, as PNG bytes. */
async function twoFrames(page: Page): Promise<[Buffer, Buffer]> {
  const canvas = page.locator('canvas').first();
  const first = await canvas.screenshot();
  await page.waitForTimeout(400);
  const second = await canvas.screenshot();
  return [first, second];
}

test.describe('wind', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('a still world stays still, and a windy one does not', async ({ page }) => {
    await place(page, 'grass_large');

    // The control. Without it, "the pixels changed" proves nothing — a camera drift or an animated
    // light would pass the windy case just as well.
    expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(false);
    const [stillA, stillB] = await twoFrames(page);
    expect(stillA.equals(stillB)).toBe(true);
    // Two identical frames of empty sky would pass that, so the subject has to be provably there.
    expect(
      await page.evaluate(() => window.helaengine!.store.getState().scene.objects.length),
    ).toBe(1);

    await setWind(page, 2);
    expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(true);

    const [windyA, windyB] = await twoFrames(page);
    expect(windyA.equals(windyB)).toBe(false);
  });

  test('reports no wind for a level with nothing that sways', async ({ page }) => {
    await place(page, 'rock_boulder_01');
    await setWind(page, 2);

    // A gale over a quarry moves nothing. Reported as no wind rather than as a wind with nothing to
    // blow, so the frame loop does not spend the level updating a uniform no shader reads.
    expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(false);

    const [a, b] = await twoFrames(page);
    expect(a.equals(b)).toBe(true);
  });

  test('an object told never to move stays put in a gale', async ({ page }) => {
    await place(page, 'grass_large');
    await setWind(page, 2);
    expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(true);

    await page.evaluate(() => window.helaengine!.store.getState().setSway('subject', 'none'));
    await page.waitForTimeout(600);

    // The potted-plant-indoors case, and the one that proves the override reaches the renderer
    // rather than merely being stored — the failure this codebase has already been bitten by twice.
    expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(false);
    const [a, b] = await twoFrames(page);
    expect(a.equals(b)).toBe(true);
  });

  test('a felled log does not wave, though it ships as a tree', async ({ page }) => {
    // `log` is in the `trees` category and would sway on category alone. It is the single most
    // obviously wrong thing the system could do, which is why the rule reads the id.
    await place(page, 'log');
    await setWind(page, 2);
    expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(false);
  });

  test('the wind survives a save and reload of the document', async ({ page }) => {
    await place(page, 'grass_large');
    await setWind(page, 1.5);

    const saved = await page.evaluate(() =>
      JSON.stringify(window.helaengine!.store.getState().scene),
    );
    await page.evaluate((json) => {
      window.helaengine!.store.getState().setScene(JSON.parse(json));
    }, saved);
    await page.waitForTimeout(600);

    const wind = await page.evaluate(
      () => window.helaengine!.store.getState().scene.environment.wind,
    );
    expect(wind.strength).toBeCloseTo(1.5, 3);
    expect(await page.evaluate(() => window.helaengine!.windActive())).toBe(true);
  });
});
