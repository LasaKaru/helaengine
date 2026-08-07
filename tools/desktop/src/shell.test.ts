import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron, type ElectronApplication } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_DESKTOP_OPTIONS } from './plan.js';
import { assertIsExport, packageDesktop } from './package.js';

/**
 * Launches a real packaged build and asks the game inside it whether it is alive.
 *
 * The build is for **linux-x64** and the deliverable is Windows, which looks like the wrong test
 * until you look at what differs. The packaging is one code path: the same `main.cjs`, the same
 * `resources/app` layout, the same protocol handler, the same rename. What changes between targets
 * is which Electron archive was unpacked. So this exercises everything except the choice of binary
 * — and it can run in CI, which is Linux, on every commit, instead of on a Windows machine
 * somebody remembers to check.
 *
 * The Windows-only parts have their own coverage: `versionQuad` and the filename rules are unit
 * tested, and `stampWindowsExecutable` runs against a real `.exe` in `stamp.test.ts`.
 *
 * The game here is a synthetic export rather than a real one on purpose. A real export needs the
 * generated asset library and both engine builds, which is a ten-minute pipeline; and the thing
 * under test is the *shell*, whose entire job is to make four browser features work from a folder
 * on disk. This asserts those four directly.
 */

/**
 * Opt-in, because this downloads a 100 MB Electron distribution and needs a display.
 *
 * Gated rather than merely slow: the repository's `verify` job runs every package's suite on every
 * pull request, and a 100 MB download plus an Xvfb dependency does not belong there. It has its own
 * workflow, which caches the distribution and sets this. Locally, `HELA_DESKTOP_E2E=1 pnpm test`.
 */
const RUN_E2E = process.env.HELA_DESKTOP_E2E === '1';

let work: string;
let app: ElectronApplication | null = null;
let buildDir: string;

/**
 * A minimal export: the file layout `assertIsExport` requires, and a page that exercises exactly
 * what a real game needs from the shell.
 */
async function writeSyntheticExport(root: string): Promise<void> {
  await mkdir(join(root, 'engine'), { recursive: true });
  await mkdir(join(root, 'assets'), { recursive: true });

  await writeFile(
    join(root, 'index.html'),
    `<!doctype html><html><head><meta charset="utf-8"><title>Synthetic</title></head>
<body><canvas id="viewport"></canvas><script type="module" src="./main.js"></script></body></html>`,
  );

  // A separate module the page imports, so a shell that failed to serve ES modules with a usable
  // MIME type or from an origin the loader trusts fails here rather than subtly later.
  await writeFile(
    join(root, 'engine', 'runtime.js'),
    'export const brand = "helaengine";\nexport function add(a, b) { return a + b; }\n',
  );

  await writeFile(join(root, 'scene.json'), JSON.stringify({ name: 'Synthetic', objects: [] }));
  // Bytes rather than text: models and the Draco decoder arrive as ArrayBuffers, and a handler
  // that only got text right would pass a JSON-only test and ship broken models.
  await writeFile(join(root, 'assets', 'blob.bin'), Buffer.from([0xde, 0xad, 0xbe, 0xef]));

  await writeFile(
    join(root, 'main.js'),
    `import { brand, add } from './engine/runtime.js';

const state = {
  moduleLoaded: brand === 'helaengine' && add(2, 2) === 4,
  sceneName: null,
  assetBytes: null,
  webgl: false,
  traversal: [],
  missingStatus: null,
  errors: [],
};
window.syntheticExport = state;

async function boot() {
  const scene = await fetch('./scene.json').then((r) => r.json());
  state.sceneName = scene.name;

  const bytes = new Uint8Array(await fetch('./assets/blob.bin').then((r) => r.arrayBuffer()));
  state.assetBytes = Array.from(bytes);

  const canvas = document.getElementById('viewport');
  state.webgl = Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));

  // Asking the shell for something outside the game folder, from inside the page — which is where
  // such a request would really come from. Percent-encoded, because the plain form is normalised
  // away by the URL parser before the handler ever sees it: the encoded one is what actually
  // reaches the containment check, and so is the only form that tests it.
  for (const path of ['/../../../../../../etc/passwd', '/..%2f..%2f..%2f..%2f..%2f..%2fetc/passwd']) {
    try {
      const escaped = await fetch(path);
      state.traversal.push({ path, status: escaped.status, body: (await escaped.text()).slice(0, 40) });
    } catch (error) {
      state.traversal.push({ path, status: 'threw: ' + error.message, body: '' });
    }
  }

  state.missingStatus = (await fetch('./assets/not-here.glb')).status;

  state.ready = true;
}

boot().catch((error) => { state.errors.push(String(error)); state.ready = true; });
`,
  );
}

