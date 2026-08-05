-- Sprint 30: assets that belong to somebody.
--
-- The curated library from Sprint 2 has no owner — it ships with the product. This adds the other
-- kind: a `.glb` a customer uploaded, private to their organisation, and processed the same way
-- the built-in ones were.

create table assets (
  id              uuid primary key default gen_random_uuid(),
  -- Null means the curated global library, which everyone can see and nobody can change. A row
  -- with an organisation is private to it. One table rather than two, because "list what I can
  -- place" is one query either way and two tables would make it a union that drifts.
  organization_id uuid references organizations(id) on delete cascade,
  asset_id        text not null,
  name            text not null,
  category        text not null,
  -- Where the bytes live, relative to whatever is serving them. Content-addressed: the hash is in
  -- the path, so a URL can be cached forever and a re-upload of changed bytes is a new URL rather
  -- than a stale one somebody has to purge.
  glb_path        text,
  thumbnail_path  text,
  content_hash    text,
  poly_count      integer,
  -- pending -> ready, or pending -> failed with a reason somebody can act on. A processing state
  -- in the row rather than in a queue's memory, so a page refresh does not lose it.
  status          text not null default 'pending'
                  check (status in ('pending', 'ready', 'failed')),
  failure         text,
  size_bytes      integer,
  uploaded_by     uuid references users(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- An asset id is unique within its owner, and globally unique among the curated ones. Two
-- partial indexes rather than one constraint, because SQL treats nulls as distinct and a plain
-- unique (organization_id, asset_id) would let the global library hold duplicates.
create unique index assets_org_unique on assets (organization_id, asset_id)
  where organization_id is not null;
create unique index assets_global_unique on assets (asset_id) where organization_id is null;

-- The library panel asks for "everything I can place, by category".
create index assets_visible_idx on assets (organization_id, category) where status = 'ready';
