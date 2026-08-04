import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { extname, join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { expect, type Page, type TestInfo } from '@playwright/test';

/**
 * Content types a real static host would use.
 *
 * `.wasm` is the one that matters: browsers refuse to compile a WebAssembly module served as
 * `application/octet-stream`, and the symptom is a world where every model is a grey box.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

export interface StaticSite {
  port: number;
  close(): Promise<void>;
}

export interface ServeOptions {
  /**
   * Milliseconds of delay before each response, and bytes per chunk.
   *
   * Real throttling rather than Playwright's CDP emulation, which only exists in Chromium — and
   * "does it work on a slow connection" is a question that has to be answerable in every browser.
   */
  delayMs?: number;
  chunkBytes?: number;
}

/** Serves an extracted export over HTTP, optionally slowly. */
export async function serveFolder(root: string, options: ServeOptions = {}): Promise<StaticSite> {
  const server: Server = createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0] ?? '/';
    const target = join(root, url === '/' ? 'index.html' : decodeURIComponent(url));

    if (!target.startsWith(root) || !existsSync(target)) {
      response.writeHead(404).end('not found');
      return;
    }

    const send = (): void => {
      response.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      });
      if (!options.chunkBytes) {
        createReadStream(target).pipe(response);
        return;
      }
      createReadStream(target, { highWaterMark: options.chunkBytes }).pipe(response);
    };

    if (options.delayMs) setTimeout(send, options.delayMs);
    else send();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface ExportedBuild {
  root: string;
  bytes: number;
  /** Every file in the archive, relative to its root folder. */
  files: string[];
}

/**
 * Drives the export wizard and extracts what it produced.
 *
 * Extracted with `unzip` rather than a library, deliberately: an archive only its own author can
 * read is not an archive, and that is exactly the class of bug a JSZip-based check would miss.
 */
export async function exportAndExtract(
  page: Page,
  testInfo: TestInfo,
  options: { name: string; mode: 'static' | 'game'; readable?: boolean; minify?: boolean },
): Promise<ExportedBuild> {
  await page.getByRole('button', { name: 'Export' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });

  await dialog
    .getByRole('button', { name: options.mode === 'game' ? 'Playable game' : 'Static scene' })
    .click();
  if (options.readable) await dialog.getByLabel('Readable level listing').check();
  if (options.minify === false) await dialog.getByLabel('Minify main.js').uncheck();
  await dialog.getByLabel('Project name').fill(options.name);

  const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
  await dialog.getByRole('button', { name: 'Check and export' }).click();
  const download = await downloadPromise;

  const zipPath = testInfo.outputPath(`${options.name}.zip`);
  await download.saveAs(zipPath);

  const extractedTo = testInfo.outputPath(`${options.name}-extracted`);
  await mkdir(extractedTo, { recursive: true });
  execFileSync('unzip', ['-q', '-o', zipPath, '-d', extractedTo]);

  // Closed before returning: the dialog covers the viewport, and a caller that screenshots the
  // editor afterwards would be photographing this modal. It was, convincingly.
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).not.toBeVisible();

  const root = join(extractedTo, options.name);
  const files = execFileSync('find', [root, '-type', 'f'])
    .toString()
    .split('\n')
    .filter(Boolean)
    .map((path) => path.slice(root.length + 1))
    .sort();

  return { root, bytes: readFileSync(zipPath).length, files };
}

export interface DiffResult {
  /** Fraction of pixels that differ, 0..1. */
  ratio: number;
  differing: number;
  total: number;
}

/**
 * Compares two PNGs.
 *
 * A *ratio* rather than a raw count, because the two screenshots are the same size by construction
 * and a percentage is the only number a threshold can be argued about in. `threshold` here is
 * pixelmatch's per-pixel colour tolerance — a shadow one shade off is not a regression, and a
 * missing building is not one pixel.
 */
export function diffImages(a: Buffer, b: Buffer, testInfo?: TestInfo, label?: string): DiffResult {
  const left = PNG.sync.read(a);
  const right = PNG.sync.read(b);

  if (left.width !== right.width || left.height !== right.height) {
    throw new Error(
      `screenshots are different sizes: ${left.width}x${left.height} vs ${right.width}x${right.height}`,
    );
  }

  const diff = new PNG({ width: left.width, height: left.height });
  const differing = pixelmatch(left.data, right.data, diff.data, left.width, left.height, {
    threshold: 0.2,
  });

  // Written out whether or not it passes: a failure nobody can look at is a failure nobody can fix.
  if (testInfo && label) {
    testInfo.attachments.push({
      name: label,
      contentType: 'image/png',
      body: PNG.sync.write(diff),
    });
  }

  const total = left.width * left.height;
  return { ratio: differing / total, differing, total };
}

