import { defineConfig, devices } from '@playwright/test';

/**
 * Only a smoke test today (Sprint 3). This grows into the export visual-regression suite in
 * Sprint 15, so the harness is set up now rather than bolted on when it is urgent.
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
    launchOptions: {
      // The viewport needs a real WebGL context, which headless Chromium only gets via SwiftShader
      // on a machine with no GPU — CI and containers both qualify.
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'],
      // Honour a preinstalled browser when one is provided rather than downloading another.
      ...(process.env['CHROMIUM_PATH'] ? { executablePath: process.env['CHROMIUM_PATH'] } : {}),
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
  },
});
