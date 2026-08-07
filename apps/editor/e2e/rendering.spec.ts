import { expect, test, type Page } from '@playwright/test';

/**
 * Lighting and image effects, in the editor's own viewport.
 *
 * The reason this is an end-to-end test and not a unit test: the editor draws through
 * react-three-fiber and an export draws through the engine's `Viewport`, and the failure worth
 * catching is **effects that appear in one and not the other**. Somebody authoring a look they
 * cannot see is worse than no effects at all, so what is asserted here is that turning an effect
 * on changes what the editor's canvas shows.
 *
 * Pixels rather than a flag, wherever a pixel can say it. A boolean proves a composer was
 * constructed; only the image proves it drew.
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
  await expect(page.locator('header.topbar')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => window.helaengine !== undefined);
}

/**
 * A settled frame of the viewport canvas.
 *
 * Captured when two consecutive screenshots match, rather than after a fixed number of animation
 * frames. Counting frames was flaky and deserved to be: a change has to reach React, then the
 * store subscriber, then the loop, and a composer allocates its render targets on the way — so
 * "two frames" is a guess that is usually right. Waiting for the image to stop changing is the
 * condition the test actually depends on.
 */
async function frame(page: Page): Promise<Buffer> {
  const canvas = page.locator('[data-testid="viewport-canvas"]');
  let previous = await canvas.screenshot();

  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(100);
    const current = await canvas.screenshot();
    if (current.equals(previous)) return current;
    previous = current;
  }

  // A scene that never settles is a scene with something animating in it, which none of these
  // have. Returning the last frame rather than failing here keeps the failure on the assertion
  // that cares, with its own message.
  return previous;
}

/**
 * Whether two screenshots are different images.
 *
 * A byte comparison of the encoded PNGs, not a pixel diff — so it answers "did anything change"
 * and says nothing about how much. That is the right question here: the failure being guarded
 * against is a setting that is stored and silently ignored, which produces an identical image.
 * Measuring the magnitude of a vignette would be measuring the vignette's parameters back.
 */
function differs(a: Buffer, b: Buffer): boolean {
  return !a.equals(b);
}

test.describe('rendering settings', () => {
  test('nothing is composed until an effect is actually switched on', async ({ page }) => {
    await openEditor(page);
    expect(await page.evaluate(() => window.helaengine!.postProcessingActive())).toBe(false);

    // Enabled, but with every effect off. The right answer is still no chain: nobody should pay
    // for a render target and two full-screen passes that change nothing. A test that read the
    // document instead of the viewport would call this a bug.
    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      state.setEnvironment({
        postProcessing: { ...state.scene.environment.postProcessing, enabled: true },
      });
    });
    await frame(page);
    expect(await page.evaluate(() => window.helaengine!.postProcessingActive())).toBe(false);

    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      const post = state.scene.environment.postProcessing;
      state.setEnvironment({
        postProcessing: {
          ...post,
          enabled: true,
          vignette: { ...post.vignette, enabled: true, strength: 0.9, offset: 0.1 },
        },
      });
    });
    await frame(page);
    expect(await page.evaluate(() => window.helaengine!.postProcessingActive())).toBe(true);
  });

  test('a vignette changes what the editor draws', async ({ page }) => {
    await openEditor(page);
    const before = await frame(page);

    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      const post = state.scene.environment.postProcessing;
      state.setEnvironment({
        postProcessing: {
          ...post,
          enabled: true,
          vignette: { ...post.vignette, enabled: true, strength: 0.9, offset: 0.1 },
        },
      });
    });
    const after = await frame(page);

    // The assertion that matters. Wiring the stack into the export alone would leave this passing
    // in the game and failing here — which is exactly the editor/export divergence the visual
    // regression suite exists to catch.
    expect(differs(before, after)).toBe(true);
  });

  test('a colour grade changes what the editor draws', async ({ page }) => {
    await openEditor(page);
    const before = await frame(page);

    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      const post = state.scene.environment.postProcessing;
      state.setEnvironment({
        postProcessing: {
          ...post,
          enabled: true,
          colorGrade: { ...post.colorGrade, enabled: true, saturation: -1 },
        },
      });
    });
    const after = await frame(page);
    expect(differs(before, after)).toBe(true);
  });

  test('turning shadows off changes the image', async ({ page }) => {
    await openEditor(page);
    const before = await frame(page);

    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      const lighting = state.scene.environment.lighting;
      state.setEnvironment({
        lighting: { ...lighting, shadows: { ...lighting.shadows, quality: 'off' } },
      });
    });
    const after = await frame(page);
    // Shadows are the single most expensive thing in this renderer, so "off" has to actually be
    // off rather than a setting that is stored and ignored. It *was* ignored until the environment
    // gained its own sync: the editor only rebuilt on object and terrain changes, so no lighting
    // edit had ever reached the viewport — while saving, reloading and exporting correctly.
    expect(differs(before, after)).toBe(true);
  });

  test('the panel edits the document', async ({ page }) => {
    await openEditor(page);

    await page.getByLabel('Shadow quality').selectOption('high');
    await page.getByLabel('Tone mapping').selectOption('aces');
    await page.getByRole('checkbox', { name: 'Sky and ground fill' }).check();

    const environment = await page.evaluate(
      () => window.helaengine!.store.getState().scene.environment,
    );
    expect(environment.lighting.shadows.quality).toBe('high');
    expect(environment.toneMapping).toBe('aces');
    expect(environment.lighting.hemisphere).not.toBeNull();
  });
});

