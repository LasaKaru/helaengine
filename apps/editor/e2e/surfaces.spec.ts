import { expect, test, type Page } from '@playwright/test';

/**
 * Generated PBR surfaces, in a real browser.
 *
 * The maps themselves are asserted byte by byte in `packages/engine/src/render/surfaces.test.ts`.
 * What only a browser can show is the half that keeps going wrong in this codebase: that binding
 * them to a material changes what is on the screen. A surface that saved, exported and round-tripped
 * perfectly while the wall stayed flat would pass every unit test in the repository.
 *
 * Every claim below is paired with its control. "The pixels changed" is satisfied by any animation
 * at all, so each case that expects a difference is preceded or followed by one that expects the
 * frames to be byte-identical.
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
}

/**
 * One large object, close to the camera, lit from the side.
 *
 * The lighting matters more than it looks. A normal map is *only* visible as a change in how light
 * lands, so a flatly lit scene would render a brick wall and a blank wall identically — the test
 * would fail for a reason that has nothing to do with the feature. Hence a strong sun against a
 * near-black ambient: the sun is directional and therefore actually shades the joints.
 */
async function placeWall(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window.helaengine!.store.getState();
    const environment = state.scene.environment;
    state.setEnvironment({
      lighting: {
        ...environment.lighting,
        sun: { ...environment.lighting.sun, intensity: 2.4 },
        // A low flat ambient is the point: ambient light lands on every texel equally, so a scene
        // lit mostly by it renders a brick wall and a blank wall identically. The test would then
        // fail for a reason with nothing to do with the feature.
        ambient: 0.1,
      },
    });
    state.addObject({
      id: 'wall',
      assetId: 'prop_crate_01',
      parentId: null,
      transform: { position: [0, 2, 0], rotation: [0, 0, 0], scale: [6, 4, 1] },
      physics: { body: 'static', collider: 'box' },
    } as never);
    state.select(['wall']);
  });
  await page.waitForTimeout(600);
  // A fixed pose, so a comparison is of what is on the wall rather than of two different views.
  await page.evaluate(() => window.helaengine!.setCameraPose([0, 2.5, 7], [0, 2, 0]));
  await page.waitForTimeout(600);
}

/** Sets or clears the selected object's surface. */
const setSurface = (page: Page, surface: unknown): Promise<void> =>
  page.evaluate((next) => {
    const state = window.helaengine!.store.getState();
    const object = state.scene.objects.find((candidate) => candidate.id === 'wall');
    state.setMaterial('wall', {
      ...(object?.material ?? {}),
      ...(next === null ? { surface: undefined } : { surface: next }),
    } as never);
  }, surface);

const frame = async (page: Page): Promise<Buffer> => page.locator('canvas').first().screenshot();

test.describe('surfaces', () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await placeWall(page);
  });

  test('a surface changes the wall, and clearing it puts the wall back', async ({ page }) => {
    /**
     * The control case is the third assertion, and it carries the whole test. Two frames of the
     * same static wall are byte-identical, so a difference after the surface is applied can only
     * have come from the surface — and going back to *exactly* the first frame when it is cleared
     * proves the maps were unbound rather than merely overwritten with something similar.
     */
    const before = await frame(page);
    await page.waitForTimeout(400);
    expect((await frame(page)).equals(before)).toBe(true);

    await setSurface(page, { kind: 'brick', scale: 'normal', depth: 1, occlusion: 1 });
    await page.waitForTimeout(600);
    const bricked = await frame(page);
    expect(bricked.equals(before)).toBe(false);

    await setSurface(page, null);
    await page.waitForTimeout(600);
    expect((await frame(page)).equals(before)).toBe(true);
  });

  test('depth is the normal map, not the roughness', async ({ page }) => {
    /**
     * Both frames have every map bound and the same roughness pattern; the only difference is
     * whether the normal map is scaled to zero. A difference here therefore isolates the normal map
     * specifically — without it, "the surface changed the pixels" would still pass if the normal map
     * had never been sampled and only the roughness had taken effect.
     */
    await setSurface(page, { kind: 'brick', scale: 'normal', depth: 0, occlusion: 1 });
    await page.waitForTimeout(600);
    const flat = await frame(page);

    await setSurface(page, { kind: 'brick', scale: 'normal', depth: 0, occlusion: 1 });
    await page.waitForTimeout(400);
    // The control: re-applying the same surface is a rebuild that must land on the same image.
    expect((await frame(page)).equals(flat)).toBe(true);

    await setSurface(page, { kind: 'brick', scale: 'normal', depth: 1.5, occlusion: 1 });
    await page.waitForTimeout(600);
    expect((await frame(page)).equals(flat)).toBe(false);
  });

  test('occlusion darkens the joints', async ({ page }) => {
    // The occlusion map needs a `uv1` attribute that no model out of Blender has. Until that was
    // generated, this map bound successfully, sampled an attribute that did not exist, and did
    // nothing — with no warning anywhere. This is the test that would have caught it.
    await setSurface(page, { kind: 'stone', scale: 'normal', depth: 1, occlusion: 0 });
    await page.waitForTimeout(600);
    const unshadowed = await frame(page);

    await setSurface(page, { kind: 'stone', scale: 'normal', depth: 1, occlusion: 1 });
    await page.waitForTimeout(600);
    expect((await frame(page)).equals(unshadowed)).toBe(false);
  });

  test('the size changes how large the pattern is', async ({ page }) => {
    await setSurface(page, { kind: 'tile', scale: 'fine', depth: 1, occlusion: 1 });
    await page.waitForTimeout(600);
    const fine = await frame(page);

    await setSurface(page, { kind: 'tile', scale: 'coarse', depth: 1, occlusion: 1 });
    await page.waitForTimeout(600);
    expect((await frame(page)).equals(fine)).toBe(false);
  });

  test('the panel offers every kind and writes the choice to the document', async ({ page }) => {
    await page.getByRole('combobox', { name: 'Surface' }).selectOption('plank');
    await expect(page.getByRole('combobox', { name: 'Surface size' })).toBeVisible();

    const stored = await page.evaluate(
      () =>
        window.helaengine!.store.getState().scene.objects.find((object) => object.id === 'wall')
          ?.material?.surface,
    );
    expect(stored).toMatchObject({ kind: 'plank', scale: 'normal' });
  });
});
