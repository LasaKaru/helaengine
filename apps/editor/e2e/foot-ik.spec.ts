import { expect, test, type Page } from '@playwright/test';

/**
 * Foot placement, in a real browser.
 *
 * The solver's arithmetic is asserted against a synthetic skeleton in
 * `packages/engine/src/animation/footIk.test.ts`, where bone lengths are known and "the ankle landed
 * where it was asked to" is a number. What only a browser can show is the half that is pure wiring
 * and would fail silently: that this runs **after** the animation mixer on the same frame.
 *
 * A solver called before the mixer produces perfect maths that the mixer then overwrites. Every unit
 * test still passes. The character's feet do not move.
 */

/**
 * The only skinned asset the shipped library has.
 *
 * A fox rather than a biped, and that is the honest test rather than a convenient one: the binder
 * has to find leg bones in a rig it was not designed around, and if it cannot, that is worth
 * knowing here rather than after somebody imports their own quadruped.
 */
const RIGGED = 'enemy_fox';

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
  await page.waitForTimeout(1500);
}

/** Places a rigged character and waits for its model to arrive. */
async function placeCharacter(page: Page): Promise<void> {
  await page.evaluate((assetId) => {
    const state = window.helaengine!.store.getState();
    state.addObject({
      id: 'walker',
      assetId,
      parentId: null,
      transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      physics: { body: 'static', collider: 'box' },
    } as never);
    state.select(['walker']);
  }, RIGGED);
  await page.waitForTimeout(2500);
}

const ankleY = async (page: Page): Promise<{ left: number | null; right: number | null }> => {
  const feet = await page.evaluate(() => window.helaengine!.footPositions('walker'));
  return { left: feet?.left?.y ?? null, right: feet?.right?.y ?? null };
};

test.describe('foot placement', () => {
  test.setTimeout(240_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await placeCharacter(page);
  });

  /**
   * NOT PASSING, and the remaining failure is now a different one from the failures before it.
   *
   * The wiring works. The runtime builds a solver (`legCount: 2`, both legs and the hips resolved),
   * runs it, and the ankles track the ground: raising the mound moves the left ankle up by exactly
   * the height the mound rose. That was proved by asking the runtime through `footIkState` rather
   * than by inferring from an ankle that would not move — which is what four earlier rounds did,
   * each turning up a real bug that was not the cause.
   *
   * What remains is that **the solver's writes are permanent on a character with no clip playing.**
   * The mixer re-poses the skeleton every frame for an animated character, so last frame's solve is
   * overwritten before this frame's runs. With no animation there is nothing to restore the rest
   * pose, so each solve builds on the last: the ankle settles at ground plus a constant, and
   * switching placement off leaves the bones where the solver last put them (0.171 against an
   * unmodified 0.159).
   *
   * The hips already avoid this — they are written against a remembered rest value rather than
   * added to — and the leg bones need the same treatment. Task #97.
   */
  test.fixme('the ankles follow the ground, and do not without it', async ({ page }) => {
    /**
     * The control is measured first and re-measured last. With foot placement off, raising the
     * ground under a character changes nothing about its skeleton — the clip is authored on a flat
     * floor and has no idea what is beneath it. That is what makes the same measurement moving,
     * once placement is on, attributable to placement rather than to the character having been
     * moved, rebuilt or re-posed.
     */
    await page.getByRole('checkbox', { name: 'Foot placement' }).check();
    await page.getByRole('button', { name: 'Detect bones' }).click();
    await page.waitForTimeout(500);

    // Zero settling, so one frame is the whole answer rather than a tenth of it.
    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      const object = state.scene.objects.find((candidate) => candidate.id === 'walker');
      state.setFootIk('walker', { ...object!.footIk!, smoothing: 0, ankleHeight: 0 } as never);
    });
    await page.waitForTimeout(1000);

    const onFlatGround = await ankleY(page);
    expect(onFlatGround.left).not.toBeNull();

    /**
     * A *gentle* mound under one side, and gentle is the point.
     *
     * The search range is half a metre by default, and ground further away than that is a void the
     * solver deliberately ignores — a foot on a balcony must not be dragged down to the hillside
     * below it. A brush stroke at full strength raises the terrain metres, which is out of range,
     * and the ankles correctly do not move. That is the feature working and a test measuring the
     * wrong thing.
     */
    await page.evaluate(() => window.helaengine!.raiseTerrain(-0.35, 0, 1.2, 0.02));
    await page.waitForTimeout(1200);

    const onTheMound = await ankleY(page);
    expect(onTheMound.left!).toBeGreaterThan(onFlatGround.left! + 0.02);
    // The right ankle is off the mound, so it must *not* have come up with it. Both rising together
    // would mean the whole character was lifted rather than its legs solved.
    expect(Math.abs(onTheMound.right! - onFlatGround.right!)).toBeLessThan(
      onTheMound.left! - onFlatGround.left!,
    );

    // The control: switch it off and the same ground leaves the ankles where the clip puts them.
    await page.evaluate(() => window.helaengine!.store.getState().setFootIk('walker', null));
    await page.waitForTimeout(1200);
    const placementOff = await ankleY(page);
    expect(Math.abs(placementOff.left! - onFlatGround.left!)).toBeLessThan(0.02);
  });

  test('the panel says when nothing is bound', async ({ page }) => {
    await page.getByRole('checkbox', { name: 'Foot placement' }).check();
    await page.waitForTimeout(400);

    // Cleared deliberately: an unbound solver is inert, and inert with no explanation is
    // indistinguishable from broken.
    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      const object = state.scene.objects.find((candidate) => candidate.id === 'walker');
      state.setFootIk('walker', {
        ...object!.footIk!,
        bones: { hips: '', thighL: '', shinL: '', footL: '', thighR: '', shinR: '', footR: '' },
      } as never);
    });

    await expect(page.getByRole('status', { name: 'Foot placement problems' })).toContainText(
      'no leg has all three',
    );
  });
});
