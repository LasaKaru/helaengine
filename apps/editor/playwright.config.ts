import { defineConfig, devices } from '@playwright/test';

/**
 * Only a smoke test today (Sprint 3). This grows into the export visual-regression suite in
 * Sprint 23, so the harness is set up now rather than bolted on when it is urgent.
 */
export default defineConfig({
  testDir: './e2e',
  // Serial, deliberately. Every test shares one origin and therefore one IndexedDB, so a parallel
  // worker resetting the database lands in the middle of another test's save. The suite is small
  // enough that correctness is worth the wall-clock time.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  // One retry everywhere, not just CI. These tests drive a WebGL canvas through a software
  // renderer, where a slow frame can push a poll past its deadline; a rerun distinguishes that
  // from a real failure without hiding one.
  retries: 1,
  expect: { timeout: 10_000 },
  reporter: process.env['CI'] ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5174',
    trace: 'on-first-retry',
  },
  /**
   * Chromium runs everything; Firefox and WebKit run the export QA suite.
   *
   * Not because the editor does not matter in other browsers — it does — but because the editor
   * suite drives pointer lock, drag-and-drop and IndexedDB in ways that are genuinely
   * browser-specific to *test*, while an export is the thing users hand to strangers. Three WebGL
   * implementations disagreeing about an export is a product bug; three of them disagreeing about
   * a drag ghost is a test to write later.
   *
   * `PW_BROWSERS=chromium` narrows it back down while iterating, which is most of the time.
   *
   * **Firefox needs an X server**, even headless: it probes for a GL driver by running its
   * `glxtest` helper, that helper speaks GLX, and GLX without a display fails — after which Firefox
   * reports "Exhausted GL driver options" and every canvas in the editor is dead. Chromium carries
   * its own SwiftShader and WebKit brings its own software path, so neither cares. Run the suite
   * under `xvfb-run -a` (see `e2e:export`), where Firefox finds Mesa's llvmpipe and works.
   */
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Honour a preinstalled Chromium when one is provided rather than downloading another.
        // Scoped to this project on purpose: as a global `use` it was also handed to Firefox and
        // WebKit, which would then launch Chromium's binary and report themselves as those browsers.
        launchOptions: {
          // The viewport needs a real WebGL context, which headless Chromium only gets via
          // SwiftShader on a machine with no GPU — CI and containers both qualify. Chromium-only
          // flags, which is why they live on this project rather than in the shared `use`.
          args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
          ...(process.env['CHROMIUM_PATH'] ? { executablePath: process.env['CHROMIUM_PATH'] } : {}),
        },
      },
    },
    ...(process.env['PW_BROWSERS'] === 'chromium'
      ? []
      : [
          {
            name: 'firefox',
            testMatch: /export-qa\.spec\.ts/,
            use: {
              ...devices['Desktop Firefox'],
              launchOptions: {
                firefoxUserPrefs: {
                  // llvmpipe is on Firefox's driver blocklist, and being on it is the correct
                  // default for a user with a real GPU. Here it is the only renderer there is.
                  'webgl.force-enabled': true,
                  'webgl.allow-software': true,
                },
              },
            },
          },
          {
            name: 'webkit',
            testMatch: /export-qa\.spec\.ts/,
            use: { ...devices['Desktop Safari'] },
          },
        ]),
    /**
     * Edge, opt-in with `PW_EDGE=1`.
     *
     * Off by default because it is not a fourth rendering engine — it is Chromium with a different
     * badge, and the `msedge` channel needs Microsoft's own build installed, which Linux CI images
     * and this container do not have. Running it would add wall-clock time and no new information
     * about WebGL. It is wired up so that anyone with Edge on their machine can check the badge.
     */
    ...(process.env['PW_EDGE'] === '1'
      ? [
          {
            name: 'edge',
            testMatch: /export-qa\.spec\.ts/,
            use: { ...devices['Desktop Edge'], channel: 'msedge' },
          },
        ]
      : []),
  ],
  webServer: [
    {
      command: 'pnpm dev --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      // Points the editor at the platform API, which turns the account bar on. Without it the
      // editor runs exactly as it always has, on IndexedDB — which is what most of this suite
      // exercises and should keep exercising.
      env: {
        VITE_API_ORIGIN: 'http://127.0.0.1:3100',
        // Turns collaborative editing on (Sprint 31). Without it the editor is single-player, which
        // is what it is for anybody who has not configured a collaboration server.
        VITE_COLLAB_ORIGIN: 'ws://127.0.0.1:3200',
      },
    },
    {
      // The platform API (Sprint 28-29). Cloud save is only testable if something is on the other
      // end of it, and a mock would be testing the mock.
      command: 'pnpm --filter @helaengine/api start',
      url: 'http://127.0.0.1:3100/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: {
        API_PORT: '3100',
        DATABASE_URL:
          process.env['TEST_DATABASE_URL'] ?? 'postgres://hela@127.0.0.1:5433/helaengine_e2e',
        REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379',
        EXPORT_ROOT: process.env['EXPORT_ROOT'] ?? '.hela-exports-e2e',
        // Uploaded assets (Sprint 30) land on disk. A directory per run keeps one run's models out
        // of the next one's storage, the same bargain `SHARE_ROOT` makes below.
        ASSET_ROOT: process.env['ASSET_ROOT'] ?? '.hela-assets-e2e',
      },
    },
    {
      // The export worker (Sprint 32). A server-side build is only testable if something is on the
      // other end of the queue, and a mock would be testing the mock. Needs Redis, the generated
      // asset library and the built engine bundle — the artifacts it makes are made of all three.
      command: 'pnpm --filter @helaengine/export-worker start',
      url: 'http://127.0.0.1:3300/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: {
        DATABASE_URL:
          process.env['TEST_DATABASE_URL'] ?? 'postgres://hela@127.0.0.1:5433/helaengine_e2e',
        REDIS_URL: process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379',
        ASSET_ROOT: 'generated/assets',
        ENGINE_RUNTIME: 'packages/engine/dist/runtime-full.js',
        EXPORT_ROOT: process.env['EXPORT_ROOT'] ?? '.hela-exports-e2e',
        EXPORT_WORKER_PORT: '3300',
      },
    },
    {
      // The collaboration server (Sprint 31). Two browsers editing one project only means anything
      // if there is a room for them to meet in, and a mock would be testing the mock.
      command: 'pnpm --filter @helaengine/collab-server start',
      url: 'http://127.0.0.1:3200/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: {
        COLLAB_PORT: '3200',
        DATABASE_URL:
          process.env['TEST_DATABASE_URL'] ?? 'postgres://hela@127.0.0.1:5433/helaengine_e2e',
      },
    },
    {
      // The co-op server (Sprint 20). Started for the whole run rather than per test, because it
      // holds the room two browser contexts have to meet in.
      command: 'pnpm --filter @helaengine/realtime start',
      url: 'http://127.0.0.1:2567/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
    },
    {
      // The share service (Sprint 27). "Here's a link" is only testable if something is on the
      // other end of the link, and a temp directory per run keeps one test's builds out of the next
      // one's public listing.
      command: 'pnpm --filter @helaengine/share start',
      url: 'http://127.0.0.1:4000/health',
      reuseExistingServer: !process.env['CI'],
      timeout: 120_000,
      env: {
        SHARE_ROOT: process.env['SHARE_ROOT'] ?? '.hela-shared-e2e',
        SHARE_ORG_TOKEN: 'e2e-team-token',
      },
    },
  ],
});
