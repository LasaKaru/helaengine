import { expect, test, type Page } from '@playwright/test';

/**
 * Opens a fresh project in the editor.
 *
 * The app starts on the projects screen, so anything testing the editor has to get there first.
 * The database is cleared each time so no test inherits another's projects.
 */
async function openEditor(page: Page, template = /Empty field/): Promise<void> {
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
  await page.getByRole('button', { name: template }).click();
  await expect(page.getByRole('banner')).toBeVisible();
  await page.waitForFunction(() => window.helaengine !== undefined);
}

/**
 * Sprint 3 smoke test — it asserts the one thing this sprint claims: that a change to the store
 * puts a real asset in the viewport, through the shared engine, with no editor-side placement code.
 *
 * It drives the app through the dev API rather than the UI because the UI for placing objects does
 * not exist until Sprint 4. When it does, this test switches to clicking, and the assertion below
 * stays exactly the same.
 */
test.describe('editor shell', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('renders the shell with a live canvas', async ({ page }) => {
    await expect(page.locator('canvas')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Assets' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Inspector' })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Viewport stats' })).toContainText('0 objects');
  });

  test('loads the manifest produced by the ingest pipeline', async ({ page }) => {
    const assetIds = await page.evaluate(() => window.helaengine!.assetIds());
    expect(assetIds).toContain('tree_pine_01');
    expect(assetIds.length).toBeGreaterThanOrEqual(10);
  });

  test('adding an object to the store puts a real model in the scene', async ({ page }) => {
    await page.evaluate(() => window.helaengine!.addObject('building_hut_01', [0, 0, 0]));

    await expect(page.getByRole('status', { name: 'Viewport stats' })).toContainText('1 objects');
    await expect(page.getByRole('region', { name: 'Scene' })).toContainText('building_hut_01');

    // The real assertion: the object reached the Three.js scene graph, not just React state.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds()))
      .toEqual(['obj_0001']);
  });

  test('renders loaded GLB models rather than placeholder boxes', async ({ page }) => {
    // Regression test. The bridge preloads models and builds the scene in two steps, so an object
    // added before its GLB arrives is drawn as a placeholder. If the rebuild after preload does not
    // fire, the editor silently shows grey boxes forever while claiming everything loaded.
    await page.evaluate(() => window.helaengine!.addObject('building_hut_01'));

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjects()))
      .toEqual([{ id: 'obj_0001', assetId: 'building_hut_01', isModel: true }]);
  });

  test('removing an object takes it back out of the viewport', async ({ page }) => {
    await page.evaluate(() => window.helaengine!.addObject('rock_boulder_01'));
    await expect(page.getByRole('status', { name: 'Viewport stats' })).toContainText('1 objects');

    await page.evaluate(() => window.helaengine!.clear());

    await expect(page.getByRole('status', { name: 'Viewport stats' })).toContainText('0 objects');
    await expect(page.getByRole('region', { name: 'Scene' })).toContainText('This scene is empty');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds()))
      .toEqual([]);
  });

  test('reports no console errors during a normal session', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.evaluate(() => window.helaengine!.addObject('tree_pine_01', [3, 0, 2]));
    await expect(page.getByRole('status', { name: 'Viewport stats' })).toContainText('1 objects');

    expect(errors).toEqual([]);
  });
});

/**
 * Drag-to-place is the one flow in this sprint that unit tests genuinely cannot reach: it needs a
 * real pointer, a real camera and a real raycast against real terrain.
 */