/**
 * A cheap fingerprint of a rendered frame, from a screenshot.
 *
 * Screenshots rather than reading the canvas in-page, and that is not a style preference: a WebGL
 * canvas without `preserveDrawingBuffer` gives an *empty* image to `drawImage` and `toDataURL`,
 * because the back buffer is discarded as soon as it has been presented. The editor sets that flag
 * for its thumbnails; an export has no reason to and does not. An in-page check therefore reports
 * every export as blank — which it did, convincingly, until this was written the other way round.
 */
async function frameFingerprint(page: Page): Promise<{ signature: string; colours: number }> {
  const canvas = page.locator('canvas').first();
  if ((await canvas.count()) === 0) return { signature: '', colours: 0 };

  const png = PNG.sync.read(await canvas.screenshot());
  const seen = new Set<string>();
  const buckets: number[] = [];

  // A coarse grid rather than every pixel: enough to notice a model appearing, cheap enough to
  // poll, and immune to the single-pixel noise a software rasteriser produces.
  for (let row = 0; row < 12; row += 1) {
    for (let column = 0; column < 20; column += 1) {
      const x = Math.floor((column + 0.5) * (png.width / 20));
      const y = Math.floor((row + 0.5) * (png.height / 12));
      const at = (y * png.width + x) * 4;
      const colour = `${png.data[at]! >> 3},${png.data[at + 1]! >> 3},${png.data[at + 2]! >> 3}`;
      seen.add(colour);
      buckets.push(png.data[at]! >> 3, png.data[at + 1]! >> 3, png.data[at + 2]! >> 3);
    }
  }

  return { signature: buckets.join(''), colours: seen.size };
}

/**
 * True when the page has drawn something rather than one flat colour.
 *
 * The bar is *two* colours, not three. An earlier version demanded three on the reasoning that a
 * world has a sky, a ground and something standing on it — which is true of every template except
 * the empty one, whose whole point is a horizon and nothing else. A blank frame is one colour;
 * that is the honest line, and anything beyond it is the pixel diff's job.
 */
export async function frameIsNotBlank(page: Page): Promise<boolean> {
  return (await frameFingerprint(page)).colours > 1;
}

/**
 * Waits until the canvas has stopped changing.
 *
 * Everything visual in this suite depends on comparing a *settled* frame. Models stream in, the
 * camera eases, shadows resolve — screenshotting at a fixed timeout catches whichever of those
 * happened to be mid-flight, which is how a visual suite earns its reputation for flakiness.
 */
export async function waitForSettledFrame(page: Page, timeoutMs = 45_000): Promise<void> {
  await page.waitForFunction(() => document.querySelector('canvas') !== null, undefined, {
    timeout: timeoutMs,
  });

  const deadline = Date.now() + timeoutMs;
  let previous = '';
  let stable = 0;

  while (Date.now() < deadline) {
    const { signature } = await frameFingerprint(page);

    if (signature !== '' && signature === previous) {
      stable += 1;
      if (stable >= 3) return;
    } else {
      stable = 0;
    }
    previous = signature;
    await page.waitForTimeout(400);
  }
}

/**
 * Hides the editor furniture drawn over the viewport.
 *
 * An element screenshot captures the *page region* the element occupies, overlays included — so
 * the toolbar, the object counter and the walking hint all land in a picture of the canvas. None
 * of them exist in an export, and comparing them against it is comparing an editor to a game.
 */
export async function hideEditorOverlays(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `.placement-toolbar, .walk-hint, .health-bar, .viewport-stats, .hela-ui,
              .drag-chip { visibility: hidden !important; }`,
  });
}

/** Asserts a screenshot pair matches, with a readable message when it does not. */
export function expectVisualMatch(result: DiffResult, maxRatio: number, what: string): void {
  expect(
    result.ratio,
    `${what}: ${result.differing} of ${result.total} pixels differ ` +
      `(${(result.ratio * 100).toFixed(2)}%, budget ${(maxRatio * 100).toFixed(2)}%)`,
  ).toBeLessThanOrEqual(maxRatio);
}
