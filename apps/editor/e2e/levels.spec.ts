import { expect, test, type Page } from '@playwright/test';

/**
 * Levels, driven through the panel.
 *
 * The store tests already prove the switching arithmetic. What only a browser can show is that the
 * viewport actually follows — that switching level loads a different world rather than relabelling
 * the same one — and that a `Load level` node has somewhere to point once a second level exists.
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
  await page.waitForFunction(() => window.helaengine !== undefined);
  await page.waitForTimeout(1200);
}

const objectCount = (page: Page): Promise<number> =>
  page.evaluate(() => window.helaengine!.store.getState().scene.objects.length);

test.describe('levels', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('starts as one level and says what a second one buys', async ({ page }) => {
    const panel = page.getByRole('region', { name: 'Levels' });
    await expect(panel).toContainText('One level');
    await expect(panel.getByRole('button', { name: /^Delete / })).toBeDisabled();
  });

  test('switching loads a different world, not a different label', async ({ page }) => {
    const populated = await objectCount(page);
    expect(populated).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Add level' }).click();
    await page.getByRole('button', { name: 'Edit Level 2' }).click();
    await page.waitForTimeout(800);

    // A fresh level is empty. If switching only relabelled, the forest's trees would still be here.
    expect(await objectCount(page)).toBe(0);

    await page.getByRole('button', { name: /^Edit Forest/ }).click();
    await page.waitForTimeout(800);
    expect(await objectCount(page)).toBe(populated);
  });

  test('an edit made in one level is still there after a round trip', async ({ page }) => {
    await page.getByRole('button', { name: 'Add level' }).click();
    await page.getByRole('button', { name: 'Edit Level 2' }).click();
    await page.waitForTimeout(600);

    await page.evaluate(() => {
      window.helaengine!.store.getState().addObject({
        id: 'marker',
        assetId: 'prop_crate_01',
        parentId: null,
        transform: { position: [3, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        behaviors: [],
        physics: { body: 'static', collider: 'auto' },
        animation: null,
        material: null,
        trigger: null,
        sway: 'auto',
        metadata: {},
      } as never);
    });
    expect(await objectCount(page)).toBe(1);

    await page.getByRole('button', { name: /^Edit Forest/ }).click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: 'Edit Level 2' }).click();
    await page.waitForTimeout(600);

    // Switching saves the live document before loading the other one. The opposite order loses
    // everything since the last switch, silently.
    const ids = await page.evaluate(() =>
      window.helaengine!.store.getState().scene.objects.map((object) => object.id),
    );
    expect(ids).toEqual(['marker']);
  });

  test('the graph can send the player to another level once one exists', async ({ page }) => {
    await page.getByRole('button', { name: 'Add level' }).click();

    await page.getByRole('button', { name: 'Graph' }).click();
    await page.getByRole('button', { name: 'Load level', exact: true }).click();

    // The picker offers the other level and not this one: a door back to where you already are is
    // never what was meant, and offering it makes the commonest mistake the easiest click.
    const picker = page.getByRole('combobox', { name: 'Level' });
    await expect(picker).toBeVisible();
    const options = await picker.locator('option').allTextContents();
    expect(options).toContain('Level 2');
    expect(options).not.toContain('Forest clearing');

    await picker.selectOption({ label: 'Level 2' });
    const node = await page.evaluate(
      () => window.helaengine!.store.getState().scene.graph.nodes[0],
    );
    expect(node).toMatchObject({ type: 'loadLevel', carryState: true });
  });

  test('a door to a deleted level is reported', async ({ page }) => {
    await page.getByRole('button', { name: 'Add level' }).click();
    await page.getByRole('button', { name: 'Graph' }).click();
    await page.getByRole('button', { name: 'Load level', exact: true }).click();
    await page.getByRole('combobox', { name: 'Level' }).selectOption({ label: 'Level 2' });

    // The id, not the display name: levels are numbered from what the set already holds, so the
    // second *level* is `level_1`. Guessing it is how this assertion was wrong the first time.
    const target = await page.evaluate(() => {
      const node = window.helaengine!.store.getState().scene.graph.nodes[0];
      return node && node.type === 'loadLevel' ? node.levelId : '';
    });
    expect(target).toBeTruthy();

    await page.getByRole('button', { name: 'Close' }).click();

    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Delete Level 2' }).click();
    await page.waitForTimeout(600);

    /**
     * The check a folder of separate scene files could not make.
     *
     * "This door leads to `level_2`, and there is no `level_2`" can only be answered by something
     * holding the whole set — which is why levels live in one document.
     */
    await expect(page.getByRole('status', { name: 'Level problems' })).toContainText(target);
  });

  test('the start level can be moved, and the panel says which it is', async ({ page }) => {
    await page.getByRole('button', { name: 'Add level' }).click();

    const panel = page.getByRole('region', { name: 'Levels' });
    await expect(panel).toContainText('starts here');

    await page.getByRole('button', { name: 'Make Level 2 the start level' }).click();
    await expect(page.getByRole('button', { name: 'Make Level 2 the start level' })).toBeDisabled();

    const project = await page.evaluate(() => window.helaengine!.store.getState().scene.sceneId);
    // The forest is no longer the start, so the id the panel marks is not the one being edited.
    await expect(panel.getByRole('button', { name: 'Edit Level 2' })).toContainText('starts here');
    expect(project).toBeTruthy();
  });
});

/**
 * Levels through persistence.
 *
 * The store and container tests prove the shapes round-trip. This proves the editor actually uses
 * them: that closing a project and reopening it brings every level back, which is the failure a
 * user would describe as "my second level is gone".
 */
test.describe('levels survive a reopen', () => {
  test.setTimeout(120_000);

  test('a second level is still there after going home and back', async ({ page }) => {
    await openEditor(page);

    await page.getByRole('button', { name: 'Add level' }).click();
    await page.getByRole('button', { name: 'Edit Level 2' }).click();
    await page.waitForTimeout(600);

    await page.evaluate(() => {
      window.helaengine!.store.getState().addObject({
        id: 'marker',
        assetId: 'prop_crate_01',
        parentId: null,
        transform: { position: [3, 0, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
        behaviors: [],
        physics: { body: 'static', collider: 'auto' },
        animation: null,
        material: null,
        trigger: null,
        sway: 'auto',
        metadata: {},
      } as never);
    });

    // Autosave runs on a debounce; going home saves as well, but waiting makes the intent explicit.
    await page.waitForTimeout(2500);
    await page.getByRole('button', { name: 'Projects' }).click();
    await page.waitForTimeout(1200);

    // Back into the same project from the projects list.
    await page.locator('.project-open').first().click();
    await page.waitForTimeout(2000);

    const rows = await page
      .getByRole('region', { name: 'Levels' })
      .getByRole('button', { name: /^Edit / })
      .allTextContents();
    expect(rows.length).toBe(2);

    await page.getByRole('button', { name: 'Edit Level 2' }).click();
    await page.waitForTimeout(800);
    const ids = await page.evaluate(() =>
      window.helaengine!.store.getState().scene.objects.map((object) => object.id),
    );
    expect(ids).toEqual(['marker']);
  });
});