test.describe('drag to place', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await expect(page.getByRole('region', { name: 'Assets' })).toBeVisible();
  });

  async function dragAssetTo(
    page: Page,
    assetId: string,
    target: { x: number; y: number },
  ): Promise<void> {
    const card = page.locator(`[data-asset-id="${assetId}"]`);
    await card.scrollIntoViewIfNeeded();
    const box = (await card.boundingBox())!;

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Two moves: the first enters the viewport, the second settles on the target so the ghost has
    // a frame to follow the pointer before release.
    await page.mouse.move(target.x, target.y, { steps: 8 });
    await page.mouse.move(target.x, target.y);
    await page.mouse.up();
  }

  test('dropping an asset on the terrain adds it to the scene', async ({ page }) => {
    const canvas = page.locator('canvas');
    const canvasBox = (await canvas.boundingBox())!;
    // The terrain has to exist before a drop can raycast against it.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0) !== null))
      .toBe(true);

    await dragAssetTo(page, 'building_hut_01', {
      x: canvasBox.x + canvasBox.width / 2,
      y: canvasBox.y + canvasBox.height * 0.62,
    });

    await expect(page.getByRole('status', { name: 'Viewport stats' })).toContainText('1 objects');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjects()))
      .toEqual([{ id: 'obj_0001', assetId: 'building_hut_01', isModel: true }]);

    // Placed where it was dropped, and resting on the ground rather than floating.
    const placed = await page.evaluate(
      () => window.helaengine!.store.getState().scene.objects[0]!.transform,
    );
    expect(placed.position[1]).toBeCloseTo(0, 3);
    expect(Math.abs(placed.position[0]) + Math.abs(placed.position[2])).toBeGreaterThan(0);
  });

  test('dropping on the sky places nothing', async ({ page }) => {
    const canvasBox = (await page.locator('canvas').boundingBox())!;

    // Near the top of the viewport the camera is looking above the horizon, so the ray misses.
    await dragAssetTo(page, 'rock_boulder_01', {
      x: canvasBox.x + canvasBox.width / 2,
      y: canvasBox.y + 8,
    });

    await expect(page.getByRole('status', { name: 'Viewport stats' })).toContainText('0 objects');
  });

  test('snap to grid rounds the dropped position to whole metres', async ({ page }) => {
    await page.getByLabel('Snap to grid').check();
    const canvasBox = (await page.locator('canvas').boundingBox())!;

    await dragAssetTo(page, 'prop_crate_01', {
      x: canvasBox.x + canvasBox.width * 0.42,
      y: canvasBox.y + canvasBox.height * 0.68,
    });

    const [x, , z] = await page.evaluate(
      () => window.helaengine!.store.getState().scene.objects[0]!.transform.position,
    );
    expect(x % 1).toBe(0);
    expect(z % 1).toBe(0);
  });

  test('search narrows the library', async ({ page }) => {
    await page.getByLabel('Search assets').fill('goblin');
    // Ten ingested assets plus the two built-in trigger volumes.
    await expect(page.getByText(/1 of 12/)).toBeVisible();
    await expect(page.locator('[data-asset-id="enemy_goblin_01"]')).toBeVisible();
  });
});

/**
 * Selection and transforms. These need a real raycast against real geometry and a real gizmo, so
 * they live here rather than in the component tests.
 */
