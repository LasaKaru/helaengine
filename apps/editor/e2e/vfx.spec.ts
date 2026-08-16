import { expect, test, type Page } from '@playwright/test';

/**
 * Particles, in a real browser.
 *
 * The simulation is asserted against buffers in `vfx.test.ts`. What only a browser can show is that
 * the pixels change — and for an animated effect the honest form of that claim is inverted from the
 * usual one. A static scene renders two identical frames; weather makes them differ. Comparing a
 * single frame against a reference would only say the effect is *somewhere*, and comparing a settled
 * frame is impossible, because the whole point is that it never settles.
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
  await page.waitForTimeout(1200);
  // A fixed pose, so a comparison is of what is in the world rather than of two different views.
  await page.evaluate(() => window.helaengine!.setCameraPose([0, 3, 14], [0, 2, 0]));
  await page.waitForTimeout(400);
}

/** Two frames a moment apart. Identical means nothing in view is moving. */
async function twoFrames(page: Page): Promise<{ first: Buffer; second: Buffer }> {
  const canvas = page.locator('canvas').first();
  const first = await canvas.screenshot();
  await page.waitForTimeout(500);
  const second = await canvas.screenshot();
  return { first, second };
}

const setWeather = (page: Page, kind: string, intensity = 0.6): Promise<void> =>
  page.evaluate(
    ([weatherKind, weatherIntensity]) => {
      window.helaengine!.store.getState().setEnvironment({
        weather: {
          kind: weatherKind as 'rain',
          intensity: weatherIntensity as number,
          radius: 40,
          color: null,
          followWind: true,
        },
      });
    },
    [kind, intensity] as const,
  );

test.describe('particles', () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('weather moves the pixels, and a still level does not', async ({ page }) => {
    /**
     * The control case, and it carries the whole test.
     *
     * An empty field with no wind and no weather is completely static, so two frames half a second
     * apart are byte-identical. Without that half, "the frames differed" would be satisfied by any
     * animation at all — the grass, a cloud, a dithering artefact.
     */
    const still = await twoFrames(page);
    expect(still.second.equals(still.first)).toBe(true);

    await setWeather(page, 'rain');
    await page.waitForTimeout(800);

    expect(await page.evaluate(() => window.helaengine!.particleCount())).toBeGreaterThan(1000);

    const raining = await twoFrames(page);
    expect(raining.second.equals(raining.first)).toBe(false);
  });

  test('turning weather off puts the level back to still', async ({ page }) => {
    await setWeather(page, 'snow');
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => window.helaengine!.particleCount())).toBeGreaterThan(0);

    await setWeather(page, 'none');
    await page.waitForTimeout(800);

    // `none` is the absence of the system, not a storm of zero strength: nothing built, nothing
    // drawn, and the frames go back to identical.
    expect(await page.evaluate(() => window.helaengine!.particleCount())).toBe(0);
    const after = await twoFrames(page);
    expect(after.second.equals(after.first)).toBe(true);
  });

  test('intensity changes how many there are', async ({ page }) => {
    await setWeather(page, 'rain', 0.3);
    await page.waitForTimeout(700);
    const light = await page.evaluate(() => window.helaengine!.particleCount());

    await setWeather(page, 'rain', 0.9);
    await page.waitForTimeout(700);
    const heavy = await page.evaluate(() => window.helaengine!.particleCount());

    expect(heavy).toBeGreaterThan(light * 3);
  });

  test('an emitter fills up and then holds steady', async ({ page }) => {
    await page.evaluate(() => {
      window.helaengine!.store.getState().addObject({
        id: 'chimney',
        assetId: 'prop_crate_01',
        parentId: null,
        transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        physics: { body: 'static', collider: 'box' },
        emitter: { kind: 'smoke', continuous: true, offset: [0, 1, 0] },
      } as never);
    });

    await page.waitForTimeout(500);
    const early = await page.evaluate(() => window.helaengine!.particleCount());
    await page.waitForTimeout(2000);
    const later = await page.evaluate(() => window.helaengine!.particleCount());

    // Rising, because smoke is being emitted faster than it ages out until the plume reaches its
    // steady state. A count stuck at zero would mean the emitter was built and never ticked.
    expect(early).toBeGreaterThan(0);
    expect(later).toBeGreaterThan(early);

    const smoking = await twoFrames(page);
    expect(smoking.second.equals(smoking.first)).toBe(false);
  });

  test('the panel warns about an emitter nothing can trigger', async ({ page }) => {
    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      state.addObject({
        id: 'puff',
        assetId: 'prop_crate_01',
        parentId: null,
        transform: { position: [3, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        physics: { body: 'static', collider: 'box' },
        emitter: { kind: 'dust', continuous: false, burstEvent: '' },
      } as never);
      state.select(['puff']);
    });

    // It exists, costs a buffer, and can never emit. Nothing else about the document says so.
    await expect(page.getByRole('region', { name: 'Particles' })).toContainText(
      'no event triggers it',
    );
  });
});
