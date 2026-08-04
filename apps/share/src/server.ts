import { createReadStream } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { ZodError } from 'zod';
import { PublishRequestSchema, type PublishResponse } from '@helaengine/schema';
import { RejectedBuild, type ShareStore } from './store.js';

/**
 * The share service.
 *
 * Plain `node:http`, like the co-op server's listener and for the same reason learned there in
 * Sprint 20: a framework in front of this would add a routing layer to five routes and a second
 * opinion about which handler owns a request. There is nothing here a framework would make shorter.
 *
 * Routes:
 *   POST /api/builds          publish a validated build
 *   GET  /api/builds          list the public ones
 *   GET  /api/builds/:id      one build's metadata and play count
 *   GET  /play/:id/*          the build itself
 *   GET  /health
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

/** Uploads are a scene, its assets and a 3 MB engine bundle. Generous, and still a limit. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

export interface ShareServerOptions {
  store: ShareStore;
  /** Used to build the link that goes in a message. */
  publicOrigin?: string;
}

export function createShareServer(options: ShareServerOptions): Server {
  const { store } = options;

  return createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      if (error instanceof RejectedBuild) {
        send(response, error.status, { error: error.message });
        return;
      }
      // A request that does not match the schema is the caller's mistake, and saying "500" about it
      // tells them to retry something that will never work. The message is the first Zod issue,
      // which names the field — enough to fix it, and nothing about this server's internals.
      if (error instanceof ZodError) {
        const first = error.errors[0];
        send(response, 400, {
          error: first
            ? `${first.path.join('.') || 'request'}: ${first.message}`
            : 'invalid request',
        });
        return;
      }
      if (error instanceof SyntaxError) {
        send(response, 400, { error: 'the request body was not valid JSON' });
        return;
      }
      // Logged with detail, returned without: the client gets a sentence, the operator gets a stack.
      console.error('[share] request failed', error);
      send(response, 500, { error: 'the share service failed to handle this request' });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const token = header(request, 'x-hela-org-token');

    /**
     * Cross-origin, and open.
     *
     * The editor runs on one port and this runs on another, so every publish is a cross-origin
     * request — which the first version of this did not answer, and the editor duly reported the
     * service as unreachable when it was running perfectly.
     *
     * `*` rather than an allowlist, and that is a considered choice rather than a shortcut: nothing
     * here is protected by origin. There are no cookies and no session, so a browser never attaches
     * ambient authority to one of these requests; a build is protected by its id being unguessable
     * and an org build by a token the caller has to type. An origin allowlist would add a setting
     * to get wrong without adding a defence. The day this grows real sessions, this comment is the
     * one to come back to.
     */
    response.setHeader('access-control-allow-origin', '*');
    response.setHeader('access-control-allow-headers', 'content-type, x-hela-org-token');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');

    // A JSON POST with a custom header is preflighted, so this has to answer before anything else.
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }

    if (path === '/health') return send(response, 200, { ok: true });

    if (path === '/api/builds' && request.method === 'POST') {
      const body = PublishRequestSchema.parse(JSON.parse(await readBody(request)));
      const build = store.publish(body);
      const origin = options.publicOrigin ?? `http://${request.headers.host ?? 'localhost'}`;
      const payload: PublishResponse = { build, url: `${origin}/play/${build.id}/` };
      return send(response, 201, payload);
    }

    if (path === '/api/builds' && request.method === 'GET') {
      return send(response, 200, { builds: store.list() });
    }

    const metaMatch = /^\/api\/builds\/([^/]+)$/.exec(path);
    if (metaMatch && request.method === 'GET') {
      const build = store.get(metaMatch[1]!);
      // The same answer for "does not exist" and "you may not see it". Distinguishing them would
      // turn this endpoint into an oracle for which org builds are real.
      if (!build || !store.mayRead(build, token)) {
        return send(response, 404, { error: 'no such build' });
      }
      return send(response, 200, { build });
    }

    const playMatch = /^\/play\/([^/]+)(\/.*)?$/.exec(path);
    if (playMatch && request.method === 'GET') {
      const id = playMatch[1]!;
      const rest = playMatch[2] ?? '/';
      const build = store.get(id);
      if (!build || !store.mayRead(build, token)) {
        return send(response, 404, { error: 'no such build' });
      }

      const file = store.fileFor(id, rest);
      if (!file) return send(response, 404, { error: 'no such file in this build' });

      // Counted when the page is served, not when an asset is — otherwise "plays" is really
      // "requests", and a build with more models would look more popular.
      if (rest === '/' || rest.endsWith('/index.html')) store.recordPlay(id);

      response.writeHead(200, {
        'content-type': MIME[extname(file)] ?? 'application/octet-stream',
        // Never cached by a shared cache: an unlisted build's URL is its only protection, and a
        // proxy holding a copy is a copy nobody can withdraw.
        'cache-control':
          build.visibility === 'public' ? 'public, max-age=300' : 'private, no-store',
      });
      createReadStream(file).pipe(response);
      return;
    }

    send(response, 404, { error: 'no such endpoint' });
  }
}

function header(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === 'string' ? value : null;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    // Checked as it arrives rather than after: a limit enforced once the whole body is in memory
    // is not a limit, it is a description of what already happened.
    if (total > MAX_UPLOAD_BYTES) throw new RejectedBuild('this build is too large to share', 413);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}