test.describe('selection and transforms', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await page.evaluate(() => {
      window.helaengine!.addObject('building_hut_01', [0, 0, 0]);
      // Off the camera-to-origin line, so it never occludes the hut when clicking.
      window.helaengine!.addObject('tree_pine_01', [-9, 0, 7]);
    });
    // Waiting for the models, not just the object count: a click aimed at a hut that is still a
    // placeholder box can miss, which made this flake under parallel load.
    await expect
      .poll(async () =>
        page.evaluate(() => window.helaengine!.viewportObjects().every((item) => item.isModel)),
      )
      .toBe(true);
  });

  test('clicking an object selects it and fills the inspector', async ({ page }) => {
    // Projected rather than guessed: the object's own screen position is the only reliable target.
    // Polled because the projection needs both a built scene and a mounted camera, and a rebuild
    // can briefly leave one of them unset.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.projectObject('obj_0001') !== null))
      .toBe(true);

    const point = (await page.evaluate(() => window.helaengine!.projectObject('obj_0001')))!;
    await page.mouse.click(point.x, point.y);

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.store.getState().selectedIds))
      .toEqual(['obj_0001']);
    await expect(page.getByRole('region', { name: 'Inspector' })).toContainText('building_hut_01');
    await expect(page.getByLabel('Position X')).toBeVisible();
  });

  test('clicking empty space clears the selection', async ({ page }) => {
    await page.evaluate(() => window.helaengine!.store.getState().select(['obj_0001']));
    const canvasBox = (await page.locator('canvas').boundingBox())!;

    // High in the viewport is sky: unambiguously nothing, unlike a ground corner that a tree can
    // drift into as soon as a template or camera angle changes.
    await page.mouse.click(canvasBox.x + canvasBox.width * 0.5, canvasBox.y + 10);

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.store.getState().selectedIds))
      .toEqual([]);
  });

  test('shift-clicking in the scene list extends the selection', async ({ page }) => {
    await page.getByRole('treeitem').first().click();
    await page
      .getByRole('treeitem')
      .nth(1)
      .click({ modifiers: ['Shift'] });

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.store.getState().selectedIds))
      .toEqual(['obj_0001', 'obj_0002']);
    await expect(page.getByRole('region', { name: 'Inspector' })).toContainText(
      '2 objects selected',
    );
  });

  test('editing a numeric field moves the object in the viewport', async ({ page }) => {
    await page.getByRole('treeitem').first().click();

    const field = page.getByLabel('Position X');
    await field.fill('12.5');
    await field.press('Enter');

    await expect
      .poll(async () =>
        page.evaluate(
          () => window.helaengine!.store.getState().scene.objects[0]!.transform.position[0],
        ),
      )
      .toBe(12.5);

    // The node itself moved, not just the document — this is the incremental sync path.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectWorldX('obj_0001')))
      .toBeCloseTo(12.5, 3);
  });

  test('W / E / R switch the transform mode', async ({ page }) => {
    await page.getByRole('treeitem').first().click();

    await page.keyboard.press('e');
    await expect(page.getByRole('button', { name: 'rotate' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.keyboard.press('r');
    await expect(page.getByRole('button', { name: 'scale' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('Ctrl+D duplicates and Delete removes', async ({ page }) => {
    await page.getByRole('treeitem').first().click();

    await page.keyboard.press('Control+d');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(3);

    await page.keyboard.press('Delete');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(2);
  });

  test('the shortcuts modal opens with ? and closes with Escape', async ({ page }) => {
    await page.keyboard.press('?');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeHidden();
  });

  test('the gizmo appears for a selection and survives a transform edit', async ({ page }) => {
    await page.getByRole('treeitem').first().click();

    // A gizmo attached to a node that gets rebuilt on every edit would vanish here. It must not.
    await expect.poll(async () => page.evaluate(() => window.helaengine!.hasGizmo())).toBe(true);

    const field = page.getByLabel('Position Z');
    await field.fill('4');
    await field.press('Enter');

    await expect.poll(async () => page.evaluate(() => window.helaengine!.hasGizmo())).toBe(true);
  });
});

/** Undo/redo and the scene tree — the flows that make experimenting in the editor safe. */
test.describe('history and the scene tree', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await page.evaluate(() => {
      window.helaengine!.addObject('building_hut_01', [0, 0, 0]);
      window.helaengine!.addObject('prop_barrel_01', [4, 0, 2]);
    });
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(2);
  });

  test('Ctrl+Z undoes and Ctrl+Shift+Z redoes', async ({ page }) => {
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(1);

    await page.keyboard.press('Control+Shift+z');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(2);
  });

  test('undo restores a deleted object into the viewport', async ({ page }) => {
    await page.getByRole('treeitem').first().click();
    await page.keyboard.press('Delete');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(1);

    await page.keyboard.press('Control+z');

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(2);
  });

  test('the toolbar buttons track what is undoable', async ({ page }) => {
    const undoButton = page.getByRole('button', { name: 'Undo' });
    const redoButton = page.getByRole('button', { name: 'Redo' });

    await expect(undoButton).toBeEnabled();
    await expect(redoButton).toBeDisabled();

    await undoButton.click();
    await expect(redoButton).toBeEnabled();
  });

  test('dragging a row onto another nests it and preserves world position', async ({ page }) => {
    const worldBefore = await page.evaluate(() =>
      window.helaengine!.viewportObjectWorldX('obj_0002'),
    );

    // The grip is what is draggable; the row itself stays clickable so rename still works.
    const source = page.getByRole('treeitem').nth(1).locator('.tree-grip');
    const target = page.getByRole('treeitem').first();
    await source.dragTo(target);

    // Nested in the document...
    await expect
      .poll(async () =>
        page.evaluate(() => window.helaengine!.store.getState().scene.objects[1]!.parentId),
      )
      .toBe('obj_0001');
    // ...and still exactly where it was on screen.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectWorldX('obj_0002')))
      .toBeCloseTo(worldBefore!, 3);
  });

  test('a nested row is indented under its parent', async ({ page }) => {
    await page.evaluate(() =>
      window.helaengine!.store.getState().setParent('obj_0002', 'obj_0001'),
    );

    await expect(page.getByRole('treeitem').nth(1)).toHaveAttribute('aria-level', '2');
  });

  test('deleting a parent takes its children with it, and undo brings both back', async ({
    page,
  }) => {
    await page.evaluate(() =>
      window.helaengine!.store.getState().setParent('obj_0002', 'obj_0001'),
    );
    await page.getByRole('treeitem').first().click();
    await page.keyboard.press('Delete');

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(0);

    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(2);
  });

  test('double-clicking a row renames it', async ({ page }) => {
    await page.getByRole('treeitem').first().locator('.object-label').dblclick();

    const input = page.getByLabel('Rename obj_0001');
    await input.fill('Village hut');
    await input.press('Enter');

    await expect(page.getByRole('treeitem').first()).toContainText('Village hut');
  });
});

/** Terrain sculpting and painting: a real pointer stroke against a real raycast. */
test.describe('terrain', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await expect(page.getByRole('region', { name: 'Terrain' })).toBeVisible();
  });

  async function strokeCanvas(page: Page, fx: number, fy: number, samples = 6): Promise<void> {
    const box = (await page.locator('canvas').boundingBox())!;
    const x = box.x + box.width * fx;
    const y = box.y + box.height * fy;

    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 0; step < samples; step += 1) {
      await page.mouse.move(x + step * 3, y + step * 2);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
  }

  test('a sculpt stroke raises the ground and records one undo step', async ({ page }) => {
    await page.getByRole('button', { name: 'Sculpt' }).click();
    await page.getByLabel('Brush radius').fill('16');
    await page.getByLabel('Brush radius').press('Enter');

    expect(await page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0))).toBe(0);

    await strokeCanvas(page, 0.5, 0.6);

    // The live field rose...
    expect(await page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0))).toBeGreaterThan(0);
    // ...the document recorded it...
    expect(await page.evaluate(() => window.helaengine!.store.getState().scene.terrain.type)).toBe(
      'heightmap',
    );
    // ...and the whole drag is a single undo step, not one per frame.
    expect(await page.evaluate(() => window.helaengine!.store.getState().history.past.length)).toBe(
      1,
    );
  });

  test('undo flattens the ground again', async ({ page }) => {
    await page.getByRole('button', { name: 'Sculpt' }).click();
    await strokeCanvas(page, 0.5, 0.6);
    expect(await page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0))).toBeGreaterThan(0);

    await page.keyboard.press('Control+z');

    // The document moving must drag the live terrain back with it.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0)))
      .toBe(0);
  });

  test('painting writes a splatmap without touching the heights', async ({ page }) => {
    await page.getByRole('button', { name: 'Paint' }).click();
    await page
      .getByRole('group', { name: 'Paint layer' })
      .getByRole('button', { name: 'Rock', exact: true })
      .click();

    await strokeCanvas(page, 0.5, 0.6);

    const terrain = await page.evaluate(() => window.helaengine!.store.getState().scene.terrain);
    expect(terrain.splatmap).not.toBeNull();
    expect(await page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0))).toBe(0);
  });

  test('1 / 2 / 3 switch tools', async ({ page }) => {
    await page.keyboard.press('2');
    await expect(page.getByRole('button', { name: 'Sculpt' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.keyboard.press('3');
    await expect(page.getByRole('button', { name: 'Paint' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await page.keyboard.press('1');
    await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('sculpted terrain survives a reload of the document', async ({ page }) => {
    await page.getByRole('button', { name: 'Sculpt' }).click();
    await strokeCanvas(page, 0.5, 0.6);

    const saved = await page.evaluate(() =>
      JSON.stringify(window.helaengine!.store.getState().scene),
    );
    const height = await page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0));

    // Round-trip the document exactly as a save/load would.
    await page.evaluate((json) => {
      window.helaengine!.store.getState().setScene(JSON.parse(json));
    }, saved);

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0)))
      .toBeCloseTo(height!, 2);
  });
});

/**
 * Projects and persistence. The claim this sprint makes is that work survives closing the tab,
 * which nothing short of a real reload against real IndexedDB actually tests.
 */
test.describe('projects and local save', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Each test starts from an empty database, so ordering between them cannot matter.
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
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
  });

  test('opens on the projects screen with the template picker', async ({ page }) => {
    await expect(page.getByRole('button', { name: /Empty field/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Forest clearing/ })).toBeVisible();
    await expect(page.getByText('Nothing saved yet')).toBeVisible();
  });

  test('a template opens a populated scene in the editor', async ({ page }) => {
    await page.getByRole('button', { name: /Village outpost/ }).click();

    await expect(page.getByRole('banner')).toBeVisible();
    await expect(page.getByLabel('Project name')).toHaveValue('Village Outpost');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBeGreaterThan(10);
    // The template ships sculpted ground, not a flat plane.
    expect(await page.evaluate(() => window.helaengine!.terrainHeightAt(30, -30))).toBeGreaterThan(
      0,
    );
  });

  test('edits survive a full page reload', async ({ page }) => {
    await page.getByRole('button', { name: /Empty field/ }).click();
    await expect(page.getByRole('banner')).toBeVisible();

    await page.evaluate(() => {
      window.helaengine!.store.getState().setName('Persisted Scene');
      window.helaengine!.addObject('building_hut_01', [2, 0, 3]);
    });
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status', { name: 'Save state' })).toHaveText('Saved');

    await page.reload();
    await page.waitForFunction(() => window.helaengine !== undefined);

    // Back on the projects screen, the saved project is listed...
    await expect(page.getByRole('button', { name: /Persisted Scene/ })).toBeVisible();
    await page.getByRole('button', { name: /Persisted Scene/ }).click();

    // ...and reopening it restores the document and the viewport.
    await expect(page.getByLabel('Project name')).toHaveValue('Persisted Scene');
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds()))
      .toEqual(['obj_0001']);
  });

  test('a sculpted terrain survives a reload', async ({ page }) => {
    await page.getByRole('button', { name: /Empty field/ }).click();
    await expect(page.getByRole('banner')).toBeVisible();

    await page.getByRole('button', { name: 'Sculpt' }).click();
    const box = (await page.locator('canvas').boundingBox())!;
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6);
    await page.mouse.down();
    for (let step = 0; step < 6; step += 1) {
      await page.mouse.move(box.x + box.width * 0.5 + step * 3, box.y + box.height * 0.6);
      await page.waitForTimeout(40);
    }
    await page.mouse.up();

    const height = await page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0));
    expect(height).toBeGreaterThan(0);

    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: 'Save state' })).toHaveText('Saved');
    await page.reload();
    await page.waitForFunction(() => window.helaengine !== undefined);
    await page
      .getByRole('button', { name: /Untitled scene/ })
      .first()
      .click();

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.terrainHeightAt(0, 0)))
      .toBeCloseTo(height!, 2);
  });

  test('the projects list shows a thumbnail after saving', async ({ page }) => {
    await page.getByRole('button', { name: /Forest clearing/ }).click();
    await expect(page.getByRole('banner')).toBeVisible();
    await page.waitForTimeout(1500);

    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status', { name: 'Save state' })).toHaveText('Saved');

    await page.getByRole('button', { name: 'Projects' }).click();

    const thumbnail = page.locator('.project-card img').first();
    await expect(thumbnail).toBeVisible();
    expect(await thumbnail.getAttribute('src')).toMatch(/^data:image\/jpeg/);
  });

  test('duplicating a project leaves the original alone', async ({ page }) => {
    await page.getByRole('button', { name: /Empty field/ }).click();
    await page.getByRole('button', { name: 'Projects' }).click();

    await page.getByRole('button', { name: 'Duplicate' }).first().click();

    await expect(page.getByRole('button', { name: /Untitled scene copy/ })).toBeVisible();
    await expect(page.locator('.project-card')).toHaveCount(2);
  });

  test('leaving the editor saves first, so nothing is lost', async ({ page }) => {
    await page.getByRole('button', { name: /Empty field/ }).click();
    // Creating from a template is async — editing before it lands would be edits to the outgoing
    // document, which the template then replaces.
    await expect(page.getByRole('banner')).toBeVisible();
    await page.evaluate(() => window.helaengine!.addObject('rock_boulder_01'));

    // No explicit save — clicking away is enough. The projects screen only appears once the
    // save has resolved, so its arrival is the signal that the write landed.
    await page.getByRole('button', { name: 'Projects' }).click();
    await expect(page.getByRole('heading', { name: 'Your projects' })).toBeVisible();
    await page.reload();
    await page.waitForFunction(() => window.helaengine !== undefined);
    await page
      .getByRole('button', { name: /Untitled scene/ })
      .first()
      .click();

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectIds().length))
      .toBe(1);
  });
});

