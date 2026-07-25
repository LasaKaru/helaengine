import { defineConfig } from 'vitest/config';

/**
 * No `@vitejs/plugin-react` here on purpose: it exists for Fast Refresh, which tests don't use,
 * and Vite's own esbuild pass already handles the JSX transform via tsconfig's `jsx: react-jsx`.
 */
export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
