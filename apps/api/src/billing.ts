import {
  entitledTier,
  limitMessage,
  PLAN_LIMITS,
  planThatAllows,
  QUOTA_PERIOD_MS,
  type LimitExceeded,
  type LimitKind,
  type PlanLimits,
  type PlanTier,
  type Subscription,
  type SubscriptionStatus,
} from '@helaengine/schema';
import type { Db } from './db.js';

/**
 * Subscriptions and metering.
 *
 * The design decision worth defending is that **usage is derived, not counted**. Exports come from
 * `export_jobs`, storage from `assets`, seats from `memberships` — every meter is a query against
 * the table that already holds the truth, rather than a counter this module maintains alongside it.
 *
 * A counter is faster and it is wrong eventually: a deleted project, a failed upload, a rolled-back
 * transaction, a webhook processed twice, and now the number a user sees disagrees with what the
 * API enforces. The way somebody finds out is being refused an export the meter said they had,
 * which is the single most expensive kind of billing bug because it looks like theft.
 *
 * The cost is that each meter is a query rather than a column read. `usage_snapshots` exists for
 * the case derivation cannot serve — history, where "what did they use in March" has to survive the
 * project being deleted in April.
 */

interface SubscriptionRow {
  organization_id: string;
  tier: PlanTier;
  status: SubscriptionStatus;
  external_id: string | null;
  external_customer: string | null;
  current_period_end: Date | null;
  cancel_at: Date | null;
  updated_at: Date;
}

