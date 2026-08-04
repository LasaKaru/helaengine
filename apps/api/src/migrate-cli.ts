import { createPool, migrate } from './db.js';

const db = createPool();
const applied = await migrate(db);
console.log(
  applied.length === 0 ? '[api] schema is up to date' : `[api] applied ${applied.join(', ')}`,
);
await db.end();
