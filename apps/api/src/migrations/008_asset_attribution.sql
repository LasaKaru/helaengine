-- Sprint 37 — attribution on uploaded assets.
--
-- The curated library has carried `license`, `author` and `sourceUrl` in its manifest since the
-- ingest pipeline existed, and an export reads them to write CREDITS.md. An asset an organisation
-- uploads had nowhere to put any of it, so every game built with one shipped a credits file saying
-- "licence not recorded" beside art somebody actually made.
--
-- `origin` is the marketplace groundwork the sprint asks for. Today "is it ours?" happens to equal
-- "is organization_id null?", and the day a third party contributes to the shared library that
-- stops being true silently, with no schema change to notice. A column that says what a row is
-- cannot drift the way an inference can.
--
-- Backfilled rather than left null: every row that exists today was uploaded by an organisation
-- into its own library, which is exactly what 'customer' means. Rows with no organisation are the
-- curated library and are ours.

alter table assets
  add column license    text,
  add column author     text,
  add column source_url text,
  add column origin     text not null default 'customer'
                        check (origin in ('first-party', 'customer', 'third-party'));

update assets set origin = 'first-party' where organization_id is null;

-- Marketplace listings will want "everything contributed by third parties, newest first", and a
-- partial index keeps that cheap without charging the common case for it.
create index assets_origin_idx on assets (origin) where origin <> 'customer';

comment on column assets.origin is
  'Who the asset came from. first-party = shipped with HelaEngine; customer = uploaded by an '
  'organisation, which warrants it has the rights; third-party = contributed to the shared library.';
