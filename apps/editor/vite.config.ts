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
  },
});