/**
 * Behaviours. The claim this sprint makes is that a behaviour attached in the editor runs the
 * same code an export will run, driven entirely by document data.
 */
test.describe('behaviours', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await page.evaluate(() => {
      window.helaengine!.addObject('enemy_goblin_01', [0, 0, 0]);
      window.helaengine!.store.getState().select(['obj_0001']);
    });
    await expect(page.getByRole('region', { name: 'Behaviours' })).toBeVisible();
  });

  test('the inspector builds a form from the behaviour schema alone', async ({ page }) => {
    await page.getByLabel('Add behaviour').selectOption('patrol');

    // Every one of these controls comes from PatrolParamsSchema — none is hand-written per type.
    const panel = page.getByRole('region', { name: 'Behaviours' });
    await expect(panel.getByRole('button', { name: 'Add in viewport' })).toBeVisible();
    await expect(panel.getByLabel('Speed')).toHaveValue('2');
    await expect(panel.getByLabel('Mode', { exact: true })).toHaveValue('loop');
    await expect(panel.getByLabel('Face direction')).toBeChecked();
    await expect(panel.getByLabel('Wait seconds')).toHaveValue('0');
  });

  test('editing a field writes through to the document', async ({ page }) => {
    await page.getByLabel('Add behaviour').selectOption('patrol');

    const panel = page.getByRole('region', { name: 'Behaviours' });
    await panel.getByLabel('Speed').fill('7');
    await panel.getByLabel('Speed').press('Enter');
    await panel.getByLabel('Mode', { exact: true }).selectOption('pingPong');

    const params = await page.evaluate(
      () => window.helaengine!.store.getState().scene.objects[0]!.behaviors[0]!.params,
    );
    expect(params).toMatchObject({ speed: 7, mode: 'pingPong' });
  });

  test('clicking the ground adds waypoints', async ({ page }) => {
    await page.getByLabel('Add behaviour').selectOption('patrol');
    await page.getByRole('button', { name: 'Add in viewport' }).click();

    const box = (await page.locator('canvas').boundingBox())!;
    for (const [fx, fy] of [
      [0.35, 0.7],
      [0.6, 0.75],
    ] as const) {
      await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(120);
    }
    await page.getByRole('button', { name: 'Done' }).click();

    const waypoints = await page.evaluate(
      () =>
        window.helaengine!.store.getState().scene.objects[0]!.behaviors[0]!.params[
          'waypoints'
        ] as number[][],
    );
    expect(waypoints).toHaveLength(2);
    // Points land on the ground, not at an arbitrary height.
    expect(Math.abs(waypoints[0]![1]!)).toBeLessThan(0.5);
  });

  test('play moves the object and stop puts it back', async ({ page }) => {
    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      state.addBehavior('obj_0001', 'patrol', {
        waypoints: [
          [0, 0, 0],
          [20, 0, 0],
        ],
        speed: 6,
        mode: 'loop',
        faceDirection: true,
        waitSeconds: 0,
      });
    });

    await page.getByRole('button', { name: 'Play' }).click();
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectWorldX('obj_0001')))
      .toBeGreaterThan(1);

    await page.getByRole('button', { name: 'Stop' }).click();

    // Back where the document says it is — a preview must never become an edit.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.viewportObjectWorldX('obj_0001')))
      .toBeCloseTo(0, 2);
    expect(
      await page.evaluate(
        () => window.helaengine!.store.getState().scene.objects[0]!.transform.position,
      ),
    ).toEqual([0, 0, 0]);
  });

  test('a behaviour survives a save and reload', async ({ page }) => {
    await page.getByLabel('Add behaviour').selectOption('patrol');
    const panel = page.getByRole('region', { name: 'Behaviours' });
    await panel.getByLabel('Speed').fill('4.5');
    await panel.getByLabel('Speed').press('Enter');

    await page.keyboard.press('Control+s');
    await expect(page.getByRole('status', { name: 'Save state' })).toHaveText('Saved');

    await page.reload();
    await page.waitForFunction(() => window.helaengine !== undefined);
    await page
      .getByRole('button', { name: /Untitled scene/ })
      .first()
      .click();
    await expect(page.getByRole('banner')).toBeVisible();

    expect(
      await page.evaluate(() => window.helaengine!.store.getState().scene.objects[0]!.behaviors[0]),
    ).toMatchObject({ type: 'patrol', params: { speed: 4.5 } });
  });

  test('removing a behaviour takes it off the object', async ({ page }) => {
    await page.getByLabel('Add behaviour').selectOption('patrol');
    await page.getByRole('button', { name: 'Remove Patrol' }).click();

    expect(
      await page.evaluate(
        () => window.helaengine!.store.getState().scene.objects[0]!.behaviors.length,
      ),
    ).toBe(0);
  });

  test('P toggles play mode', async ({ page }) => {
    await page.keyboard.press('p');
    await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
    await page.keyboard.press('p');
    await expect(page.getByRole('button', { name: 'Play' })).toBeVisible();
  });
});

