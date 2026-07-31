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
import express from 'express';
import colyseus from 'colyseus';
import { CoopRoom } from './CoopRoom.js';

const port = Number(process.env['PORT'] ?? 2567);
const app = express();
app.use(express.json({ limit: '8mb' }));

/**
 * Permissive CORS, deliberately and temporarily.
 *
 * An exported build is served from wherever its author put it, so the co-op server cannot know the
 * origins it will be called from. Sprint 27's hosted play is where this becomes an allowlist tied
 * to a project; until there are projects to tie it to, a narrower rule would be a guess.
 */
app.use((_request, response, next) => {
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader('Access-Control-Allow-Headers', 'content-type');
  next();
});

app.get('/health', (_request, response) => {
  response.json({ ok: true, service: 'helaengine-realtime' });
});

const server = new colyseus.Server({ server: http.createServer(app) });
server.define('coop', CoopRoom);

await server.listen(port);
// A server that starts silently is a server nobody can tell has started. The lint rule is right
// about application code and wrong about an entry point whose whole job is to say it is up.
// eslint-disable-next-line no-console
console.log(`[helaengine] co-op server listening on ws://localhost:${port}`);
