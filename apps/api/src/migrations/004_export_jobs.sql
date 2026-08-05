-- Sprint 32: exporting as a job, and a quota on how often.

-- Which plan an organisation is on. There is no billing yet, so this is set by hand — but the
-- quota it drives is enforced for real, because export is the expensive operation in this product
-- and an unlimited endpoint decides the infrastructure bill for you.
alter table organizations
  add column plan_tier text not null default 'free'
  check (plan_tier in ('free', 'pro', 'studio', 'enterprise'));

create table export_jobs (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references projects(id) on delete cascade,
  -- Denormalised from the project on purpose. Quota is counted per organisation over a rolling
  -- window, and a project deleted mid-period must not silently give its exports back.
  organization_id uuid not null references organizations(id) on delete cascade,
  -- The *version* exported, not the project. A job is a snapshot: what it built stays what it
  -- built even after somebody saves over the scene it came from.
  scene_version   integer not null,
  requested_by    uuid references users(id) on delete set null,

  status          text not null default 'queued'
                  check (status in ('queued', 'processing', 'done', 'failed')),
  stage           text not null default 'queued'
                  check (stage in ('queued', 'loading', 'building', 'compressing', 'storing', 'done')),
  progress        integer not null default 0 check (progress between 0 and 100),
  attempts        integer not null default 0,
  error           text,

  -- Where the built zip lives, and when it stops being downloadable. An export is derived, not
  -- storage: one that lives forever is one somebody eventually links to publicly.
  artifact_path   text,
  artifact_bytes  bigint,
  expires_at      timestamptz,

  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- The quota query: "how many exports has this organisation started since a moment". Counts every
-- status, including failures — a failed export still cost the CPU that the quota is protecting.
create index export_jobs_quota_idx on export_jobs (organization_id, created_at desc);

-- The project's own history of builds, newest first.
create index export_jobs_project_idx on export_jobs (project_id, created_at desc);

-- Finding artifacts whose time is up, for whatever sweeps them.
create index export_jobs_expiry_idx on export_jobs (expires_at) where artifact_path is not null;
