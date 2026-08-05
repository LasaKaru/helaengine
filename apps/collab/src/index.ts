import { createCollabServer } from './server.js';
import { createPool, DbAuthorizer, DbRoomStore } from './store.js';

/**
 * The collaboration server.
 *
 *   pnpm --filter @helaengine/collab-server start
 *
 * A third deployable service. See `server.ts` for why it is not a route on the API, and `store.ts`
 * for why it talks to the database directly rather than through one.
 */

const port = Number(process.env['COLLAB_PORT'] ?? 3200);
const db = createPool();

const { server, rooms } = createCollabServer({
  store: new DbRoomStore(db),
  auth: new DbAuthorizer(db),
});

server.listen(port, () => {
  console.log(`[collab] listening on ws://localhost:${port}`);
});

/**
 * Flush open rooms before the process goes away.
 *
 * Without this, a deploy during an editing session throws away everything since the last debounced
 * save. With it, a restart costs a reconnect. `once`, because a second signal while the first flush
 * is in flight should not start a second one.
 */
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void (async () => {
      await rooms.saveAll();
      await db.end();
      process.exit(0);
    })();
  });
}
