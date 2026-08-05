-- Sprint 33: the correlation id, on the row it belongs to.

-- Why store it at all, when traces already carry one: a user reports a bad export by pasting a
-- build id or a project name, never a trace id. This column is the join between what they can see
-- and what the tracing backend holds — given a job, you have the string that finds every log line
-- and every span for the request that created it.
--
-- Nullable, because every job created before this migration genuinely has no correlation id and a
-- backfilled placeholder would be a lie that looks like data.
alter table export_jobs add column correlation_id text;

-- Support's actual query: "somebody sent me this correlation id, what did it do?"
create index export_jobs_correlation_idx on export_jobs (correlation_id)
  where correlation_id is not null;
