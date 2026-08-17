import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    /** The debug handle a HelaEngine export publishes. See `mainJs.ts`. */
    helaengineExport?: {
      cameraPose(): {
        position: [number, number, number];
        target: [number, number, number];
        fov: number;
      };
    };
  }
}
import {
  diffImages,
  exportAndExtract,
  expectVisualMatch,
  frameIsNotBlank,
  hideEditorOverlays,
  serveFolder,
  waitForSettledFrame,
} from './exportHarness';

/**
 * Sprint 23 — export hardening.
 *
 * The product promise is "build a world visually, get real runnable code". This suite is what makes
 * that a promise rather than a demo: it exports real scenes, serves them the way a static host
 * would, and compares what the browser draws against what the editor draws.
 *
 * It runs in every browser the config defines. Chromium, Firefox and WebKit are three genuinely
 * different WebGL implementations, and "works in Chrome" has never been the same claim as "works".
 */

/** The scenes worth proving. Every starter template, plus the one with all the gameplay in it. */
const TEMPLATES = [
  { name: 'Empty field', slug: 'empty-field' },
  { name: 'Forest clearing', slug: 'forest-clearing' },
  { name: 'Village outpost', slug: 'village-outpost' },
  { name: 'Skirmish', slug: 'skirmish' },
  { name: 'Stress test', slug: 'stress-test' },
] as const;

/**
 * How much of the frame may differ between the editor and an export.
 *
 * Not zero, and it would be dishonest to pretend otherwise: the two run the same engine but not
 * the same *build* of it — the editor imports TypeScript sources through Vite, an export runs a
 * minified bundle — and they render at different times into differently-sized canvases on a
 * software rasteriser. What this catches is a missing model, a black screen, a wrong sky, a
 * terrain that failed to load. What it does not catch is a shadow one shade off, and it should not.
 */
const VISUAL_BUDGET = 0.06;

async function openTemplate(page: Page, template: string): Promise<void> {
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
  await page.getByRole('button', { name: new RegExp(template) }).click();
  /**
   * Waits for the *editor*, which `getByRole('banner')` does not do.
   *
   * The projects screen renders its own `<header>`, so the banner assertion this replaces passed
   * the instant the click landed and told nobody anything. `editor.spec.ts` was corrected for the
   * same reason in Sprint 33; this file was missed, and stayed green only because
   * `waitForFunction(window.helaengine)` happened to be an accidental barrier — the dev API was
   * published from the editor, so waiting for it meant waiting for the editor.
   *
   * Sprint 36 removed that accident. `window.helaengine` is now published from the shell as well,
   * because opening a .hela file is a projects-screen gesture and the suite needs it there, so the
   * wait started resolving on the projects screen and this test began screenshotting a viewport
   * that had not finished mounting. The right barrier is, and always was, the editor's own chrome.
   */
  await expect(page.locator('header.topbar')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Project name')).toBeVisible({ timeout: 30_000 });
  await page.waitForFunction(() => window.helaengine !== undefined);
}

test.describe('export visual regression', () => {
  for (const template of TEMPLATES) {
    test(`${template.name} exports and renders what the editor renders`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(300_000);
      await openTemplate(page, template.name);

      const build = await exportAndExtract(page, testInfo, {
        name: template.slug,
        mode: 'static',
      });
      const site = await serveFolder(build.root);

      try {
        const exported = await page.context().newPage();
        // Sized to the *editor's canvas*, not to the editor's window: the editor draws into a panel
        // inset in its workspace, and an export fills the page. Comparing two different aspect
        // ratios would be comparing two different projections of the world, which no tolerance can
        // make meaningful.
        const box = (await page.locator('canvas').boundingBox())!;
        await exported.setViewportSize({
          width: Math.round(box.width),
          height: Math.round(box.height),
        });

        const errors: string[] = [];
        exported.on('pageerror', (error) => errors.push(error.message));
        await exported.goto(`http://127.0.0.1:${site.port}/`);
        await waitForSettledFrame(exported);

        expect(await frameIsNotBlank(exported), 'the export drew something').toBe(true);
        expect(errors).toEqual([]);

        // The export frames itself from the scene's bounds; the editor is then put in exactly that
        // pose. Comparing two cameras that merely default similarly would be comparing defaults.
        const pose = await exported.evaluate(() => window.helaengineExport!.cameraPose());
        await page.evaluate(
          ([position, target]) => window.helaengine!.setCameraPose(position, target),
          [pose.position, pose.target] as [[number, number, number], [number, number, number]],
        );
        await hideEditorOverlays(page);
        await waitForSettledFrame(page);
        const editorShot = await page.locator('canvas').screenshot();

        const exportShot = await exported.locator('canvas').screenshot();
        await testInfo.attach(`${template.slug}-editor`, {
          body: editorShot,
          contentType: 'image/png',
        });
        await testInfo.attach(`${template.slug}-export`, {
          body: exportShot,
          contentType: 'image/png',
        });

        const result = diffImages(editorShot, exportShot, testInfo, `${template.slug}-diff`);
        expectVisualMatch(result, VISUAL_BUDGET, `${template.name} editor vs export`);
        await exported.close();
      } finally {
        await site.close();
      }
    });
  }
});

