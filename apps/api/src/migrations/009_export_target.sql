-- What an export is for: a page to host, or a program to double-click.
--
-- `target` defaults to 'web' so every row already in this table reads back as the web export it
-- was. That is the whole reason for a default rather than a backfill: there is no such thing as a
-- desktop build made before this column existed, so 'web' is the true answer for every one of them
-- rather than a value standing in for a missing read.
--
-- `desktop_options` is JSON rather than columns, and deliberately: platform, product name, version
-- and full-screen are one request travelling together, they are validated by
-- `DesktopOptionsSchema` at the boundary before they ever reach here, and splitting them into four
-- nullable columns would put the "which of these are set together" rule in two places.
ALTER TABLE export_jobs
  ADD COLUMN IF NOT EXISTS target TEXT NOT NULL DEFAULT 'web',
  ADD COLUMN IF NOT EXISTS desktop_options JSONB;

-- A closed vocabulary in the database as well as in the schema. The parser rejects anything else
-- first; this is the second lock, for the day something writes a row without going through it.
ALTER TABLE export_jobs
  DROP CONSTRAINT IF EXISTS export_jobs_target_check;
ALTER TABLE export_jobs
  ADD CONSTRAINT export_jobs_target_check CHECK (target IN ('web', 'desktop'));
