import { createPool, migrate } from './db.js';
import { createApiServer } from './server.js';

const port = Number(process.env['API_PORT'] ?? 3000);
const db = createPool();

const applied = await migrate(db);
if (applied.length > 0) console.log(`[api] applied ${applied.join(', ')}`);

createApiServer({ db }).listen(port, () => {
  console.log(`[api] listening on http://localhost:${port}`);
});