test.describe('export edge cases', () => {
  test('a scene with no objects exports and opens rather than failing', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    await openTemplate(page, 'Empty field');
    await page.evaluate(() => window.helaengine!.clear());
    await page.waitForTimeout(300);

    const build = await exportAndExtract(page, testInfo, { name: 'empty', mode: 'static' });
    // No models means no decoder to ship — an empty export should not carry a megabyte of Draco.
    expect(build.files.some((file) => file.includes('draco'))).toBe(false);

    const site = await serveFolder(build.root);
    try {
      const exported = await page.context().newPage();
      const errors: string[] = [];
      exported.on('pageerror', (error) => errors.push(error.message));

      await exported.goto(`http://127.0.0.1:${site.port}/`);
      await waitForSettledFrame(exported);
      expect(errors).toEqual([]);
      await exported.close();
    } finally {
      await site.close();
    }
  });

  test('a broken asset reference is caught, repaired and disclosed', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await openTemplate(page, 'Empty field');

    // A document that names an asset the library does not have. This is what a scene saved against
    // an older library looks like, and it must not silently produce a broken folder.
    await page.evaluate(() => {
      const state = window.helaengine!.store.getState();
      state.setScene({
        ...state.scene,
        objects: [
          {
            id: 'obj_0001',
            assetId: 'asset_that_does_not_exist',
            parentId: null,
            transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
            behaviors: [],
            physics: { body: 'static', collider: 'auto' },
            animation: null,
            material: null,
            trigger: null,
            destructible: null,
            vehicle: null,
            ragdoll: null,
            emitter: null,
            sway: 'auto' as const,
            lod: 'auto' as const,
            metadata: {},
          },
        ],
      });
    });
    await page.waitForTimeout(300);

    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });
    // Said before the export runs, not after: somebody deciding whether to ship this needs to know.
    await expect(dialog).toContainText('asset_that_does_not_exist');
    await expect(dialog).toContainText('placeholders');

    await dialog.getByRole('button', { name: 'Static scene' }).click();
    await dialog.getByLabel('Project name').fill('broken');
    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
    await dialog.getByRole('button', { name: 'Check and export' }).click();
    await downloadPromise;

    // Sprint 26 changed what happens next, and for the better: this used to ship a folder full of
    // placeholder boxes with a warning nobody had to read. Now the gate refuses it, the repair loop
    // removes the object whose model does not exist, and the download only starts afterwards —
    // with the change stated in the user's own words rather than buried in a warnings list.
    await expect(dialog).toContainText('We changed your scene to make it work');
    await expect(dialog).toContainText('asset_that_does_not_exist');
    void testInfo;
  });

  test('a large sculpted terrain exports without the archive becoming absurd', async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    await openTemplate(page, 'Forest clearing');

    const sceneBytes = await page.evaluate(
      () => JSON.stringify(window.helaengine!.store.getState().scene).length,
    );
    // The heightmap and splatmap ride inside the document as base64, so the document itself is the
    // thing that grows. This pins the trade-off rather than assuming it stayed reasonable.
    expect(sceneBytes).toBeGreaterThan(20_000);

    const build = await exportAndExtract(page, testInfo, { name: 'terrain', mode: 'static' });
    expect(build.bytes).toBeLessThan(8 * 1024 * 1024);
  });

  test('the wizard estimates the size before anything is downloaded', async ({ page }) => {
    await openTemplate(page, 'Skirmish');
    await page.getByRole('button', { name: 'Export' }).click();
    const dialog = page.getByRole('dialog', { name: 'Export' });

    await expect(dialog).toContainText('before compression');
    // The game bundle carries the physics engine, so switching modes has to move the number.
    await dialog.getByRole('button', { name: 'Static scene' }).click();
    const asStatic = await dialog.textContent();
    await dialog.getByRole('button', { name: 'Playable game' }).click();
    const asGame = await dialog.textContent();

    expect(asStatic).not.toBe(asGame);
  });
});

test.describe('export on a slow connection', () => {
  test('a throttled export still loads, and shows the world rather than nothing', async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    await openTemplate(page, 'Village outpost');

    const build = await exportAndExtract(page, testInfo, { name: 'slow', mode: 'static' });
    // Real throttling — a delay and a small chunk size on the server — rather than Playwright's
    // CDP emulation, which exists only in Chromium. "Works on a slow connection" has to be a
    // question every browser can answer.
    const site = await serveFolder(build.root, { delayMs: 120, chunkBytes: 16 * 1024 });

    try {
      const exported = await page.context().newPage();
      const errors: string[] = [];
      exported.on('pageerror', (error) => errors.push(error.message));

      await exported.goto(`http://127.0.0.1:${site.port}/`, { timeout: 120_000 });

      // The point of building the scene twice: something is on screen from the manifest's bounds
      // long before the models finish arriving.
      await exported.waitForFunction(() => document.querySelector('canvas') !== null, undefined, {
        timeout: 60_000,
      });
      await waitForSettledFrame(exported, 90_000);

      expect(await frameIsNotBlank(exported), 'the slow-loading export drew something').toBe(true);
      expect(errors).toEqual([]);
      await exported.close();
    } finally {
      await site.close();
    }
  });
});

test.describe('export documentation', () => {
  test('every export carries the docs it promises', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    await openTemplate(page, 'Skirmish');

    const build = await exportAndExtract(page, testInfo, { name: 'docs', mode: 'game' });
    for (const file of ['README.md', 'CREDITS.md', 'LICENSE.md']) {
      expect(build.files).toContain(file);
    }

    const readme = readFileSync(join(build.root, 'README.md'), 'utf8');
    // The two failures that actually happen, both silent, both documented.
    expect(readme).toContain('application/wasm');
    expect(readme).toContain('file://');
    expect(readme).toContain('Troubleshooting');
  });
});
