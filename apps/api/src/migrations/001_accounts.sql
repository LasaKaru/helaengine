-- Sprint 28: users, organisations, memberships, invites, and the first two project tables.
--
-- Hand-written SQL rather than a generated migration, and applied by a tiny runner in db.ts. See
-- the note at the top of that file for why this repo is not using an ORM.

create extension if not exists pgcrypto;

create table users (
  id            uuid primary key default gen_random_uuid(),
  -- Citext would be tidier, but it is an extension that not every managed Postgres offers. Stored
  -- lower-cased on the way in instead, with the uniqueness enforced here rather than in a check
  -- somewhere in application code that a second caller will forget.
  email         text not null unique,
  display_name  text not null,
  -- Null for a user provisioned by an external identity provider. Local passwords are one way in,
  -- not the only one — see AuthProvider in auth.ts.
  password_hash text,
  created_at    timestamptz not null default now()
);

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  -- The workspace created automatically at signup. Recorded rather than inferred, because "you
  -- cannot leave or delete your own personal workspace" is a rule, and a rule inferred from
  -- membership counts is a rule that stops holding the first time somebody is invited to it.
  is_personal boolean not null default false,
  created_at  timestamptz not null default now()
);

create table memberships (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  role            text not null check (
    role in ('enterprise_admin', 'owner', 'admin', 'editor', 'viewer')
  ),
  created_at      timestamptz not null default now(),
  primary key (organization_id, user_id)
);

-- Every membership lookup is "this user, in this org", and every listing is "everyone in this org".
create index memberships_user_idx on memberships (user_id);

create table invites (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  email           text not null,
  role            text not null check (
    role in ('enterprise_admin', 'owner', 'admin', 'editor', 'viewer')
  ),
  -- The hash, never the token. An invite token is a credential: anyone holding the database should
  -- not be able to accept invitations, and a leaked backup should not become a set of live keys.
  token_hash      text not null unique,
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  accepted_by     uuid references users(id) on delete set null,
  created_by      uuid not null references users(id) on delete cascade,
  created_at      timestamptz not null default now()
);

create index invites_org_idx on invites (organization_id);

create table sessions (
  -- Same reasoning as invites: the hash is stored, the token is only ever in the response.
  token_hash text primary key,
  user_id    uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index sessions_user_idx on sessions (user_id);

-- Projects and their versions. Created here because the org model is meaningless without something
-- to own; Sprint 29 is what fills them.
create table projects (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name            text not null,
  created_by      uuid not null references users(id) on delete cascade,
  created_at      timestamptz not null default now()
);

create index projects_org_idx on projects (organization_id);

create table scene_versions (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references projects(id) on delete cascade,
  -- Append-only: a new row per save, never an update. That is what gives version history "for
  -- free" in Sprint 29 rather than as a feature somebody has to build.
  version    integer not null,
  document   jsonb not null,
  created_by uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  unique (project_id, version)
);
