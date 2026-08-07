import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type * as InspectModel from '../src/storage/inspectModel';

/**
 * Measuring a model the author brought themselves, in a real browser.
 *
 * The other half of `src/storage/localAssets.test.ts`, which stubs this out. `inspectModel`
 * decodes a glTF file with `GLTFLoader`, and a textured model's images go through an `<img>` — so
 * it cannot run under jsdom at all, and faking an image decoder to make it appear to would be
 * testing a fiction.
 *
 * The fixture is the Fox, which is also a shipped asset. That is the useful part: the browser and
 * `pnpm ingest-assets` measure the same file, so this asserts they agree. A disagreement between
 * them is the editor and the export disagreeing about the world — a model that shows one polygon
 * budget in the library and another in the build, or an animation panel offering clips the runtime
 * cannot find.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../..');

/** What the Node pipeline recorded for this file. Read rather than restated, so it cannot drift. */
function ingestedFox(): { polyCount: number; animations: string[]; skinned: boolean } {
  const manifest = JSON.parse(
    readFileSync(join(REPO, 'generated/assets/manifest.json'), 'utf8'),
  ) as { assets: { id: string; polyCount: number; animations: string[]; skinned: boolean }[] };
  const fox = manifest.assets.find((asset) => asset.id === 'enemy_fox');
  if (!fox)
    throw new Error('enemy_fox is not in the generated manifest — run `pnpm ingest-assets`');
  return fox;
}

test.describe('importing a model', () => {
  test('measures a real glTF the same way the pipeline does', async ({ page }) => {
    const expected = ingestedFox();
    const bytes = readFileSync(join(REPO, 'raw-assets/enemy_fox.glb'));

    await page.goto('/');

    const measured = await page.evaluate(async (data) => {
      // A URL, not a module specifier: this runs inside the page against Vite's dev server, which
      // serves the editor's own source. TypeScript cannot resolve a served path, so the specifier
      // is built at runtime to keep it out of the module graph, and the shape comes from the
      // type-only import at the top of the file instead.
      const { inspectModel } = (await import(
        /* @vite-ignore */ ['', 'src', 'storage', 'inspectModel.ts'].join('/')
      )) as typeof InspectModel;
      const buffer = new Uint8Array(data).buffer;
      const report = await inspectModel(buffer, 'enemy_fox.glb');
      return {
        polyCount: report.polyCount,
        animations: report.animations,
        skinned: report.skinned,
        bounds: report.bounds,
        suggestedScale: report.suggestedScale,
      };
    }, Array.from(bytes));

    // The two independent implementations agree. `polyCount` is the one most likely to drift:
    // counting `position.count / 3` instead of the index buffer reports three times too many
    // triangles for indexed geometry, which is most geometry.
    expect(measured.polyCount).toBe(expected.polyCount);
    expect(measured.animations).toEqual(expected.animations);
    expect(measured.skinned).toBe(expected.skinned);

    // 155 units long, because the Fox is authored in centimetres — as is every Mixamo character.
    // Reported so the import can say so, rather than silently rescaling a model that might really
    // be that big.
    expect(Math.max(...measured.bounds)).toBeGreaterThan(100);
    expect(measured.suggestedScale).toBe(0.01);
  });

  test('refuses a file that is not a model, with the filename in the message', async ({ page }) => {
    await page.goto('/');

    const message = await page.evaluate(async () => {
      // A URL, not a module specifier: this runs inside the page against Vite's dev server, which
      // serves the editor's own source. TypeScript cannot resolve a served path, so the specifier
      // is built at runtime to keep it out of the module graph, and the shape comes from the
      // type-only import at the top of the file instead.
      const { inspectModel } = (await import(
        /* @vite-ignore */ ['', 'src', 'storage', 'inspectModel.ts'].join('/')
      )) as typeof InspectModel;
      try {
        await inspectModel(new Uint8Array([1, 2, 3, 4]).buffer, 'holiday-photo.glb');
        return 'no error';
      } catch (error) {
        return (error as Error).message;
      }
    });

    // Naming the file is the point: somebody importing eight models needs to know which one.
    expect(message).toContain('holiday-photo.glb');
    expect(message).toContain('.glb or .gltf');
  });
});

