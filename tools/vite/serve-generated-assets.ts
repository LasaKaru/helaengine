import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin, ResolvedConfig } from 'vite';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const generatedAssetsDir = path.join(repoRoot, 'generated/assets');
/**
 * The self-contained engine bundle an export ships.
 *
 * Served as a static file rather than imported, because the editor never *runs* it — it copies it
 * into a zip verbatim. Bundling it into the editor's own JavaScript would embed a second whole copy
 * of Three.js in the editor for no reason.
 */
const runtimeBundles: Record<string, string> = {
  '/engine-runtime.js': path.join(repoRoot, 'packages/engine/dist/runtime.js'),
  // The same engine with Rapier inlined, for exports that run the game rather than only draw it.
  '/engine-runtime-full.js': path.join(repoRoot, 'packages/engine/dist/runtime-full.js'),
};

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
      for (const [route, file] of Object.entries(runtimeBundles)) {
        server.middlewares.use(route, (_request, response, next) => {
          if (!fs.existsSync(file)) {
            next();
            return;
          }
          response.setHeader('content-type', 'text/javascript; charset=utf-8');
          fs.createReadStream(file).pipe(response);
        });
      }

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
      for (const file of Object.values(runtimeBundles)) {
        if (fs.existsSync(file)) continue;
        this.warn(
          `${path.relative(repoRoot, file)} is missing — run \`pnpm --filter @helaengine/engine build\` or exports will fail.`,
        );
      }
    },

    // Vite only copies its own `publicDir`, so the shared asset directory is emitted here.
    closeBundle() {
      if (!fs.existsSync(generatedAssetsDir)) return;
      const outDir = path.resolve(config.root, config.build.outDir);
      fs.cpSync(generatedAssetsDir, path.join(outDir, 'assets'), { recursive: true });
      for (const [route, file] of Object.entries(runtimeBundles)) {
        if (fs.existsSync(file)) fs.copyFileSync(file, path.join(outDir, route.slice(1)));
      }
    },
  };
}
