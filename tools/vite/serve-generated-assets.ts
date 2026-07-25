import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ResolvedConfig } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const generatedAssetsDir = path.join(repoRoot, 'generated/assets');

const MIME_TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.js': 'text/javascript; charset=utf-8',
  // Draco's decoder is streamed-compiled; the wrong MIME type here fails silently in Chrome.
  '.wasm': 'application/wasm',
};

/**
 * Serves `generated/assets/` at `/assets/` during development.
 *
 * The ingest pipeline writes one copy of the asset library at the repo root, and every app that
 * needs it mounts that same directory rather than keeping its own copy of the binaries. Production
 * builds copy the directory in instead — see `buildStart` below.
 */
export function serveGeneratedAssets(): Plugin {
  let config: ResolvedConfig;

  return {
    name: 'helaengine:serve-generated-assets',

    configResolved(resolved) {
      config = resolved;
    },

    configureServer(server) {
      server.middlewares.use('/assets', (request, response, next) => {
        const requestPath = decodeURIComponent((request.url ?? '/').split('?')[0] ?? '/');
        const filePath = path.join(generatedAssetsDir, requestPath);

        // Refuse anything that escapes the assets directory via `..`.
        if (!filePath.startsWith(generatedAssetsDir)) {
          response.statusCode = 403;
          response.end('forbidden');
          return;
        }

        fs.stat(filePath, (error, stats) => {
          if (error || !stats.isFile()) {
            next();
            return;
          }
          response.setHeader(
            'content-type',
            MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
          );
          fs.createReadStream(filePath).pipe(response);
        });
      });
    },

    buildStart() {
      if (!fs.existsSync(generatedAssetsDir)) {
        this.warn(
          'generated/assets is missing — run `pnpm ingest-assets` or the build will ship without models.',
        );
      }
    },

    // Vite only copies its own `publicDir`, so the shared asset directory is emitted here.
    closeBundle() {
      if (!fs.existsSync(generatedAssetsDir)) return;
      const outDir = path.resolve(config.root, config.build.outDir);
      fs.cpSync(generatedAssetsDir, path.join(outDir, 'assets'), { recursive: true });
    },
  };
}