/**
 * The feature as somebody uses it: pick a file, see the model in the library, place it.
 *
 * Driven through the real file input rather than by calling the store, because the interesting
 * failures live in the wiring — an asset that is stored but never registered with the resolver is
 * a card you can drag into the world and then watch fail to draw, and every previous custom-asset
 * path learned that the hard way.
 */
test.describe('the import panel', () => {
  test('takes a model from disk and makes it placeable', async ({ page }) => {
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
    await expect(page.locator('header.topbar')).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => window.helaengine !== undefined);

    const panel = page.getByRole('region', { name: 'Import models' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/Nothing imported yet/)).toBeVisible();

    await panel.getByLabel('Import category').selectOption('enemies');
    await panel.getByLabel('Author').fill('PixelMannen and tomkranis');
    await panel.getByLabel('Licence').fill('CC-BY-4.0');
    await panel
      .getByLabel('Choose model files')
      .setInputFiles(join(REPO, 'raw-assets/enemy_fox.glb'));

    // What it read out of the file, shown back before anything is placed. "576 triangles, 3
    // animations, rigged" is the difference between importing a model and hoping.
    await expect(panel.getByText(/576 triangles/)).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText(/3 animations/)).toBeVisible();
    await expect(panel.getByText(/rigged/).first()).toBeVisible();
    // The centimetre warning, because this is the mistake every Mixamo character arrives with.
    await expect(panel.getByText(/centimetres/)).toBeVisible();

    // In the manifest the whole editor works from, with the attribution that was typed — which is
    // what an export's CREDITS file is generated from.
    const entry = await page.evaluate(() => window.helaengine!.assetEntry('local_enemy_fox'));
    expect(entry).not.toBeNull();
    expect(entry?.category).toBe('enemies');
    expect(entry?.author).toBe('PixelMannen and tomkranis');
    expect(entry?.animations).toEqual(['Survey', 'Walk', 'Run']);
    expect(entry?.skinned).toBe(true);
    expect(entry?.origin).toBe('customer');

    // And placeable. `isModel` is the assertion that matters: it is false when the loader fell
    // back to a placeholder box, which is exactly what happens to an asset that is in a list but
    // never reached the resolver — the failure every previous custom-asset path shipped with.
    const objectId = await page.evaluate(() =>
      window.helaengine!.addObject('local_enemy_fox', [0, 0, 0]),
    );
    const built = await page.evaluate(
      (id: string) => window.helaengine!.viewportObjects().find((object) => object.id === id),
      objectId,
    );
    expect(built?.assetId).toBe('local_enemy_fox');
    expect(built?.isModel).toBe(true);
  });

  test('keeps the model across a reload, which a .hela import cannot', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /Empty field/ }).click();
    await expect(page.locator('header.topbar')).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => window.helaengine !== undefined);

    await page
      .getByRole('region', { name: 'Import models' })
      .getByLabel('Choose model files')
      .setInputFiles(join(REPO, 'raw-assets/enemy_fox.glb'));
    await expect(
      page.getByRole('region', { name: 'Import models' }).getByText(/576 triangles/),
    ).toBeVisible({ timeout: 30_000 });

    // The point of the whole table. A model imported from a `.hela` file is a blob URL, and a blob
    // URL is gone after this line — which is why reopening such a project used to show
    // placeholders until the models were uploaded to an account.
    await page.reload();
    await page.getByRole('button', { name: /Empty field/ }).click();
    await expect(page.locator('header.topbar')).toBeVisible({ timeout: 15_000 });
    await page.waitForFunction(() => window.helaengine !== undefined);

    await expect(
      page.getByRole('region', { name: 'Import models' }).getByText('enemy_fox'),
    ).toBeVisible({ timeout: 15_000 });

    // Not merely listed — still usable. The bytes survived, so a fresh object URL was made from
    // them and the model draws rather than falling back to a box.
    const entry = await page.evaluate(() => window.helaengine!.assetEntry('local_enemy_fox'));
    expect(entry?.animations).toEqual(['Survey', 'Walk', 'Run']);

    const objectId = await page.evaluate(() =>
      window.helaengine!.addObject('local_enemy_fox', [0, 0, 0]),
    );
    const built = await page.evaluate(
      (id: string) => window.helaengine!.viewportObjects().find((object) => object.id === id),
      objectId,
    );
    expect(built?.isModel).toBe(true);
  });
});
