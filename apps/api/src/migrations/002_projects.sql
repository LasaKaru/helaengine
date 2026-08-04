-- Sprint 29: what a project needs beyond existing.
--
-- `projects` and `scene_versions` were created in 001 because an organisation with nothing to own
-- is a shape without a purpose. This adds the columns saving and history actually need.

alter table projects
  -- Soft delete. A project is somebody's work, and "are you sure" is not a good enough answer to
  -- "I clicked the wrong row". Nothing reads a deleted project, and nothing hard-deletes one yet.
  add column deleted_at timestamptz,
  -- A data URL of the editor's own thumbnail capture. Small, and it means the dashboard needs no
  -- second service to render a list.
  add column thumbnail  text,
  add column updated_at timestamptz not null default now();

-- The dashboard lists a single organisation's live projects, most recently touched first.
create index projects_live_idx on projects (organization_id, updated_at desc) where deleted_at is null;

-- Every version read is "the latest for this project" or "the last N". Both are this index.
create index scene_versions_recent_idx on scene_versions (project_id, version desc);
