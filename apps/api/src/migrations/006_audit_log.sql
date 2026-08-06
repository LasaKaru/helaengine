-- Sprint 34: what happened, who did it, and when.

-- Why this exists, given that Sprint 33 already writes structured logs: logs are diagnostics and
-- this is a record. They differ in every way that matters to somebody answering a security
-- questionnaire — logs are sampled, rotated, shipped to a third party and written by whichever
-- service felt like it, while these rows are in the same transaction-capable database as the thing
-- they describe, retained on purpose, and queryable by organisation.
--
-- It is deliberately *not* a change feed. Scene edits are versioned in `scene_versions` already,
-- and copying every save in here would bury the handful of events somebody actually reviews:
-- membership, access, deletion.
create table audit_log (
  id              bigserial primary key,

  -- The tenant this is about. Every review is scoped to one, so it is the leading index column.
  organization_id uuid not null references organizations(id) on delete cascade,

  -- Who did it. Null for an unauthenticated action (an invite accepted by somebody who did not yet
  -- have an account) and for anything the system did on its own.
  actor_user_id   uuid references users(id) on delete set null,

  -- A closed vocabulary, checked here rather than trusted from the application. The whole value of
  -- an audit trail is that its rows mean the same thing years later, and a free-text action column
  -- becomes six spellings of "delete" within a year.
  action          text not null check (action in (
    'member.invited',
    'member.joined',
    'member.role_changed',
    'member.removed',
    'project.created',
    'project.deleted',
    'project.restored',
    'asset.deleted',
    'export.requested',
    'export.downloaded'
  )),

  -- What it was done to: a project id, an asset id, a job id, a user id. Text rather than a foreign
  -- key on purpose — the row must survive the thing it describes being deleted, which is precisely
  -- the case somebody is reviewing.
  subject         text,

  -- Room for the detail that makes an entry answerable: the role that changed, the email invited.
  -- Never credentials, never a scene document.
  detail          jsonb not null default '{}'::jsonb,

  -- The request this belongs to (Sprint 33), so an audit entry can be turned back into the full
  -- trace and log line that produced it.
  correlation_id  text,

  created_at      timestamptz not null default now()
);

-- The review query: "everything that happened in this organisation, newest first".
create index audit_log_org_idx on audit_log (organization_id, created_at desc);

-- The incident query: "everything about this project/asset/user".
create index audit_log_subject_idx on audit_log (subject) where subject is not null;
