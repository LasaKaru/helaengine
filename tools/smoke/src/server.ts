import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

/**
 * Content types a real static host would use.
 *
 * `.wasm` is the one that matters. Browsers refuse to compile a WebAssembly module served as
 * `application/octet-stream`, and the symptom is a world where every model is a grey box — which
 * is precisely the hosting failure the `physics-initialises` and `assets-resolve` checks exist to
 * catch. Serving it correctly here is the point: the harness must be a *good* host, so that a
 * failure means the build is broken rather than the test rig is.
 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.wasm': 'application/wasm',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

export interface StagingSite {
  origin: string;
  close(): Promise<void>;
}

/**
 * Serves a staged build over HTTP on a loopback port.
 *
 * "Staged" is not decoration. A build under test has never been proved to work, so it is served
 * from a private path on an ephemeral port and never from anywhere a user could reach — that is
 * the whole shape of the gate, and it is why this is a server the harness owns rather than a
 * directory handed to a public one.
 */
export async function serveStaging(root: string): Promise<StagingSite> {
  const base = resolve(root);

  const server: Server = createServer((request, response) => {
    const path = (request.url ?? '/').split('?')[0] ?? '/';
    const decoded = decodeURIComponent(path === '/' ? '/index.html' : path);
    const target = join(base, normalize(decoded));

    // `normalize` collapses `..` but does not stop the result escaping — a request for
    // `/../../etc/passwd` normalises to a real path outside the build. The prefix check does.
    if (!target.startsWith(base) || !existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }

    response.writeHead(200, {
      'content-type': MIME[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    createReadStream(target).pipe(response);
  });

  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as { port: number };

  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
