import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Postgres, with hand-written SQL migrations and no ORM.
 *
 * A deliberate departure from `DEVELOPMENT-PLAN.md`, which names NestJS and Prisma, and worth
 * stating rather than sliding past:
 *
 * - **Types already come from Zod.** `@helaengine/schema` is the single source of truth for every
 *   shape in this product, and Prisma would introduce a second generator producing a second set of
 *   types for the same concepts. One of them would drift.
 * - **The rest of this codebase is plain.** Two services already run on `node:http` because five
 *   routes do not need a framework's opinion about which handler owns a request. NestJS's
 *   decorators and dependency injection would be the only such pattern here.
 * - **A migration you can read is a migration you can review.** `001_accounts.sql` says exactly
 *   what it does, including why each index and constraint exists.
 *
 * What that costs, honestly: no generated client, so queries are strings and their result shapes
 * are asserted rather than inferred; and no `prisma migrate` workflow, so the runner below is the
 * whole of the tooling. If this grows past a few dozen tables, revisit it — that is the point at
 * which an ORM starts paying for itself rather than the point at which it is fashionable.
 */

const HERE = dirname(fileURLToPath(import.meta.url));

export type Db = pg.Pool;

export function createPool(connectionString?: string): Db {
  return new pg.Pool({
    connectionString:
      connectionString ??
      process.env['DATABASE_URL'] ??
      'postgres://hela@localhost:5432/helaengine',
    // Small: this is one process, and a pool larger than the database's connection limit is a
    // failure that only appears under the load it was meant to survive.
    max: 10,
  });
}

/**
 * Applies every migration that has not been applied, in filename order.
 *
 * Recorded in a table rather than tracked by hand, and each file runs inside a transaction with
 * the record of it — so a migration that fails halfway leaves nothing behind, including no claim
 * to have run.
 */
export async function migrate(db: Db): Promise<string[]> {
  await db.query(`
    create table if not exists schema_migrations (
      name       text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const applied = new Set(
    (await db.query<{ name: string }>('select name from schema_migrations')).rows.map(
      (row) => row.name,
    ),
  );

  const folder = join(HERE, 'migrations');
  const pending = readdirSync(folder)
    .filter((name) => name.endsWith('.sql') && !applied.has(name))
    .sort();

  for (const name of pending) {
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query(readFileSync(join(folder, name), 'utf8'));
      await client.query('insert into schema_migrations (name) values ($1)', [name]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw new Error(`migration ${name} failed: ${String(error)}`);
    } finally {
      client.release();
    }
  }

  return pending;
}

/** Drops everything this schema owns. Used by tests, never by the running service. */
export async function reset(db: Db): Promise<void> {
  await db.query('drop schema public cascade; create schema public;');
}
