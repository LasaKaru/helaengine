-- Sprint 35: the business model, in the database.

-- One row per organisation, created lazily — an organisation with no row is on the free tier, which
-- is the overwhelming majority and should cost no write to represent.
--
-- Deliberately smaller than Stripe's subscription object. What the API has to answer is "which tier,
-- and are they paid up"; invoices, payment methods and proration are the provider's business, and
-- mirroring them here creates a second copy that drifts from the first the moment a webhook is
-- missed. The provider's portal shows those, from the provider's own data.
create table subscriptions (
  organization_id     uuid primary key references organizations(id) on delete cascade,

  tier                text not null default 'free'
                      check (tier in ('free', 'pro', 'studio', 'enterprise')),

  -- `past_due` keeps its entitlement on purpose: a failed payment is retried for days, and locking
  -- somebody out of their own work the same afternoon their card expired is how you turn a billing
  -- problem into a churn problem. See `entitledTier` in the schema.
  status              text not null default 'none'
                      check (status in ('none', 'active', 'past_due', 'canceling')),

  -- The provider's ids. Null on a deployment with no provider, which is a supported configuration
  -- rather than an unfinished one — self-hosted installs have nobody to bill.
  external_id         text unique,
  external_customer   text,

  current_period_end  timestamptz,
  cancel_at           timestamptz,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- Webhooks arrive keyed by the provider's customer, not by ours.
create index subscriptions_customer_idx on subscriptions (external_customer)
  where external_customer is not null;

-- Every webhook this system has already acted on.
--
-- Providers deliver at least once, and mean it: a retry after a timeout is normal operation, not an
-- attack. Without this table, a redelivered `invoice.paid` is a second upgrade and a redelivered
-- `subscription.deleted` can undo an upgrade that happened in between. The event id is the
-- provider's own, so idempotency costs one insert with a primary key.
create table billing_events (
  id            text primary key,
  type          text not null,
  received_at   timestamptz not null default now()
);

-- What an organisation has used, per rolling period.
--
-- Only what cannot be counted from the tables that already exist. Exports are counted from
-- `export_jobs`, storage from `assets`, seats from `memberships` — deriving them means the meter
-- can never disagree with reality, which a separate counter eventually would. What lives here is
-- the *history*: a monthly snapshot, so "what did they use in March" survives a project being
-- deleted in April.
create table usage_snapshots (
  id              bigserial primary key,
  organization_id uuid not null references organizations(id) on delete cascade,
  -- The first instant of the period this describes.
  period_start    timestamptz not null,
  tier            text not null,
  exports         integer not null default 0,
  storage_bytes   bigint not null default 0,
  seats           integer not null default 0,
  taken_at        timestamptz not null default now(),

  unique (organization_id, period_start)
);

create index usage_snapshots_org_idx on usage_snapshots (organization_id, period_start desc);

-- Assets already carry their size; this is the index the storage meter reads.
create index assets_org_size_idx on assets (organization_id) where status = 'ready';

-- The audit vocabulary gains one action, and the check constraint has to gain it too — the closed
-- vocabulary is enforced by the database as well as by the code, which is the point of it.
alter table audit_log drop constraint audit_log_action_check;
alter table audit_log add constraint audit_log_action_check check (action in (
  'member.invited',
  'member.joined',
  'member.role_changed',
  'member.removed',
  'project.created',
  'project.deleted',
  'project.restored',
  'asset.deleted',
  'export.requested',
  'export.downloaded',
  'billing.changed'
));
