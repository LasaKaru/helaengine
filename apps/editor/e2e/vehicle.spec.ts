import { expect, test, type Page } from '@playwright/test';

/**
 * Driving, in a real browser.
 *
 * The controller's own tests step a solver and prove the car drives, brakes, steers and holds a top
 * speed. What only a browser can show is that the *document* reaches it: that an object marked as a
 * vehicle gets a controller built for it by the same `buildScenePhysics` an export calls, and that
 * the interact key puts the player in and out of it.
 *
 * ## What is deliberately not asserted here
 *
 * That the car covers ground *in Play Preview*. It does so against the solver — `vehicle.test.ts`
 * drives one 45 metres — but inside the editor the chassis settles onto its belly with no wheel in
 * contact, and the cause was not found within a proportionate amount of digging. Ruled out along the
 * way: the drive layout and engine force do reach the solver (the force is read back as 6000N), the
 * vehicle is stepped every frame whether or not anybody is driving (110 steps before the player even
 * gets in), the suspension force cap is no longer the limit, a heightfield behaves the same as a box
 * floor, and the spawn height makes no difference. Asserting a weaker version of the claim here — "it
 * moved a little" — would be a test that passes on a car being shoved by contacts, which is the
 * failure mode this file exists to catch. It is written up as a known gap instead.
 *
 * No car or wheel models ship with the engine, so a crate stands in for both. That is a statement
 * about the asset library rather than about the feature.
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

/** A crate-shaped car parked next to the spawn, driveable or not. */
async function placeCar(page: Page, driveable: boolean): Promise<void> {
  await page.evaluate((asVehicle) => {
    const state = window.helaengine!.store.getState();

    state.addObject({
      id: 'car',
      assetId: 'prop_crate_01',
      parentId: null,
      // Parked at the height the suspension settles to. Lower and the wheel rays start underground
      // and find nothing — full engine force, no traction, and it looks like the throttle is dead.
      transform: { position: [2, 2, 0], rotation: [0, 0, 0], scale: [2, 1, 4] },
      // Dynamic, because the chassis is the only body a ray-cast vehicle has.
      physics: { body: 'dynamic', collider: 'box', mass: 900 },
      vehicle: asVehicle
        ? {
            wheelAssetId: 'prop_crate_01',
            enginePower: 6000,
            maxSpeed: 20,
            enterRadius: 8,
            wheels: { radius: 0.4, axleOffset: 1.4, trackHalfWidth: 0.9, hubHeight: -0.3 },
          }
        : null,
    } as never);

    state.setPlayer({ spawn: [0, 0, 0] });
  }, driveable);
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

  await page.waitForTimeout(1200);
}

const carPosition = (page: Page): Promise<{ x: number; y: number; z: number } | null> =>
  page.evaluate(() => window.helaengine!.viewportObjectPosition('car'));

test.describe('vehicles', () => {
  test.setTimeout(180_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('the player gets in and out again', async ({ page }) => {
    await placeCar(page, true);
    await play(page);

    expect(await page.evaluate(() => window.helaengine!.drivingVehicleId())).toBeNull();

    await page.keyboard.press('e');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.helaengine!.drivingVehicleId())).toBe('car');

    const before = await carPosition(page);
    // The throttle reaches the solver: the driven wheels are pushing, which is the half of driving
    // the browser can honestly confirm. Whether the car then covers ground is asserted against the
    // solver in `vehicle.test.ts`, for the reason given at the top of this file.
    await page.keyboard.down('w');
    await page.waitForTimeout(600);
    const state = await page.evaluate(() => window.helaengine!.vehicleState('car'));
    await page.keyboard.up('w');
    expect(state!.engineForce).toBeGreaterThan(0);
    void before;

    await page.keyboard.press('e');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.helaengine!.drivingVehicleId())).toBeNull();
  });

  test('an ordinary object cannot be got into', async ({ page }) => {
    // The control case. Without it, "the car moved" is a claim about a dynamic box being shoved
    // around, and "E did something" is a claim about the interact key existing.
    await placeCar(page, false);
    await play(page);

    await page.keyboard.press('e');
    await page.waitForTimeout(300);

    expect(await page.evaluate(() => window.helaengine!.drivingVehicleId())).toBeNull();
  });

  test('the throttle reaches no vehicle while the player is on foot', async ({ page }) => {
    await placeCar(page, true);
    await play(page);

    await page.keyboard.down('w');
    await page.waitForTimeout(600);
    const state = await page.evaluate(() => window.helaengine!.vehicleState('car'));
    await page.keyboard.up('w');

    // On foot the same key walks the character. Engine force on an unoccupied car would mean the
    // throttle was being fed to every vehicle in the level rather than to the one being driven.
    expect(state!.engineForce).toBe(0);
  });

  test('the panel warns about a chassis that cannot move', async ({ page }) => {
    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      state.addObject({
        id: 'car',
        assetId: 'prop_crate_01',
        parentId: null,
        transform: { position: [2, 0, 0], rotation: [0, 0, 0], scale: [2, 1, 4] },
        physics: { body: 'static', collider: 'box' },
        vehicle: { wheelAssetId: 'prop_crate_01' },
      } as never);
      state.select(['car']);
    });

    // A static chassis is a car-shaped wall, and everything else about the document says it drives.
    await expect(page.getByRole('region', { name: 'Vehicle' })).toContainText('Dynamic');
  });
});
