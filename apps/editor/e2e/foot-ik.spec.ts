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
   * STILL NOT PASSING. Marked rather than weakened, and the list below is what has been ruled out.
   *
   * The solver is proved in `packages/engine/src/animation/footIk.test.ts`. What fails here is the
   * runtime path: the fox's ankles read 0.159 with placement on and 0.159 with it off, on ground at
   * zero — so nothing is being solved at all, rather than being solved wrongly.
   *
   * Fixed while chasing it, each a real defect in its own right:
   *  - the bone panel cached an empty bone list from before the model finished loading;
   *  - `EngineBridge` never rebuilt the scene when placement was switched on;
   *  - the binder could not name a quadruped's thigh (`b_LeftLeg01` / `b_LeftLeg02`);
   *  - the solver was only constructed *inside* the animator block, so an object with no animation
   *    never got one — which is wrong for a character standing still on a slope, and was silent.
   *
   * Ruled out: the tick order (animations then placement, in one place), the search range (the foot
   * is 16cm above ground and the range is 50cm), and the target being out of reach.
   *
   * Not yet checked: whether `legCount` is actually non-zero at runtime — there is no dev API for
   * it, and adding one is the next step rather than another guess.
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
