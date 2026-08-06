import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { serveGeneratedAssets } from '../../tools/vite/serve-generated-assets.js';

export default defineConfig({
  plugins: [react(), serveGeneratedAssets()],
  server: {
    port: 5174,
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The manifest is what makes the bundle budget checkable rather than a guess: it records which
    // chunks the entry pulls in *statically* — the bytes a user waits for before anything renders —
    // as distinct from the ones behind a dynamic import, which cost nothing until they are needed.
    manifest: true,
  },
});
