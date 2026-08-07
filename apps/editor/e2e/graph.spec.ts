import { expect, test, type Page } from '@playwright/test';

/**
 * The node graph, authored in a real browser and then run.
 *
 * The component tests already prove the canvas edits the document correctly. What they cannot prove
 * is the part that matters most: that a graph drawn in the editor is the same graph the engine
 * executes. So these author a graph through the UI, press Walk, and read a variable out of the
 * running runtime — which nothing but the graph can have changed.
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
  await page.waitForTimeout(800);
}

async function startPlaying(page: Page): Promise<void> {
  const play = page.locator('.hela-panel button', { hasText: 'Play' });
  if ((await play.count()) === 0) return;
  await expect
    .poll(
      async () => {
        if ((await play.count()) === 0) return 'gone';
        await play
          .first()
          .click({ force: true })
          .catch(() => undefined);
        return page.evaluate(() => window.helaengine!.uiScreen());
      },
      { timeout: 20_000 },
    )
    .not.toBe('home');
}

async function walk(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Walk' }).click();
  await page.waitForFunction(() => window.helaengine!.playerPosition() !== null, undefined, {
    timeout: 20_000,
  });
  await startPlaying(page);
}

test.describe('node graph', () => {
  test.beforeEach(async ({ page }) => {
    await openEditor(page);
    await page.getByRole('button', { name: 'Graph' }).click();
    await expect(page.getByRole('dialog', { name: 'Node graph' })).toBeVisible();
  });

  test('a graph authored in the canvas runs when the level is played', async ({ page }) => {
    // score = 0; on start, set it to 7. Nothing else in the engine writes a graph variable, so a 7
    // in the running runtime can only have come from this chain.
    await page.getByRole('button', { name: 'Add variable' }).click();
    await page.getByRole('button', { name: 'On start', exact: true }).click();
    await page.getByRole('button', { name: 'Set variable', exact: true }).click();

    await page.getByRole('combobox', { name: 'Variable', exact: true }).selectOption('variable1');
    await page.getByRole('textbox', { name: 'Value number' }).fill('7');
    await page.getByRole('textbox', { name: 'Value number' }).press('Enter');

    await page.getByRole('button', { name: 'onStart1 output then' }).click();
    await page.getByRole('button', { name: 'Set variable setVariable1' }).click();

    await expect(page.getByRole('region', { name: 'Graph problems' })).toContainText(
      'Ready to run',
    );
    await page.getByRole('button', { name: 'Close' }).click();

    await walk(page);

    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.graphVariable('variable1')), {
        timeout: 15_000,
      })
      .toBe(7);
    expect(await page.evaluate(() => window.helaengine!.graphProblems())).toEqual([]);
  });

  test('a wait node makes a chain repeat rather than hang', async ({ page }) => {
    // The loop the schema deliberately allows: add → wait → add. If the delay were not honoured
    // this would be an instant cycle, the graph would refuse to start, and the count would stay 0.
    await page.getByRole('button', { name: 'Add variable' }).click();
    await page.getByRole('button', { name: 'On start', exact: true }).click();
    await page.getByRole('button', { name: 'Add to variable', exact: true }).click();
    await page.getByRole('button', { name: 'Wait', exact: true }).click();

    await page.getByRole('textbox', { name: 'Seconds', exact: true }).fill('0.1');
    await page.getByRole('textbox', { name: 'Seconds', exact: true }).press('Enter');

    await page.getByRole('button', { name: 'Add to variable addToVariable1' }).click();
    await page.getByRole('combobox', { name: 'Variable', exact: true }).selectOption('variable1');

    await page.getByRole('button', { name: 'onStart1 output then' }).click();
    await page.getByRole('button', { name: 'Add to variable addToVariable1' }).click();
    await page.getByRole('button', { name: 'addToVariable1 output then' }).click();
    await page.getByRole('button', { name: 'Wait wait1' }).click();
    await page.getByRole('button', { name: 'wait1 output then' }).click();
    await page.getByRole('button', { name: 'Add to variable addToVariable1' }).click();

    await expect(page.getByRole('region', { name: 'Graph problems' })).toContainText(
      'Ready to run',
    );
    await page.getByRole('button', { name: 'Close' }).click();

    await walk(page);

    // Counting up over real frames, which is the whole difference between a delay and a hang.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.graphVariable('variable1')), {
        timeout: 20_000,
      })
      .toBeGreaterThan(3);
  });

  test('an instant loop is named on the canvas and refuses to run', async ({ page }) => {
    await page.getByRole('button', { name: 'Emit event', exact: true }).click();
    await page.getByRole('button', { name: 'On start', exact: true }).click();
    await page.getByRole('button', { name: 'onStart1 output then' }).click();
    await page.getByRole('button', { name: 'Emit event emit1' }).click();
    await page.getByRole('button', { name: 'emit1 output then' }).click();
    await page.getByRole('button', { name: 'Emit event emit1' }).click();

    // The self-wire is refused by the canvas, so the loop is drawn the way one is made by accident:
    // through a second node.
    await page.getByRole('button', { name: 'Emit event', exact: true }).click();
    await page.getByRole('button', { name: 'emit1 output then' }).click();
    await page.getByRole('button', { name: 'Emit event emit2' }).click();
    await page.getByRole('button', { name: 'emit2 output then' }).click();
    await page.getByRole('button', { name: 'Emit event emit1' }).click();

    const problems = page.getByRole('region', { name: 'Graph problems' });
    await expect(problems).toContainText('loop');
    // Named, not merely detected — the point is being able to find them on the canvas.
    await expect(problems).toContainText('emit1');

    await page.getByRole('button', { name: 'Close' }).click();
    await walk(page);

    // Refused rather than run half-way. The tab is still responsive, which is the actual claim.
    await expect
      .poll(async () => page.evaluate(() => window.helaengine!.graphProblems().join('\n')), {
        timeout: 15_000,
      })
      .toContain('loop');
    expect(await page.evaluate(() => window.helaengine!.playerPosition())).not.toBeNull();
  });

  test('the graph survives a save and reload of the document', async ({ page }) => {
    await page.getByRole('button', { name: 'On start', exact: true }).click();
    await page.getByRole('button', { name: 'Show message', exact: true }).click();
    await page.getByRole('button', { name: 'onStart1 output then' }).click();
    await page.getByRole('button', { name: 'Show message showMessage1' }).click();

    const saved = await page.evaluate(() =>
      JSON.stringify(window.helaengine!.store.getState().scene),
    );
    // Round-tripped through JSON exactly as a save and open would, which is where a field that is
    // held only in component state rather than in the document quietly disappears.
    await page.evaluate((json) => {
      window.helaengine!.store.getState().setScene(JSON.parse(json));
    }, saved);

    const graph = await page.evaluate(() => window.helaengine!.store.getState().scene.graph);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.edges).toEqual([{ from: 'onStart1', port: 'then', to: 'showMessage1' }]);
    expect(graph.layout.onStart1).toBeDefined();
  });
});
