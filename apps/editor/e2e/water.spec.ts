import { expect, test, type Page } from '@playwright/test';

/**
 * Water, in the editor's own viewport.
 *
 * The unit tests measure the geometry the shader depends on — the depth baked into each vertex, the
 * plane lying flat, the material not writing depth. None of that can tell you whether the surface
 * was ever drawn. This codebase has shipped a setting that saved, exported and round-tripped
 * perfectly while doing nothing at all on screen, and a water plane built into a scene that never
 * renders it would look exactly like success from every other angle.
 *
 * So the claims here are made against pixels, and the control is not decoration: an empty field
 * with no water is a still image, frame after frame. Water is the only thing in it that moves.
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
  await expect(page.locator('header.topbar')).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => window.helaengine !== undefined);
  // Looking out across the field rather than down at it, so the surface fills a useful part of the
  // frame and a fresnel tint at a glancing angle has somewhere to show.
  await page.evaluate(() => window.helaengine!.setCameraPose([0, 6, 30], [0, 0, -40]));
  await page.waitForTimeout(1200);
}

const canvasOf = (page: Page) => page.locator('[data-testid="viewport-canvas"]');

/** One frame, now. No settling: half of what is being tested here is that the image does not settle. */
async function shot(page: Page): Promise<Buffer> {
  return canvasOf(page).screenshot();
}

/** Two frames a moment apart, for asking whether anything is moving. */
async function pair(page: Page): Promise<[Buffer, Buffer]> {
  const first = await shot(page);
  await page.waitForTimeout(400);
  return [first, await shot(page)];
}

/**
 * Sets the water through the schema's own defaults rather than by hand.
 *
 * `setEnvironment` merges a patch into the document without re-parsing it, so a hand-written object
 * missing `waveScale` reaches the shader as `undefined` — and one undefined divisor turns every
 * vertex of the plane into NaN and makes the whole surface disappear, silently. That is a test
 * writing a document no editor can produce, and the fix is for the test to stop doing it.
 */
async function setWater(
  page: Page,
  water: { kind: 'pond' | 'lake' | 'sea'; height: number } | null,
): Promise<void> {
  await page.evaluate((next) => {
    const store = window.helaengine!.store.getState();
    if (!next) {
      store.setEnvironment({ water: null });
      return;
    }
    const preset = window.helaengine!.defaultWater(next.kind) as Record<string, unknown>;
    store.setEnvironment({ water: { ...preset, height: next.height } as never });
  }, water);
  await page.waitForTimeout(1000);
}

test.describe('water', () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('a surface appears, moves, and leaves nothing behind when it is turned off', async ({
    page,
  }) => {
    /**
     * The whole feature in one pass, because the three halves only mean anything together.
     *
     * The control comes first and is the strongest of the three: with no water the field is
     * completely still, so two frames four hundred milliseconds apart are byte-identical. That is
     * what makes "the frames now differ" evidence of waves rather than of a flickering sky or a
     * dithered gradient.
     */
    expect(await page.evaluate(() => window.helaengine!.waterActive())).toBe(false);
    const [dryA, dryB] = await pair(page);
    expect(dryA.equals(dryB)).toBe(true);

    // The field is flat at zero, so a surface a metre up covers it. `waterProblems` calls that
    // drowning the level and it is the right thing to say — here it is simply the cheapest scene in
    // which a plane is unambiguously on screen.
    await setWater(page, { kind: 'lake', height: 1 });
    expect(await page.evaluate(() => window.helaengine!.waterActive())).toBe(true);

    const wet = await shot(page);
    expect(wet.equals(dryA)).toBe(false);

    // Moving, not merely present. A surface drawn once and never updated would pass the assertion
    // above and be a still blue rectangle.
    const [waveA, waveB] = await pair(page);
    expect(waveA.equals(waveB)).toBe(false);

    /**
     * And off again, back to the exact image. Not "close to it" — the same bytes.
     *
     * This is the assertion that catches a plane left in the scene at zero opacity, a shader still
     * being composed, a render target still allocated. Every one of those is invisible to a test
     * that only checks the water appeared.
     */
    await setWater(page, null);
    expect(await page.evaluate(() => window.helaengine!.waterActive())).toBe(false);
    const [afterA, afterB] = await pair(page);
    expect(afterA.equals(afterB)).toBe(true);
    expect(afterA.equals(dryA)).toBe(true);
  });

  test('the kind changes the image', async ({ page }) => {
    // A pond and a sea share one code path and differ only in their constants, which is exactly the
    // arrangement where a preset can be stored, round-tripped and never reach a uniform.
    await setWater(page, { kind: 'pond', height: 1 });
    const pond = await shot(page);

    await setWater(page, { kind: 'sea', height: 1 });
    const sea = await shot(page);

    expect(pond.equals(sea)).toBe(false);
  });

  test('the terrain decides where the water shows', async ({ page }) => {
    /**
     * The claim the whole design rests on: the shoreline is a consequence of the ground rather than
     * a second shape to keep in step with it. Sculpting under an unchanged water setting has to
     * change the image.
     *
     * Sculpted *up* rather than down, because raising ground through the surface is the case with a
     * visible answer — the plane is discarded wherever the depth has gone negative, so a hill
     * pushing through leaves a hole in it.
     */
    await setWater(page, { kind: 'pond', height: 1 });
    const before = await shot(page);

    await page.evaluate(() => window.helaengine!.raiseTerrain(0, -20, 18, 1));
    await page.waitForTimeout(1200);

    const after = await shot(page);
    expect(after.equals(before)).toBe(false);
  });

  test('water below every piece of ground is reported rather than drawn', async ({ page }) => {
    /**
     * The author's most likely mistake, and the one that reads as a broken feature: a surface under
     * the whole level builds a plane, compiles a shader, and shows nothing. The panel has to say so.
     */
    /**
     * A hill first, so there is a range for the water to sit inside.
     *
     * The empty field is perfectly flat, and on flat ground *every* height is wrong: at or below it
     * the water is under all the ground, above it the level is drowned. Without relief the control
     * below could not exist — which is itself the reason the warning is worth having.
     */
    await page.evaluate(() => window.helaengine!.raiseTerrain(0, -20, 20, 1));
    await page.waitForTimeout(1000);

    // Through the panel rather than the store, because the warning is the panel's job and a
    // document written past it would prove nothing about what an author sees.
    await page.getByRole('checkbox', { name: 'Water', exact: true }).check();
    await page.getByLabel('Surface height').fill('-40');
    await page.getByLabel('Surface height').press('Enter');

    await expect(page.getByRole('status', { name: 'Water problems' })).toContainText(
      'under all of it',
    );

    // The control: back at a height the ground actually reaches, the warning goes. A panel that
    // warns about everything is a panel nobody reads.
    await page.getByLabel('Surface height').fill('0.5');
    await page.getByLabel('Surface height').press('Enter');
    await expect(page.getByRole('status', { name: 'Water problems' })).toHaveCount(0);
  });
});
