/**
 * The co-op server.
 *
 * Its own deployable service rather than a route on the API, and that is a workload argument rather
 * than a fashion for microservices: this process holds thousands of open sockets and runs a fixed
 * physics tick, while the API answers short bursty HTTP requests. They scale on different axes, they
 * fail in different ways, and a slow database query has no business stalling a simulation tick.
 *
 *   pnpm --filter @helaengine/realtime start
 */
import http from 'node:http';
import colyseus from 'colyseus';
import { CoopRoom } from './CoopRoom.js';

const port = Number(process.env['PORT'] ?? 2567);

/**
 * Plain `node:http`, since Sprint 34.
 *
 * This was Express, for one health route and two CORS headers. It came with a `path-to-regexp`
 * advisory (ReDoS through route parameters — of which this server has none, so the exposure was
 * theoretical) and, more to the point, with a router this service does not use: matchmaking happens
 * over the WebSocket transport, not over HTTP. Removing it takes a dependency and its advisory out
 * of a *deployed* service and leaves fifteen lines that do exactly what the framework was doing.
 *
 * The same argument `db.ts` makes about NestJS, applied to the smallest surface in the repo.
 */
const requests = http.createServer((request, response) => {
  /**
   * Permissive CORS, deliberately and temporarily.
   *
   * An exported build is served from wherever its author put it, so the co-op server cannot know
   * the origins it will be called from. Tying this to a project's allowlist is Sprint 27's hosted
   * play; until there are projects to tie it to, a narrower rule would be a guess.
   */
  response.setHeader('access-control-allow-origin', '*');
  response.setHeader('access-control-allow-headers', 'content-type');

  if (request.method === 'OPTIONS') return void response.writeHead(204).end();

  if (request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, service: 'helaengine-realtime' }));
    return;
  }

  // Everything else is either a WebSocket upgrade — which never reaches this handler — or nothing.
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'no such endpoint' }));
});

const server = new colyseus.Server({ server: requests });
server.define('coop', CoopRoom);

await server.listen(port);
// A server that starts silently is a server nobody can tell has started. The lint rule is right
// about application code and wrong about an entry point whose whole job is to say it is up — which
// is now expressed in eslint.config.js rather than as a suppression here.
console.log(`[helaengine] co-op server listening on ws://localhost:${port}`);