/**
 * Sprint 10 — Play Preview.
 *
 * Every assertion here is about the simulation rather than the DOM: where the character ends up,
 * what stopped it, and whether the document survived being walked through. Those are the claims
 * the sprint makes, and none of them can be checked by looking at the page.
 */
test.describe('play preview', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page, /Forest clearing/);
    await page.waitForTimeout(1200);
  });

  async function enterWalk(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Walk' }).click();
    await page.waitForFunction(() => window.helaengine!.playerPosition() !== null, undefined, {
      timeout: 20_000,
    });
    await page.waitForTimeout(600);
  }

  test('the player lands on the sculpted ground instead of falling through it', async ({
    page,
  }) => {
    await enterWalk(page);

    const player = await page.evaluate(() => window.helaengine!.playerPosition()!);
    const ground = await page.evaluate(
      ([x, z]) => window.helaengine!.terrainHeightAt(x as number, z as number),
      [player.x, player.z],
    );

    expect(await page.evaluate(() => window.helaengine!.playerGrounded())).toBe(true);
    expect(Math.abs(player.y - ground!)).toBeLessThan(0.2);
  });

  test('W walks the character across the world', async ({ page }) => {
    await enterWalk(page);
    await page.evaluate(() => window.helaengine!.setPlayerYaw(0));

    const before = await page.evaluate(() => window.helaengine!.playerPosition()!);
    await page.keyboard.down('w');
    await page.waitForTimeout(1200);
    await page.keyboard.up('w');
    const after = await page.evaluate(() => window.helaengine!.playerPosition()!);

    // Yaw 0 faces -Z; a second of the default 6 m/s covers several metres.
    expect(after.z).toBeLessThan(before.z - 2);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
  });

  test('a building stops the player rather than letting them walk through it', async ({ page }) => {
    // The hut's measured footprint is 7.2m, so its near face sits 3.6m out from its origin.
    await page.evaluate(() => {
      window.helaengine!.addObject('building_hut_01', [0, 0, -10]);
      window.helaengine!.store.getState().setPlayer({ spawn: [0, 0, 0] });
    });
    await page.waitForTimeout(1200);

    await enterWalk(page);
    await page.evaluate(() => window.helaengine!.setPlayerYaw(0));

    await page.keyboard.down('w');
    await page.waitForTimeout(2500);
    await page.keyboard.up('w');

    const player = await page.evaluate(() => window.helaengine!.playerPosition()!);
    expect(player.z).toBeGreaterThan(-6.6);
    expect(player.z).toBeLessThan(-4);
  });

  test('walking is a rehearsal: the document is untouched and Escape returns to editing', async ({
    page,
  }) => {
    const before = await page.evaluate(() =>
      JSON.stringify(window.helaengine!.store.getState().scene),
    );

    await enterWalk(page);
    await page.evaluate(() => window.helaengine!.setPlayerYaw(0));
    await page.keyboard.down('w');
    await page.waitForTimeout(800);
    await page.keyboard.up('w');

    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Walk' })).toBeVisible();
    expect(await page.evaluate(() => window.helaengine!.playerPosition())).toBeNull();
    expect(
      await page.evaluate(() => JSON.stringify(window.helaengine!.store.getState().scene)),
    ).toBe(before);
  });

  test('the inspector sets a per-instance body type', async ({ page }) => {
    const id = await page.evaluate(() => window.helaengine!.addObject('prop_crate_01', [0, 4, 0]));
    await page.evaluate((objectId) => window.helaengine!.store.getState().select([objectId]), id);

    await page
      .getByRole('group', { name: 'Body type' })
      .getByRole('button', { name: 'Dynamic' })
      .click();

    expect(
      await page.evaluate(
        (objectId) =>
          window
            .helaengine!.store.getState()
            .scene.objects.find((object) => object.id === objectId)!.physics.body,
        id,
      ),
    ).toBe('dynamic');
  });
});

