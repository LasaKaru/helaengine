import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Rapier's WASM takes a moment to instantiate, and every test here builds a world.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
