import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { Db } from './db.js';
import { Forbidden, NotFound } from './roles.js';

/**
 * Assets that belong to somebody.
 *
 * The curated library ships with the product and has no owner. This is the other kind: a `.glb` a
 * customer uploaded, private to their organisation, processed the same way the built-in ones were,
 * and placeable in a scene exactly like them.
 *
 * **There is no S3 and no CDN here, and that is a deployment decision rather than a missing
 * feature.** What this implements is the shape both need: a short-lived signed upload ticket so
 * bytes never travel through the API's request path twice, content-addressed storage so a URL can
 * be cached forever, and a processing state in the database so a page refresh does not lose it.
 * Swapping in R2 means replacing `putObject`/`objectPath` with the SDK's equivalents and handing
 * out the provider's presigned URL instead of this one — the callers do not move.
 */

export interface AssetStorage {
  /** Writes bytes and returns the path they can be read back from. */
  put(key: string, bytes: Uint8Array): string;
  read(key: string): Uint8Array | null;
}

/** Files on a disk this process owns. The local stand-in for object storage. */
export class LocalAssetStorage implements AssetStorage {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
    mkdirSync(this.#root, { recursive: true });
  }

  put(key: string, bytes: Uint8Array): string {
    const target = join(this.#root, key);
    if (!target.startsWith(this.#root)) throw new Error('that key would escape the asset store');
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    return key;
  }

  read(key: string): Uint8Array | null {
    const target = join(this.#root, key);
    if (!target.startsWith(this.#root) || !existsSync(target)) return null;
    return readFileSync(target);
  }
}

/**
 * How long an upload ticket is good for.
 *
 * Five minutes. Long enough to send a file over a poor connection, short enough that a ticket
 * found in a log tomorrow is worth nothing. Signed rather than stored, so issuing one costs no
 * write and a flood of abandoned uploads leaves no rows behind.
 */
export const TICKET_LIFETIME_MS = 5 * 60 * 1000;

/** Bigger than any low-poly asset has any business being, and still a limit. */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

export interface UploadTicket {
  assetId: string;
  organizationId: string;
  expiresAt: number;
  signature: string;
}

/**
 * Signs an upload ticket.
 *
 * HMAC over the fields, with a secret the server holds. The alternative — a row per pending
 * upload — means a database write for every ticket including the ones nobody uses, and a cleanup
 * job for the rest. A signature needs neither, and cannot be forged without the secret.
 *
 * `createHmac` rather than hashing `secret + payload`: SHA-256 is a Merkle–Damgård construction, so
 * a secret-prefixed digest can be extended by somebody holding one valid signature and no secret at
 * all. HMAC is the construction that closes that, and it costs the same.
 */
export function signTicket(secret: string, ticket: Omit<UploadTicket, 'signature'>): UploadTicket {
  const payload = `${ticket.organizationId}:${ticket.assetId}:${ticket.expiresAt}`;
  return { ...ticket, signature: createHmac('sha256', secret).update(payload).digest('hex') };
}

/** The presigned URL a browser PUTs to. Same shape S3 and R2 hand out, same fields in the query. */
export function uploadUrl(ticket: UploadTicket): string {
  return (
    `/uploads/${ticket.organizationId}/${ticket.assetId}` +
    `?expires=${ticket.expiresAt}&signature=${ticket.signature}`
  );
}

export function verifyTicket(secret: string, ticket: UploadTicket): void {
  if (ticket.expiresAt < Date.now()) throw new Forbidden('that upload link has expired');

  const expected = signTicket(secret, {
    assetId: ticket.assetId,
    organizationId: ticket.organizationId,
    expiresAt: ticket.expiresAt,
  }).signature;

  const left = Buffer.from(expected, 'hex');
  const right = Buffer.from(ticket.signature ?? '', 'hex');
  // Constant-time, and length-checked first because `timingSafeEqual` throws on a mismatch rather
  // than returning false — an exception that would itself be a signal.
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    throw new Forbidden('that upload link is not valid');
  }
}

export function newUploadSecret(): string {
  return randomBytes(32).toString('hex');
}

export interface AssetRow {
  id: string;
  organizationId: string | null;
  assetId: string;
  name: string;
  category: string;
  glbPath: string | null;
  thumbnailPath: string | null;
  polyCount: number | null;
  status: 'pending' | 'ready' | 'failed';
  failure: string | null;
  sizeBytes: number | null;
  createdAt: string;
}

/** Reserves the row an upload will fill, so the UI has something to show a spinner against. */
export async function beginUpload(
  db: Db,
  input: {
    organizationId: string;
    assetId: string;
    name: string;
    category: string;
    userId: string;
  },
): Promise<AssetRow> {
  const created = await db.query<{ id: string; created_at: Date }>(
    `insert into assets (organization_id, asset_id, name, category, uploaded_by, status)
     values ($1, $2, $3, $4, $5, 'pending')
     on conflict (organization_id, asset_id) where organization_id is not null
     do update set name = excluded.name, category = excluded.category,
                   status = 'pending', failure = null, updated_at = now()
     returning id, created_at`,
    [input.organizationId, input.assetId, input.name, input.category, input.userId],
  );

  return {
    id: created.rows[0]!.id,
    organizationId: input.organizationId,
    assetId: input.assetId,
    name: input.name,
    category: input.category,
    glbPath: null,
    thumbnailPath: null,
    polyCount: null,
    status: 'pending',
    failure: null,
    sizeBytes: null,
    createdAt: created.rows[0]!.created_at.toISOString(),
  };
}

/**
 * Stores the bytes and marks the asset ready.
 *
 * The path is content-addressed — `orgs/{id}/assets/{hash}.glb` — so the URL for a given set of
 * bytes never changes and can be cached forever, and changed bytes get a new URL rather than a
 * stale one somebody has to purge. That is the whole reason a CDN in front of this needs no
 * invalidation strategy.
 */
export async function completeUpload(
  db: Db,
  storage: AssetStorage,
  input: { organizationId: string; assetId: string; bytes: Uint8Array },
): Promise<AssetRow> {
  if (input.bytes.byteLength === 0) {
    return failUpload(db, input, 'that file was empty');
  }
  if (input.bytes.byteLength > MAX_ASSET_BYTES) {
    return failUpload(db, input, 'that file is larger than 25 MB');
  }
  // The four magic bytes of a binary glTF. Checked because "it has a .glb extension" is a claim
  // the uploader makes and this is a fact about the bytes.
  const magic = Buffer.from(input.bytes.subarray(0, 4)).toString('ascii');
  if (magic !== 'glTF') {
    return failUpload(db, input, 'that file is not a binary glTF (.glb)');
  }

  const hash = createHash('sha256').update(input.bytes).digest('hex').slice(0, 32);
  const glbPath = storage.put(`orgs/${input.organizationId}/assets/${hash}.glb`, input.bytes);

  const updated = await db.query<{ id: string; created_at: Date; name: string; category: string }>(
    `update assets
        set glb_path = $3, content_hash = $4, size_bytes = $5, status = 'ready',
            failure = null, updated_at = now()
      where organization_id = $1 and asset_id = $2
      returning id, created_at, name, category`,
    [input.organizationId, input.assetId, glbPath, hash, input.bytes.byteLength],
  );

  const row = updated.rows[0];
  if (!row) throw new NotFound('no such asset');

  return {
    id: row.id,
    organizationId: input.organizationId,
    assetId: input.assetId,
    name: row.name,
    category: row.category,
    glbPath,
    thumbnailPath: null,
    polyCount: null,
    status: 'ready',
    failure: null,
    sizeBytes: input.bytes.byteLength,
    createdAt: row.created_at.toISOString(),
  };
}

async function failUpload(
  db: Db,
  input: { organizationId: string; assetId: string },
  reason: string,
): Promise<AssetRow> {
  // Recorded rather than thrown away: the upload UI shows this sentence, and "processing failed"
  // with no reason is the kind of message that generates support tickets instead of fixes.
  const updated = await db.query<{
    id: string;
    name: string;
    category: string;
    created_at: Date;
  }>(
    `update assets set status = 'failed', failure = $3, updated_at = now()
      where organization_id = $1 and asset_id = $2
      returning id, name, category, created_at`,
    [input.organizationId, input.assetId, reason],
  );

  const row = updated.rows[0];
  if (!row) throw new NotFound('no such asset');

  return {
    id: row.id,
    organizationId: input.organizationId,
    assetId: input.assetId,
    name: row.name,
    category: row.category,
    glbPath: null,
    thumbnailPath: null,
    polyCount: null,
    status: 'failed',
    failure: reason,
    sizeBytes: null,
    createdAt: row.created_at.toISOString(),
  };
}

/**
 * Everything an organisation can place: the curated library plus its own.
 *
 * One query over one table. Two tables would make this a union, and a union is the shape that
 * drifts — the day somebody adds a column to one side, the library panel starts showing two
 * different kinds of asset with two different sets of fields.
 */
export async function listAssets(
  db: Db,
  organizationId: string,
  options: { category?: string; includePending?: boolean } = {},
): Promise<AssetRow[]> {
  const rows = await db.query<{
    id: string;
    organization_id: string | null;
    asset_id: string;
    name: string;
    category: string;
    glb_path: string | null;
    thumbnail_path: string | null;
    poly_count: number | null;
    status: 'pending' | 'ready' | 'failed';
    failure: string | null;
    size_bytes: number | null;
    created_at: Date;
  }>(
    `select id, organization_id, asset_id, name, category, glb_path, thumbnail_path,
            poly_count, status, failure, size_bytes, created_at
       from assets
      where (organization_id is null or organization_id = $1)
        and ($2::text is null or category = $2)
        and (status = 'ready' or ($3 and organization_id = $1))
      order by organization_id nulls first, category, name`,
    [organizationId, options.category ?? null, options.includePending ?? false],
  );

  return rows.rows.map((row) => ({
    id: row.id,
    organizationId: row.organization_id,
    assetId: row.asset_id,
    name: row.name,
    category: row.category,
    glbPath: row.glb_path,
    thumbnailPath: row.thumbnail_path,
    polyCount: row.poly_count,
    status: row.status,
    failure: row.failure,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function deleteAsset(db: Db, organizationId: string, assetId: string): Promise<void> {
  // Scoped to the organisation in the `where`, not checked beforehand: a delete that finds nothing
  // is a delete that did nothing, which is the correct outcome for somebody else's asset.
  const removed = await db.query(
    'delete from assets where organization_id = $1 and asset_id = $2',
    [organizationId, assetId],
  );
  if (!removed.rowCount) throw new NotFound('no such asset');
}
