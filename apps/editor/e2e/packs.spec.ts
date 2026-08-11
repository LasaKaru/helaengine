import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Skill packs, driven through the panel with the files this repository ships.
 *
 * The unit tests already prove the arithmetic of applying one. What only a browser can show is the
 * two claims an author actually relies on: that the preview appears *before* anything changes, and
 * that a pack they did not want is one Ctrl+Z away — not five.
 */

const PACKS = join(import.meta.dirname, '../../../packs');

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

const wind = (page: Page): Promise<number> =>
  page.evaluate(() => window.helaengine!.store.getState().scene.environment.wind.strength);

const scatterCount = (page: Page): Promise<number> =>
  page.evaluate(() => window.helaengine!.store.getState().scene.scatter.length);

async function choose(page: Page, file: string): Promise<void> {
  await page.getByLabel('Open a skill pack').setInputFiles(join(PACKS, file));
}

test.describe('skill packs', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await openEditor(page);
  });

  test('previews what it will do before changing anything', async ({ page }) => {
    const before = await wind(page);
    await choose(page, 'forest-atmosphere.md');

    const panel = page.getByRole('region', { name: 'Skill packs' });
    await expect(panel).toContainText('Forest atmosphere');
    await expect(panel).toContainText('Set the wind');
    await expect(panel).toContainText('Add ground cover');

    // Reading the recipe must not be the same act as following it: a pack changes the lighting of a
    // level somebody spent an afternoon on, and the preview is the chance to say no.
    expect(await wind(page)).toBe(before);
    expect(await scatterCount(page)).toBe(0);
  });

  test('applies, and undoes in one step', async ({ page }) => {
    await choose(page, 'forest-atmosphere.md');
    await page.getByRole('button', { name: 'Apply Forest atmosphere' }).click();

    await expect(page.getByRole('region', { name: 'Skill packs' })).toContainText('Applied');
    expect(await wind(page)).toBeCloseTo(0.8, 5);
    expect(await scatterCount(page)).toBe(2);
    // The look went through the same function the button calls, so a pack and a click agree.
    expect(
      await page.evaluate(() => window.helaengine!.store.getState().scene.environment.toneMapping),
    ).toBe('aces');

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);

    // One press, not seven. Half an undone pack would leave an author with no way to name which
    // half is still there.
    expect(await wind(page)).toBe(0);
    expect(await scatterCount(page)).toBe(0);
  });

  test('cancelling leaves the level alone', async ({ page }) => {
    await choose(page, 'forest-atmosphere.md');
    await page.getByRole('button', { name: 'Cancel' }).click();

    await expect(page.getByRole('region', { name: 'Skill packs' })).not.toContainText(
      'What it will change',
    );
    expect(await wind(page)).toBe(0);
  });

  test('a pack that wires a graph brings its nodes and its variable', async ({ page }) => {
    await choose(page, 'locked-door.md');
    await page.getByRole('button', { name: /^Apply / }).click();
    await page.waitForTimeout(300);

    const graph = await page.evaluate(() => {
      const scene = window.helaengine!.store.getState().scene;
      return {
        nodes: scene.graph.nodes.length,
        edges: scene.graph.edges.length,
        variables: scene.graph.variables.map((variable) => variable.name),
        laidOut: scene.graph.nodes.every((node) => scene.graph.layout[node.id] !== undefined),
      };
    });

    expect(graph.nodes).toBeGreaterThan(0);
    expect(graph.edges).toBeGreaterThan(0);
    expect(graph.variables.length).toBeGreaterThan(0);
    // A node with no position is a node the author cannot find, which is the same as not having it.
    expect(graph.laidOut).toBe(true);
  });

  test('refuses a file that is not a pack, and says why', async ({ page }) => {
    await page.getByLabel('Open a skill pack').setInputFiles({
      name: 'notes.md',
      mimeType: 'text/markdown',
      buffer: Buffer.from('# Just some notes\n\nNothing to apply here.\n'),
    });

    await expect(page.getByRole('alert')).toContainText('---');
    expect(await wind(page)).toBe(0);
  });
});