beforeAll(async () => {
  if (!RUN_E2E) return;

  work = await mkdtemp(join(tmpdir(), 'hela-desktop-'));
  const exportDir = join(work, 'export');
  await writeSyntheticExport(exportDir);
  await assertIsExport(exportDir);

  const result = await packageDesktop({
    ...DEFAULT_DESKTOP_OPTIONS,
    platform: 'linux-x64',
    productName: 'Synthetic Game',
    exportDir,
    outDir: join(work, 'out'),
  });
  buildDir = result.buildDir;

  app = await electron.launch({
    executablePath: result.executable,
    // A container has no user namespaces, which is the sandbox's requirement, not the shell's.
    // Renderer privileges — the part this tool is responsible for — are asserted below.
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
}, 600_000);

afterAll(async () => {
  await app?.close();
  if (work) await rm(work, { recursive: true, force: true });
});

describe.runIf(RUN_E2E)('a packaged build', () => {
  it('opens exactly one window, on the game', async () => {
    const page = await app!.firstWindow();
    await page.waitForFunction(
      () =>
        (window as never as { syntheticExport?: { ready?: boolean } }).syntheticExport?.ready ===
        true,
      undefined,
      { timeout: 60_000 },
    );
    expect(page.url()).toBe('hela://game/index.html');
    expect(app!.windows()).toHaveLength(1);
  });

  it('loads ES modules, which file:// refuses and which is why the shell exists', async () => {
    const page = await app!.firstWindow();
    expect(
      await page.evaluate(
        () =>
          (window as never as { syntheticExport: { moduleLoaded: boolean } }).syntheticExport
            .moduleLoaded,
      ),
    ).toBe(true);
  });

  it('fetches the scene document', async () => {
    const page = await app!.firstWindow();
    expect(
      await page.evaluate(
        () =>
          (window as never as { syntheticExport: { sceneName: string } }).syntheticExport.sceneName,
      ),
    ).toBe('Synthetic');
  });

  it('serves binary assets byte for byte', async () => {
    const page = await app!.firstWindow();
    expect(
      await page.evaluate(
        () =>
          (window as never as { syntheticExport: { assetBytes: number[] } }).syntheticExport
            .assetBytes,
      ),
    ).toEqual([0xde, 0xad, 0xbe, 0xef]);
  });

  it('has a WebGL context, without which there is no game', async () => {
    const page = await app!.firstWindow();
    expect(
      await page.evaluate(
        () => (window as never as { syntheticExport: { webgl: boolean } }).syntheticExport.webgl,
      ),
    ).toBe(true);
  });

  it('refuses to serve a file outside the game folder', async () => {
    const page = await app!.firstWindow();
    const attempts = await page.evaluate(
      () =>
        (
          window as never as {
            syntheticExport: { traversal: { path: string; status: unknown; body: string }[] };
          }
        ).syntheticExport.traversal,
    );

    const [plain, encoded] = attempts;

    // The plain form is normalised away by the URL parser before the handler sees it, so it
    // arrives as `/etc/passwd` *inside* the game folder and is simply absent.
    expect(plain?.status).toBe(404);

    // The encoded form arrives intact and is the one the containment check has to refuse. Asserting
    // 403 rather than "403 or 404" is the point of this test: with the check deleted the request is
    // still answered 404, because Electron's `net.fetch` declines the escaped path for reasons of
    // its own — so accepting 404 here would pass with no containment check at all. 403 is a status
    // only `resolveWithin` produces.
    expect(encoded?.status).toBe(403);

    for (const attempt of attempts) expect(attempt.body).not.toContain('root:');
  });

  it('answers a missing asset with a 404 rather than a failed request', async () => {
    const page = await app!.firstWindow();
    // The distinction matters to whoever debugs it: a rejected request reads as a network problem,
    // and an exported game has no network. A 404 says the file is not in the build.
    expect(
      await page.evaluate(
        () =>
          (window as never as { syntheticExport: { missingStatus: unknown } }).syntheticExport
            .missingStatus,
      ),
    ).toBe(404);
  });

  it('gives the page no Node privileges', async () => {
    const page = await app!.firstWindow();
    // A game may ship assets and code its author did not write. If any of these are defined, the
    // page can read the player's filesystem — the guarantee the browser export gives for free and
    // which a careless desktop wrapper silently drops.
    expect(
      await page.evaluate(() => ({
        require: typeof (globalThis as never as { require?: unknown }).require,
        process: typeof (globalThis as never as { process?: unknown }).process,
        module: typeof (globalThis as never as { module?: unknown }).module,
      })),
    ).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined' });
  });

  it('reported no errors from the game itself', async () => {
    const page = await app!.firstWindow();
    expect(
      await page.evaluate(
        () => (window as never as { syntheticExport: { errors: string[] } }).syntheticExport.errors,
      ),
    ).toEqual([]);
  });

  it('leaves the export untouched inside the build', async () => {
    const { readFile } = await import('node:fs/promises');
    const shipped = await readFile(join(buildDir, 'resources/app/game/scene.json'), 'utf8');
    const original = await readFile(join(work, 'export/scene.json'), 'utf8');
    // The whole design rests on this: the desktop build is the same game as the web build, so an
    // export that passed the release gate has already been tested where it counts.
    expect(shipped).toBe(original);
  });
});