function toSubscription(row: SubscriptionRow): Subscription {
  return {
    organizationId: row.organization_id,
    tier: row.tier,
    status: row.status,
    externalId: row.external_id,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    cancelAt: row.cancel_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * An organisation's subscription, inventing the free one when there is no row.
 *
 * Lazy rather than created with the organisation: the overwhelming majority of rows would say
 * "free, none, null, null" for ever, and a table that is mostly defaults is a table that costs a
 * write per signup to tell you nothing.
 */
export async function loadSubscription(db: Db, organizationId: string): Promise<Subscription> {
  const found = await db.query<SubscriptionRow>(
    `select organization_id, tier, status, external_id, external_customer, current_period_end,
            cancel_at, updated_at
       from subscriptions where organization_id = $1`,
    [organizationId],
  );

  const row = found.rows[0];
  if (row) return toSubscription(row);

  /**
   * No subscription row: fall back to the column an operator sets by hand.
   *
   * Sprint 32 put `plan_tier` on `organizations` and enforced a quota against it, with no way to
   * change it but SQL. That is still exactly right for a self-hosted install, which has nobody to
   * bill and an administrator who knows what they want — so rather than orphan the column, it
   * becomes the answer when no subscription exists.
   *
   * The precedence matters and is deliberate: a subscription **wins**. Otherwise an operator's
   * stale hand-set column could silently override what a customer is paying for, and the way you
   * would find out is somebody being refused something they bought.
   */
  const manual = await db.query<{ plan_tier: PlanTier }>(
    'select plan_tier from organizations where id = $1',
    [organizationId],
  );
  const tier = manual.rows[0]?.plan_tier ?? 'free';

  return {
    organizationId,
    tier,
    // `none` for free, so `entitledTier` agrees either way; `active` for anything an operator has
    // deliberately set, because from the product's side that is exactly what it is.
    status: tier === 'free' ? 'none' : 'active',
    externalId: null,
    currentPeriodEnd: null,
    cancelAt: null,
    updatedAt: new Date().toISOString(),
  };
}

/** What this organisation may do right now. The one function every guard goes through. */
export async function limitsOf(db: Db, organizationId: string): Promise<PlanLimits> {
  return PLAN_LIMITS[entitledTier(await loadSubscription(db, organizationId))];
}

export interface UsageTotals {
  seats: number;
  storageBytes: number;
  exports: number;
}

/**
 * What has been used this period, counted from the tables that hold it.
 *
 * One round trip rather than three: these three numbers are always wanted together — by the billing
 * screen, by the snapshot job, and by any guard that wants to say "7 of 10" in its refusal.
 */
export async function usageOf(db: Db, organizationId: string): Promise<UsageTotals> {
  const since = new Date(Date.now() - QUOTA_PERIOD_MS);

  const counted = await db.query<{ seats: string; storage_bytes: string; exports: string }>(
    `select
       (select count(*) from memberships where organization_id = $1)::text as seats,
       (select coalesce(sum(size_bytes), 0) from assets
          where organization_id = $1 and status = 'ready')::text as storage_bytes,
       (select count(*) from export_jobs
          where organization_id = $1 and created_at >= $2)::text as exports`,
    [organizationId, since],
  );

  const row = counted.rows[0]!;
  return {
    seats: Number(row.seats),
    // `bigint` from `sum`, because a storage total can exceed what a 32-bit integer holds long
    // before an organisation is unusual.
    storageBytes: Number(row.storage_bytes),
    exports: Number(row.exports),
  };
}

/**
 * A limit that has been reached, as data.
 *
 * Thrown rather than returned so a guard is one line at a call site, and carrying `status = 402`
 * rather than 403. That distinction is the whole point of this sprint: 403 means "you may not",
 * which is a wall; 402 Payment Required means "not on this plan", which is a door. The editor keys
 * its upgrade screen off it.
 */
export class LimitReached extends Error {
  readonly status = 402;
  readonly detail: LimitExceeded;

  constructor(detail: LimitExceeded) {
    super(detail.error);
    this.detail = detail;
  }
}

function refuse(kind: LimitKind, tier: PlanTier, limit: number, used: number): never {
  const upgradeTo = planThatAllows(kind, Math.max(used, limit + 1), tier);
  throw new LimitReached({
    error: limitMessage(kind, tier, upgradeTo),
    kind,
    tier,
    limit,
    used,
    upgradeTo,
  });
}

/**
 * The guards.
 *
 * Each one takes what is about to happen rather than what has already happened — `requireSeat` is
 * called before an invite is written, not after — because a limit enforced after the fact is a
 * limit that has already been exceeded.
 */
export async function requireSeat(db: Db, organizationId: string): Promise<void> {
  const subscription = await loadSubscription(db, organizationId);
  const tier = entitledTier(subscription);
  const limits = PLAN_LIMITS[tier];

  /**
   * Members plus outstanding invitations.
   *
   * Counting only members lets an organisation on a one-seat plan send fifty invitations and have
   * fifty people accept, each acceptance individually within the limit at the moment it is checked.
   * An invitation is a seat that has been promised.
   */
  const counted = await db.query<{ taken: string }>(
    `select (
       (select count(*) from memberships where organization_id = $1) +
       (select count(*) from invites
          where organization_id = $1 and accepted_at is null and expires_at > now())
     )::text as taken`,
    [organizationId],
  );
  const taken = Number(counted.rows[0]!.taken);

  if (taken >= limits.seats) refuse('seats', tier, limits.seats, taken + 1);
}

export async function requireCustomAssets(db: Db, organizationId: string): Promise<void> {
  const tier = entitledTier(await loadSubscription(db, organizationId));
  if (!PLAN_LIMITS[tier].customAssets) refuse('customAssets', tier, 0, 1);
}

export async function requireStorage(
  db: Db,
  organizationId: string,
  additionalBytes: number,
): Promise<void> {
  const tier = entitledTier(await loadSubscription(db, organizationId));
  const limits = PLAN_LIMITS[tier];
  const { storageBytes } = await usageOf(db, organizationId);

  if (storageBytes + additionalBytes > limits.storageBytes) {
    refuse('storage', tier, limits.storageBytes, storageBytes + additionalBytes);
  }
}

/**
 * Writes the subscription a provider told us about.
 *
 * Upsert rather than update, because the first thing a new customer's webhook does is describe a
 * subscription for an organisation that has no row yet.
 */
export async function applySubscription(
  db: Db,
  input: {
    organizationId: string;
    tier: PlanTier;
    status: SubscriptionStatus;
    externalId?: string | null;
    externalCustomer?: string | null;
    currentPeriodEnd?: Date | null;
    cancelAt?: Date | null;
  },
): Promise<Subscription> {
  const updated = await db.query<SubscriptionRow>(
    `insert into subscriptions
       (organization_id, tier, status, external_id, external_customer, current_period_end, cancel_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (organization_id) do update set
       tier = excluded.tier,
       status = excluded.status,
       external_id = coalesce(excluded.external_id, subscriptions.external_id),
       external_customer = coalesce(excluded.external_customer, subscriptions.external_customer),
       current_period_end = excluded.current_period_end,
       cancel_at = excluded.cancel_at,
       updated_at = now()
     returning organization_id, tier, status, external_id, external_customer, current_period_end,
               cancel_at, updated_at`,
    [
      input.organizationId,
      input.tier,
      input.status,
      input.externalId ?? null,
      input.externalCustomer ?? null,
      input.currentPeriodEnd ?? null,
      input.cancelAt ?? null,
    ],
  );
  return toSubscription(updated.rows[0]!);
}

/** Which organisation a provider's customer id belongs to, for a webhook that only carries that. */
export async function organizationForCustomer(
  db: Db,
  externalCustomer: string,
): Promise<string | null> {
  const found = await db.query<{ organization_id: string }>(
    'select organization_id from subscriptions where external_customer = $1',
    [externalCustomer],
  );
  return found.rows[0]?.organization_id ?? null;
}

/**
 * Records that an event has been handled, and says whether it already had been.
 *
 * Providers deliver at least once and mean it — a retry after a timeout is normal operation. A
 * redelivered `invoice.paid` is a second upgrade; a redelivered `subscription.deleted` arriving
 * after an upgrade would undo it. `insert … on conflict do nothing` makes the check and the record
 * the same statement, so two deliveries racing each other cannot both win.
 */
export async function claimEvent(db: Db, id: string, type: string): Promise<boolean> {
  const inserted = await db.query(
    'insert into billing_events (id, type) values ($1, $2) on conflict (id) do nothing',
    [id, type],
  );
  return (inserted.rowCount ?? 0) > 0;
}

/**
 * Takes a usage snapshot for the current period.
 *
 * The one thing derivation cannot do: answer "what did they use in March" after March's projects
 * have been deleted. Idempotent per period, so running it twice a day is harmless and running it
 * never simply means no history.
 */
export async function snapshotUsage(db: Db, organizationId: string): Promise<UsageTotals> {
  const usage = await usageOf(db, organizationId);
  const subscription = await loadSubscription(db, organizationId);

  await db.query(
    `insert into usage_snapshots
       (organization_id, period_start, tier, exports, storage_bytes, seats)
     values ($1, date_trunc('month', now()), $2, $3, $4, $5)
     on conflict (organization_id, period_start) do update set
       exports = excluded.exports,
       storage_bytes = excluded.storage_bytes,
       seats = excluded.seats,
       taken_at = now()`,
    // The month, not the rolling window: a snapshot is history for a human to read, and "March"
    // is a thing somebody can ask about while "the thirty days ending on the 14th" is not.
    [organizationId, entitledTier(subscription), usage.exports, usage.storageBytes, usage.seats],
  );

  return usage;
}
