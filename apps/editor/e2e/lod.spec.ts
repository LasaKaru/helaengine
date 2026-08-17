import { expect, test, type Page } from '@playwright/test';

/**
 * Level of detail, in a real browser.
 *
 * The decimator and the level tree are asserted in `packages/engine/src/render/lod.test.ts`. What
 * only a browser can show is the claim the feature is actually *for*: that the renderer submits
 * fewer triangles when the camera is far away. A level tree that was built perfectly and never
 * consulted — the wrong distances, a wrapper the renderer never walks, `update` never called —
 * would pass every unit test in the repository and save nothing at all.
 *
 * Measured against `renderer.info.render.triangles`, which is the GPU's own count of what was
 * submitted, not anything this codebase computes.
 */

/** A model with enough triangles for decimation to have something to remove. */
const HEAVY = 'siege_tower';

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
}

/**
 * Six of the heavy model in a row, none of them batched.
 *
 * Six rather than eight, and that is not arbitrary: at eight identical static objects the loader
 * batches them into an `InstancedMesh`, which draws one geometry many times and has no per-instance
 * level to swap. Instanced level of detail is a separate piece of work; staying under the threshold
 * is what keeps this test measuring the thing it claims to.
 */
async function placeRow(page: Page): Promise<void> {
  await page.evaluate((assetId) => {
    const state = window.helaengine!.store.getState();
    for (let index = 0; index < 6; index += 1) {
      state.addObject({
        id: `tower${index}`,
        assetId,
        parentId: null,
        transform: { position: [index * 14 - 35, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        physics: { body: 'static', collider: 'box' },
      } as never);
    }
  }, HEAVY);
  await page.waitForTimeout(1500);
}

const setMode = async (page: Page, mode: string): Promise<void> => {
  await page.evaluate((next) => {
    window.helaengine!.store.getState().setEnvironment({ lod: { mode: next as 'balanced' } });
  }, mode);
  // A mode change is a rebuild — the geometry is different, not a value on it — so this waits for
  // the whole scene rather than for a uniform write.
  await page.waitForTimeout(2500);
};

/** Puts the camera at a distance and reads what the renderer submitted from there. */
async function trianglesFrom(page: Page, distance: number): Promise<number> {
  await page.evaluate((away) => {
    window.helaengine!.setCameraPose([0, away * 0.3, away], [0, 4, 0]);
  }, distance);
  await page.waitForTimeout(700);
  return page.evaluate(() => window.helaengine!.renderStats()?.triangles ?? 0);
}

test.describe('level of detail', () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await placeRow(page);
  });

  test('distance costs fewer triangles, and only when it is switched on', async ({ page }) => {
    /**
     * Both comparisons are made from the *same* camera pose with the mode switched, rather than by
     * moving the camera with the mode fixed. That took a wrong test to arrive at: a row of towers
     * seventy metres long does not all fit on the screen from thirty metres away, so walking the
     * camera back changes the triangle count through frustum culling alone — which is exactly the
     * confound this test exists to rule out. Holding the pose and changing only the setting leaves
     * the level of detail as the only thing that can move the number.
     */
    // Twelve metres, not thirty. At thirty the *outer* towers of the row are already forty-seven
    // metres from the camera and past their first switching distance — so the control failed by a
    // hundred and twenty-eight triangles, which was the feature working rather than a bug. Close
    // enough that every tower in the row is inside its finest level's range.
    const closeOff = await trianglesFrom(page, 12);
    const farOff = await trianglesFrom(page, 220);

    /**
     * The terrain is a large mesh drawn identically either way, so it is a constant floor under
     * both numbers — and a big one. Measuring the whole frame would put a real 66% saving on the
     * towers behind a 32% saving overall, and the assertion would have to be loosened to a number
     * that no longer says anything. Subtracting an empty level's count isolates the objects.
     */
    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      state.removeObjects(state.scene.objects.map((object) => object.id));
    });
    await page.waitForTimeout(1500);
    const floor = await trianglesFrom(page, 220);
    await placeRow(page);

    await setMode(page, 'balanced');

    // The control. Up close every object is on its finest level, so the count is exactly what it
    // was with the feature off — a level tree that coarsened things in your face would be worse
    // than none, and a byte of difference here would say the distances are wrong.
    expect(await trianglesFrom(page, 12)).toBe(closeOff);

    const farOn = await trianglesFrom(page, 220);
    expect(farOn - floor).toBeLessThan((farOff - floor) * 0.5);
  });

  test('aggressive swaps closer than balanced', async ({ page }) => {
    await setMode(page, 'balanced');
    const balanced = await trianglesFrom(page, 60);

    await setMode(page, 'aggressive');
    const aggressive = await trianglesFrom(page, 60);

    // Same camera, same objects: the only difference is the distance at which each level takes
    // over. Identical counts would mean the profile was read once and then ignored.
    expect(aggressive).toBeLessThan(balanced);
  });

  test('an object told to stay at full detail does', async ({ page }) => {
    await setMode(page, 'balanced');
    await page.evaluate(() => window.helaengine!.store.getState().setLod('tower0', 'never'));
    await page.waitForTimeout(2500);

    await trianglesFrom(page, 220);
    const stats = await page.evaluate(() => ({
      excluded: window.helaengine!.lodStats('tower0'),
      included: window.helaengine!.lodStats('tower1'),
    }));

    // No levels built at all for the excluded one — not levels that happen to be showing the finest.
    expect(stats.excluded?.levels).toBe(0);
    expect(stats.included?.levels).toBeGreaterThan(0);
    expect(stats.included?.level).toBeGreaterThan(0);
  });

  test('the panel switches it on and the document records it', async ({ page }) => {
    await page.getByRole('combobox', { name: 'Level of detail' }).selectOption('aggressive');
    await page.waitForTimeout(2000);

    expect(
      await page.evaluate(() => window.helaengine!.store.getState().scene.environment.lod.mode),
    ).toBe('aggressive');
    expect(
      await page.evaluate(() => window.helaengine!.lodStats()?.trianglesSaved ?? 0),
    ).toBeGreaterThan(0);
  });
});