/**
 * Per-object material overrides, through the real panel.
 *
 * The property that has to hold and is easiest to break: an override belongs to **one object**. A
 * model is loaded once and cloned per placement, so its materials are shared — recolouring one
 * crate by writing onto the material found on a clone repaints every crate in the level, and it
 * does so silently.
 */
test.describe('material overrides', () => {
  test('recolours one object and leaves its twin alone', async ({ page }) => {
    await openEditor(page);

    // Two objects from the same asset, so they share a source material.
    const ids = await page.evaluate(() => {
      const engine = window.helaengine!;
      const assetId = engine.store.getState().scene.objects[0]?.assetId ?? 'tree_pine_02';
      return [engine.addObject(assetId, [4, 0, 4]), engine.addObject(assetId, [-4, 0, -4])];
    });
    expect(ids).toHaveLength(2);

    await page.evaluate((id: string) => window.helaengine!.store.getState().select([id]), ids[0]!);

    const panel = page.getByRole('region', { name: 'Material' });
    await expect(panel).toBeVisible();
    await panel.getByLabel('Override colour').check();

    const colours = await page.evaluate((pair: string[]) => {
      const engine = window.helaengine!;
      return {
        first: engine.objectMaterialColors(pair[0]!),
        second: engine.objectMaterialColors(pair[1]!),
      };
    }, ids as string[]);

    // Default override colour is white. The second object must be untouched — that is the whole
    // assertion, and the one a shared-material bug fails.
    expect(colours.first.every((hex) => hex === 'ffffff')).toBe(true);
    expect(colours.second.some((hex) => hex !== 'ffffff')).toBe(true);
  });

  test('clearing the last row drops the override entirely', async ({ page }) => {
    await openEditor(page);
    const id = await page.evaluate(() => {
      const engine = window.helaengine!;
      const assetId = engine.store.getState().scene.objects[0]?.assetId ?? 'tree_pine_02';
      return engine.addObject(assetId, [0, 0, 6]);
    });
    await page.evaluate(
      (objectId: string) => window.helaengine!.store.getState().select([objectId]),
      id,
    );

    const panel = page.getByRole('region', { name: 'Material' });
    await panel.getByLabel('Override colour').check();
    expect(
      await page.evaluate(
        (objectId: string) =>
          window.helaengine!.store.getState().scene.objects.find((o) => o.id === objectId)
            ?.material,
        id,
      ),
    ).not.toBeNull();

    await panel.getByLabel('Override colour').uncheck();
    // Null rather than an empty object, so the object stops paying for a material clone the moment
    // the last row is cleared.
    expect(
      await page.evaluate(
        (objectId: string) =>
          window.helaengine!.store.getState().scene.objects.find((o) => o.id === objectId)
            ?.material,
        id,
      ),
    ).toBeNull();
  });
});
