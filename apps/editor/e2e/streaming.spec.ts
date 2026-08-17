import { expect, test, type Page } from '@playwright/test';

/**
 * World chunks and the draw distance, in a real browser.
 *
 * The partition is arithmetic and is asserted as arithmetic in
 * `packages/engine/src/streaming/chunks.test.ts`. What only a browser can show is that the grid is
 * actually consulted during a render: a partition built perfectly and never asked would pass every
 * unit test in the repository while the frame cost exactly what it always did.
 *
 * Measured against `renderer.info.render.triangles` — the renderer's own count of what it submitted.
 */

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
 * A line of towers running away from the camera, all of them inside the frustum.
 *
 * Running *away* rather than across, and that is the whole design of this test. Objects spread
 * sideways leave the screen as the camera approaches, so a triangle count that fell would be
 * frustum culling taking the credit. A line down the view axis stays on screen from the near end to
 * the far, so the only thing that can remove it is the draw distance.
 *
 * Six, staying under the batching threshold of eight: batched objects are drawn by an
 * `InstancedMesh` rather than by their own node, so hiding the node changes nothing.
 */
async function placeLine(page: Page): Promise<void> {
  await page.evaluate((assetId) => {
    const state = window.helaengine!.store.getState();
    for (let index = 0; index < 6; index += 1) {
      state.addObject({
        id: `tower${index}`,
        assetId,
        parentId: null,
        transform: { position: [0, 0, -index * 45], rotation: [0, 0, 0], scale: [1, 1, 1] },
        physics: { body: 'static', collider: 'box' },
      } as never);
    }
  }, HEAVY);
  await page.waitForTimeout(1500);
}

const setDistance = async (page: Page, distance: number, size = 32): Promise<void> => {
  await page.evaluate(
    ([far, chunk]) => {
      window.helaengine!.store.getState().setEnvironment({
        streaming: { distance: far as number, size: chunk as number, occlusion: false },
      });
    },
    [distance, size] as const,
  );
  await page.waitForTimeout(1200);
};

/** Looks down the line from the origin and reads what the renderer submitted. */
async function triangles(page: Page): Promise<number> {
  await page.evaluate(() => window.helaengine!.setCameraPose([0, 12, 40], [0, 4, -120]));
  await page.waitForTimeout(800);
  return page.evaluate(() => window.helaengine!.renderStats()?.triangles ?? 0);
}

test.describe('world chunks', () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await placeLine(page);
  });

  test('a draw distance removes the far end, and off removes nothing', async ({ page }) => {
    /**
     * The control is the last assertion rather than the first, and it is the one that matters:
     * putting the distance back to zero has to restore the *exact* triangle count. Without it, "the
     * count went down" would also be satisfied by a bug that hid objects and never showed them
     * again — which is a draw distance that works once and then eats the level.
     */
    const everything = await triangles(page);
    expect(await page.evaluate(() => window.helaengine!.streamingStats())).toBeNull();

    await setDistance(page, 90);
    const near = await triangles(page);
    expect(near).toBeLessThan(everything);

    const stats = await page.evaluate(() => window.helaengine!.streamingStats());
    expect(stats?.objects).toBe(6);
    expect(stats?.liveChunks).toBeGreaterThan(0);
    expect(stats?.liveChunks).toBeLessThan(stats!.chunks);

    await setDistance(page, 0);
    expect(await triangles(page)).toBe(everything);
  });

  test('a longer distance draws more', async ({ page }) => {
    await setDistance(page, 90);
    const short = await triangles(page);

    await setDistance(page, 400);
    const long = await triangles(page);

    // Same camera, same objects: the only difference is the number. A count that did not move would
    // mean the distance was read once when the grid was built and then ignored.
    expect(long).toBeGreaterThan(short);
  });

  test('nothing is culled while any part of it is still in range', async ({ page }) => {
    /**
     * The conservative half. A chunk's centre can be outside the distance while the near corner of
     * the chunk — and the object standing in it — is well inside, so culling on the centre alone is
     * a building that vanishes as you walk towards it. Asserted here as: the nearest tower is still
     * drawn at a distance that barely reaches it.
     */
    await setDistance(page, 20, 16);
    const stats = await page.evaluate(() => window.helaengine!.streamingStats());
    expect(stats?.liveChunks).toBeGreaterThan(0);

    const withNearest = await triangles(page);
    await setDistance(page, 0);
    const withAll = await triangles(page);
    expect(withNearest).toBeGreaterThan(0);
    expect(withNearest).toBeLessThan(withAll);
  });

  test('a hill hides what is behind it, and flat ground hides nothing', async ({ page }) => {
    /**
     * The control is the whole test. Terrain occlusion on a flat field has to change *nothing* —
     * identical camera, identical objects, identical setting, byte-for-byte the same triangle
     * count — because there is nothing to hide behind. Only then does the same setting removing
     * triangles once a ridge is raised mean the ridge is what did it.
     */
    await page.evaluate(() => {
      window
        .helaengine!.store.getState()
        .setEnvironment({ streaming: { distance: 0, size: 32, occlusion: true } });
    });
    await page.waitForTimeout(1500);

    const overFlatGround = await triangles(page);
    const flatStats = await page.evaluate(() => window.helaengine!.streamingStats());
    expect(flatStats?.occludedChunks).toBe(0);

    /**
     * A hill between the camera and the far towers.
     *
     * Raised with the same sculpt call the editor's brush makes, rather than by dragging across the
     * canvas: a brush stroke is a test of the brush, and what is under test here is whether the
     * renderer stops submitting triangles for what the ground is in front of.
     */
    await page.evaluate(() => {
      const api = window.helaengine!;
      for (const along of [-60, -70, -80]) {
        for (const across of [-40, -20, 0, 20, 40]) {
          api.raiseTerrain(across, along, 30, 0.9);
        }
      }
    });
    await page.waitForTimeout(2500);

    const behindTheHill = await triangles(page);
    const hillStats = await page.evaluate(() => window.helaengine!.streamingStats());

    expect(hillStats?.occludedChunks).toBeGreaterThan(0);
    expect(behindTheHill).toBeLessThan(overFlatGround);
  });

  test('the panel sets it and warns about vanishing in clear air', async ({ page }) => {
    // A text input rather than a spinbutton: `NumberField` is a scrubbable field, so it takes
    // `inputMode="decimal"` and keeps `type="text"` — a number input would fight the drag.
    await page.getByLabel('Draw distance').fill('50');
    await page.getByLabel('Draw distance').press('Enter');
    await page.waitForTimeout(1000);

    expect(
      await page.evaluate(
        () => window.helaengine!.store.getState().scene.environment.streaming.distance,
      ),
    ).toBe(50);
    // The empty field has no fog, so objects reach the distance and stop existing rather than
    // fading out of it. Nothing else in the document says so.
    await expect(page.getByRole('status', { name: 'Draw distance problems' })).toContainText(
      'no fog',
    );
  });
});
