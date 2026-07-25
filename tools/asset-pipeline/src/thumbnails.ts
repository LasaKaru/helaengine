import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { pipelineRoot } from './paths.js';

export interface ThumbnailOptions {
  size?: number;
  /** Chromium binary path. Defaults to Playwright's own resolution. */
  executablePath?: string;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
};

/**
 * Renders asset thumbnails by driving a headless Chromium at a tiny local render page.
 *
 * Rendering GLBs in-process would mean a software WebGL context in Node (`gl`, `node-canvas`),
 * which needs native builds and drifts from what the editor actually shows. A headless browser
 * runs the very same Three.js code path the user sees, which is rather the point of a thumbnail.
 *
 * Thumbnails are rendered from the **raw source** GLB rather than the Draco-compressed output:
 * the geometry is the same either way, and it keeps the decoder out of the render page.
 */
export class ThumbnailRenderer {
  #browser: Browser | null = null;
  #server: http.Server | null = null;
  #origin = '';
  #currentGlb: string | null = null;

  readonly #size: number;
  readonly #executablePath: string | undefined;

  constructor(options: ThumbnailOptions = {}) {
    this.#size = options.size ?? 256;
    this.#executablePath = options.executablePath ?? process.env['CHROMIUM_PATH'];
  }

  async open(): Promise<void> {
    await this.#startServer();
    this.#browser = await chromium.launch({
      ...(this.#executablePath ? { executablePath: this.#executablePath } : {}),
      args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
    });
  }

  async render(glbPath: string, outputPath: string): Promise<void> {
    if (!this.#browser) throw new Error('ThumbnailRenderer.open() must be called first');
    this.#currentGlb = glbPath;

    const page = await this.#browser.newPage({
      viewport: { width: this.#size, height: this.#size },
      deviceScaleFactor: 2,
    });

    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    try {
      await page.goto(`${this.#origin}/`, { waitUntil: 'load' });
      await page.waitForFunction(
        () => (window as unknown as { assetReady?: boolean }).assetReady === true,
        undefined,
        { timeout: 30_000 },
      );

      if (errors.length > 0) throw new Error(errors.join('; '));

      await fs.mkdir(path.dirname(outputPath), { recursive: true });
      await page.screenshot({ path: outputPath, omitBackground: true });
    } catch (error) {
      const detail = errors.length > 0 ? ` (${errors.join('; ')})` : '';
      throw new Error(`thumbnail render failed for ${path.basename(glbPath)}${detail}`, {
        cause: error,
      });
    } finally {
      await page.close();
    }
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = null;
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
    this.#server = null;
  }

  /**
   * Serves three.js and the current asset over HTTP. A `file://` page cannot import bare module
   * specifiers or fetch sibling files without loosening Chromium's security flags, so a
   * throwaway localhost server is both simpler and safer.
   */
  async #startServer(): Promise<void> {
    const server = http.createServer((request, response) => {
      void this.#handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });

    const address = server.address();
    if (typeof address === 'string' || address === null) {
      throw new Error('failed to bind thumbnail render server');
    }
    this.#server = server;
    this.#origin = `http://127.0.0.1:${address.port}`;
  }

  async #handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? '/', this.#origin);

    try {
      if (url.pathname === '/') {
        response.writeHead(200, { 'content-type': MIME_TYPES['.html']! });
        response.end(renderPageHtml());
        return;
      }

      if (url.pathname === '/asset.glb') {
        if (!this.#currentGlb) throw Object.assign(new Error('no asset'), { code: 'ENOENT' });
        response.writeHead(200, { 'content-type': MIME_TYPES['.glb']! });
        response.end(await fs.readFile(this.#currentGlb));
        return;
      }

      if (url.pathname.startsWith('/node_modules/')) {
        // Resolved against the pipeline package so pnpm's symlinked tree is followed correctly.
        const filePath = path.join(pipelineRoot, url.pathname);
        const body = await fs.readFile(filePath);
        const type = MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream';
        response.writeHead(200, { 'content-type': type });
        response.end(body);
        return;
      }

      response.writeHead(404).end('not found');
    } catch {
      response.writeHead(404).end('not found');
    }
  }
}

function renderPageHtml(): string {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; }
      canvas { display: block; }
    </style>
    <script type="importmap">
      {
        "imports": {
          "three": "/node_modules/three/build/three.module.js",
          "three/addons/": "/node_modules/three/examples/jsm/"
        }
      }
    </script>
  </head>
  <body>
    <script type="module">
      import * as THREE from 'three';
      import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(window.devicePixelRatio);
      renderer.setSize(window.innerWidth, window.innerHeight);
      renderer.shadowMap.enabled = true;
      document.body.appendChild(renderer.domElement);

      const scene = new THREE.Scene();
      scene.add(new THREE.AmbientLight(0xffffff, 1.5));
      const key = new THREE.DirectionalLight(0xfff4e0, 2.6);
      key.position.set(4, 7, 6);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xbcd4ff, 0.9);
      fill.position.set(-5, 2, -4);
      scene.add(fill);

      const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);

      const gltf = await new GLTFLoader().loadAsync('/asset.glb');
      const model = gltf.scene;
      scene.add(model);

      // Frame the asset from a consistent three-quarter angle so the library reads as one set.
      const box = new THREE.Box3().setFromObject(model);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      const distance = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(35) / 2)) * 1.15;
      const direction = new THREE.Vector3(0.62, 0.45, 1).normalize();
      camera.position.copy(sphere.center).addScaledVector(direction, distance);
      camera.lookAt(sphere.center);

      renderer.render(scene, camera);
      window.assetReady = true;
    </script>
  </body>
</html>`;
}