/**
 * Sprint 11 — enemy AI and triggers.
 *
 * The definition of done is a sentence about behaviour over time: an enemy patrols until it sees
 * the player, then chases; walking into a trigger spawns another. So these drive the real preview
 * and read the simulation, rather than asserting on markup.
 */
test.describe('enemies and triggers', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await page.waitForTimeout(800);
  });

  async function enterWalk(page: Page): Promise<void> {
    await page.getByRole('button', { name: 'Walk' }).click();
    await page.waitForFunction(() => window.helaengine!.playerPosition() !== null, undefined, {
      timeout: 20_000,
    });
    await page.waitForTimeout(500);
    await page.evaluate(() => window.helaengine!.setPlayerYaw(0));
  }

  test('the asset library offers trigger volumes under Logic', async ({ page }) => {
    await page.getByPlaceholder('Search assets…').fill('trigger');
    await expect(page.locator('[data-asset-id="logic_trigger_box"]')).toHaveCount(1);
    await expect(page.locator('[data-asset-id="logic_trigger_sphere"]')).toHaveCount(1);
  });

  test('dropping a trigger places a volume, not a model', async ({ page }) => {
    await page.getByPlaceholder('Search assets…').fill('trigger');
    const card = page.locator('[data-asset-id="logic_trigger_box"]');
    const box = (await page.locator('canvas').boundingBox())!;

    await card.hover();
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.65, { steps: 10 });
    await page.mouse.up();

    const placed = await page.evaluate(() =>
      window.helaengine!.store.getState().scene.objects.find((object) => object.trigger),
    );
    expect(placed?.trigger).toMatchObject({ shape: 'box', detects: 'player' });
    // Big enough to walk into, rather than the one-metre speck a default scale would give.
    expect(placed?.transform.scale).toEqual([4, 3, 4]);
  });

  test('the inspector wires a trigger to an action', async ({ page }) => {
    const id = await page.evaluate(() => {
      const api = window.helaengine!;
      const created = api.addObject('logic_trigger_box', [0, 0, -6]);
      api.store.getState().setTrigger(created, { shape: 'box' });
      api.store.getState().select([created]);
      return created;
    });

    await expect(page.getByRole('region', { name: 'Trigger' })).toBeVisible();
    await page.getByLabel('Add On enter action').selectOption('emit');

    const actions = await page.evaluate(
      (objectId) =>
        window.helaengine!.store.getState().scene.objects.find((object) => object.id === objectId)!
          .trigger!.onEnter,
      id,
    );
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'emit' });
  });

  test('an enemy patrols until it sees the player, then chases and attacks', async ({ page }) => {
    await page.evaluate(() => {
      const api = window.helaengine!;
      const store = api.store.getState();
      store.setPlayer({ spawn: [0, 0, 0] });

      const goblin = api.addObject('enemy_goblin_01', [0, 0, -30]);
      store.setObjectPhysics(goblin, { body: 'kinematic' });
      store.addBehavior(goblin, 'patrol', {
        waypoints: [
          [-6, 0, -30],
          [6, 0, -30],
        ],
        speed: 3,
        mode: 'pingPong',
      });
      // Sight range deliberately shorter than the 30m gap, so it starts out unaware.
      store.addBehavior(goblin, 'chaseOnSight', {
        sightRange: 14,
        fieldOfView: 360,
        chaseSpeed: 6,
        attackRange: 2,
        attackDamage: 12,
        attackInterval: 0.5,
      });
    });
    await page.waitForTimeout(800);

    await enterWalk(page);
    expect(await page.evaluate(() => window.helaengine!.enemyStates())).toMatchObject({
      obj_0001: 'patrol',
    });
    expect(await page.evaluate(() => window.helaengine!.playerHealth())).toBe(100);

    await page.keyboard.down('w');
    await page.waitForTimeout(3500);
    await page.keyboard.up('w');
    await page.waitForTimeout(2500);

    expect(await page.evaluate(() => window.helaengine!.enemyStates())).toMatchObject({
      obj_0001: expect.stringMatching(/chase|attack/),
    });
    expect(await page.evaluate(() => window.helaengine!.playerHealth())).toBeLessThan(100);
  });

  test('walking into a trigger spawns an enemy, and leaving takes it away again', async ({
    page,
  }) => {
    await page.evaluate(() => {
      const api = window.helaengine!;
      const store = api.store.getState();
      store.setPlayer({ spawn: [0, 0, 0] });

      const trigger = api.addObject('logic_trigger_box', [0, 0, -8]);
      store.setTransform(trigger, { scale: [8, 4, 8] });
      store.setTrigger(trigger, {
        shape: 'box',
        once: true,
        onEnter: [
          {
            type: 'spawn',
            assetId: 'enemy_goblin_01',
            offset: [2, 0, 0],
            behaviors: [],
            physics: { body: 'kinematic', collider: 'auto' },
          },
        ],
      });
    });
    await page.waitForTimeout(600);

    await enterWalk(page);
    expect(await page.evaluate(() => window.helaengine!.spawnedIds())).toHaveLength(0);

    await page.keyboard.down('w');
    await page.waitForTimeout(2000);
    await page.keyboard.up('w');
    await page.waitForTimeout(500);

    expect(await page.evaluate(() => window.helaengine!.spawnedIds())).toHaveLength(1);

    const documentBefore = await page.evaluate(
      () => window.helaengine!.store.getState().scene.objects.length,
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    // The spawn was a rehearsal: the document never had it, and neither does the viewport now.
    expect(await page.evaluate(() => window.helaengine!.viewportObjectIds().length)).toBe(
      documentBefore,
    );
  });

  test('a killed enemy despawns, and comes back when the preview ends', async ({ page }) => {
    await page.evaluate(() => {
      const api = window.helaengine!;
      const goblin = api.addObject('enemy_goblin_01', [0, 0, -6]);
      api.store.getState().addBehavior(goblin, 'chaseOnSight', { health: 10 });
    });
    await page.waitForTimeout(600);

    await enterWalk(page);
    await page.evaluate(() =>
      window.helaengine!.emit('damage', { targetId: 'obj_0001', amount: 999 }),
    );
    await page.waitForTimeout(400);

    expect(await page.evaluate(() => window.helaengine!.viewportObjectIds())).not.toContain(
      'obj_0001',
    );

    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);

    expect(await page.evaluate(() => window.helaengine!.viewportObjectIds())).toContain('obj_0001');
    expect(
      await page.evaluate(() => window.helaengine!.store.getState().scene.objects.length),
    ).toBe(1);
  });
});
