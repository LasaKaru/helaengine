import { expect, test, type Page } from '@playwright/test';

/**
 * Breaking things, in a running world.
 *
 * The system's own tests prove the arithmetic against a fake world. What only a browser can show is
 * that the *document* reaches it: that a crate marked breakable is registered by the runtime, that
 * the `damage` event weapons already emit is the one that breaks it, and that fragments become real
 * objects in the scene rather than a number in a report.
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
  await page.waitForTimeout(1000);
}

/** A crate on the ground, breakable or not — the control case is the same scene without the flag. */
async function placeCrate(page: Page, breakable: Record<string, unknown> | null): Promise<void> {
  await page.evaluate((destructible) => {
    window.helaengine!.store.getState().addObject({
      id: 'crate',
      assetId: 'prop_crate_01',
      parentId: null,
      transform: { position: [2, 0, 2], rotation: [0, 0, 0], scale: [1, 1, 1] },
      behaviors: [],
      physics: { body: 'static', collider: 'box' },
      animation: null,
      sway: 'none',
      material: null,
      trigger: null,
      destructible,
      metadata: {},
    } as never);
  }, breakable);
  await page.waitForTimeout(300);
}

async function play(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Walk', exact: true }).click();
  await page.waitForFunction(() => window.helaengine!.playerPosition() !== null, undefined, {
    timeout: 20_000,
  });

  const start = page.locator('.hela-panel button', { hasText: 'Play' });
  if ((await start.count()) > 0) {
    await expect
      .poll(
        async () => {
          if ((await start.count()) === 0) return 'gone';
          await start
            .first()
            .click({ force: true })
            .catch(() => undefined);
          return page.evaluate(() => window.helaengine!.uiScreen());
        },
        { timeout: 20_000 },
      )
      .not.toBe('home');
  }

  await page.waitForTimeout(600);
}

/**
 * Damages the crate through the bus.
 *
 * The same `damage` event a weapon emits, raised directly rather than by aiming and firing — which
 * would be testing the spread cone and the crosshair rather than whether breaking works.
 */
async function hit(page: Page, amount: number): Promise<void> {
  await page.evaluate((value) => {
    window.helaengine!.emit('damage', { targetId: 'crate', amount: value });
  }, amount);
  await page.waitForTimeout(400);
}

const crateExists = (page: Page): Promise<boolean> =>
  page.evaluate(() => window.helaengine!.viewportObjectIds().includes('crate'));

test.describe('destructibles', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('a breakable crate goes, and an ordinary one does not', async ({ page }) => {
    // The control case. Without it, "the crate is gone" is a claim about the damage event reaching
    // *something*, and would pass just as well against a runtime that destroyed every target.
    await placeCrate(page, null);
    await play(page);
    await hit(page, 500);
    expect(await crateExists(page)).toBe(true);

    await openEditor(page);
    await placeCrate(page, { hitPoints: 20, damagedBy: ['weapons'] });
    await play(page);
    await hit(page, 500);
    expect(await crateExists(page)).toBe(false);
  });

  test('survives a hit that is not enough', async ({ page }) => {
    await placeCrate(page, { hitPoints: 100, damagedBy: ['weapons'] });
    await play(page);

    await hit(page, 40);
    expect(await crateExists(page)).toBe(true);

    await hit(page, 40);
    expect(await crateExists(page)).toBe(true);

    await hit(page, 40);
    expect(await crateExists(page)).toBe(false);
  });

  test('leaves fragments in the scene, and clears them again', async ({ page }) => {
    await placeCrate(page, {
      hitPoints: 10,
      damagedBy: ['weapons'],
      effect: 'fragments',
      debrisAssetId: 'prop_crate_01',
      fragmentCount: 4,
      fragmentLifetime: 2,
    });
    await play(page);

    const before = (await page.evaluate(() => window.helaengine!.viewportObjectIds())).length;
    await hit(page, 50);

    const afterBreak = await page.evaluate(() => window.helaengine!.viewportObjectIds());
    // Real nodes in the scene graph, not a count in a report. The crate went and four pieces
    // arrived, so the total is up by three.
    expect(afterBreak).not.toContain('crate');
    expect(afterBreak.length).toBe(before + 3);

    await page.waitForTimeout(3000);
    const afterExpiry = (await page.evaluate(() => window.helaengine!.viewportObjectIds())).length;
    // A level where a hundred crates are broken would otherwise be left simulating four hundred
    // pieces nobody can see.
    expect(afterExpiry).toBeLessThan(afterBreak.length);
  });

  test('swaps one model for another in the same place', async ({ page }) => {
    await placeCrate(page, {
      hitPoints: 10,
      damagedBy: ['weapons'],
      effect: 'swap',
      debrisAssetId: 'prop_barrel_01',
    });
    await play(page);
    await hit(page, 50);

    const replacement = await page.evaluate(() =>
      window.helaengine!.viewportObjects().find((object) => object.assetId === 'prop_barrel_01'),
    );
    expect(replacement).toBeTruthy();

    const at = await page.evaluate(
      (id) => window.helaengine!.viewportObjectPosition(id),
      replacement!.id,
    );
    // Where the crate was, not at the origin — the position is read before the object is removed.
    expect(Math.hypot(at!.x - 2, at!.z - 2)).toBeLessThan(1.5);
  });

  test('raises the author’s break event', async ({ page }) => {
    await placeCrate(page, {
      hitPoints: 10,
      damagedBy: ['weapons'],
      breakEvent: 'crateOpened',
    });
    await play(page);

    expect(await page.evaluate(() => window.helaengine!.recordEvents('crateOpened'))).toBe(true);

    await hit(page, 50);

    // This is the whole of how a destructible talks to the rest of the game: a graph `On event`
    // node listening for this name is what makes a crate open a door.
    const heard = await page.evaluate(() => window.helaengine!.recordedEvents('crateOpened'));
    expect(heard).toHaveLength(1);
    expect(heard![0]).toMatchObject({ objectId: 'crate' });
  });

  test('the panel says when an effect has nothing to show for it', async ({ page }) => {
    await placeCrate(page, { hitPoints: 10, effect: 'fragments', debrisAssetId: '' });
    await page.evaluate(() => window.helaengine!.store.getState().select(['crate']));

    // A `fragments` with no debris looks completely configured and does nothing at all.
    await expect(page.getByRole('region', { name: 'Breakable' })).toContainText('no asset chosen');
  });
});
