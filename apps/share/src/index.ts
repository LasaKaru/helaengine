import { createShareServer } from './server.js';
import { ShareStore } from './store.js';

/**
 * `pnpm --filter @helaengine/share start`
 *
 * A separate deployable service from the co-op server and from the API, for the same reason those
 * are separate from each other: different workload. This one is mostly static bytes and one write.
 */
const port = Number(process.env['SHARE_PORT'] ?? 4000);
const root = process.env['SHARE_ROOT'] ?? '.hela-shared';

const store = new ShareStore({
  root,
  ...(process.env['SHARE_ORG_TOKEN'] ? { orgToken: process.env['SHARE_ORG_TOKEN'] } : {}),
});

const server = createShareServer({
  store,
  ...(process.env['SHARE_PUBLIC_ORIGIN']
    ? { publicOrigin: process.env['SHARE_PUBLIC_ORIGIN'] }
    : {}),
});

server.listen(port, () => {
  console.log(`[share] listening on http://localhost:${port}, storing builds in ${root}`);
  if (!process.env['SHARE_ORG_TOKEN']) {
    console.log('[share] SHARE_ORG_TOKEN is not set, so org-only sharing will be refused');
  }
});
