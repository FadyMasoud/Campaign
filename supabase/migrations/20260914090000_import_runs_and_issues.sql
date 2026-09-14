-- ===========================================================================
-- Phase 3 — recording what an import did, and what it refused
-- ===========================================================================
--
-- "Data loads; the marketer sees what didn't and why."
--
-- The second half is the hard half. An importer that quietly drops 3,000 rows
-- is worse than one that fails outright, because nobody finds out until a
-- campaign goes to the wrong number of people. Every row these tables record
-- is a row that did not arrive, together with the reason, the line it came
-- from and the value that caused it.
--
-- These are also the first tables added AFTER the isolation guarantee was
-- written, which is the case requirement 2 calls out: "including ones added
-- later". Nothing special happens below to protect them — they get the same
-- one-line policy as everything else, and tests/isolation.test.ts starts
-- checking them without being edited, because it asks the database which
-- tables exist rather than being told.
-- ===========================================================================


create type public.import_status   as enum ('running', 'succeeded', 'failed');
create type public.import_severity as enum ('rejected', 'warning');


-- ---------------------------------------------------------------------------
-- One row per file processed
-- ---------------------------------------------------------------------------

create table public.import_runs (
  id             uuid                 primary key default gen_random_uuid(),
  brand_id       uuid                 not null references public.brands (id) on delete cascade,

  source_file    text                 not null,
  entity         text                 not null check (entity in ('contacts', 'campaigns', 'events')),

  status         public.import_status not null default 'running',
  started_at     timestamptz          not null default now(),
  finished_at    timestamptz,

  -- The five numbers a marketer actually asks about, kept separate so the
  -- screen never has to say "2,778 problems" when 2,410 of them were a file
  -- listing the same unchanged customer twice.
  rows_read      integer              not null default 0 check (rows_read     >= 0),
  rows_created   integer              not null default 0 check (rows_created  >= 0),
  rows_updated   integer              not null default 0 check (rows_updated  >= 0),
  rows_rejected  integer              not null default 0 check (rows_rejected >= 0),
  rows_duplicate integer              not null default 0 check (rows_duplicate >= 0),

  -- Set only when the run itself fell over, as opposed to individual rows
  -- being refused. The distinction matters: the first means "try again", the
  -- second means "fix your export".
  error          text,

  constraint import_runs_brand_id_id_key unique (brand_id, id)
);

create index import_runs_brand_started_idx on public.import_runs (brand_id, started_at desc);


-- ---------------------------------------------------------------------------
-- One row per thing that was wrong
-- ---------------------------------------------------------------------------

create table public.import_issues (
  id          bigint generated always as identity primary key,
  brand_id    uuid                   not null references public.brands (id) on delete cascade,
  run_id      uuid                   not null,

  -- 'rejected' means the row is not in the database. 'warning' means it is,
  -- but something about it was changed or could not be resolved — an invalid
  -- address dropped, a campaign reference left dangling. Conflating the two
  -- would make the report useless: the marketer needs to know what to chase.
  severity    public.import_severity not null,

  -- A stable machine-readable key, so the screen can group thousands of
  -- issues into a handful of lines a person can read.
  reason_code text                   not null,
  -- The same thing said in a sentence, for the person reading it.
  reason      text                   not null,

  -- Where to look in the original file. Without the line number a report of
  -- 1,470 bad addresses is not actionable.
  source_line integer,
  external_id text,
  field       text,
  value       text,

  created_at  timestamptz            not null default now(),

  constraint import_issues_run_same_brand_fkey
    foreign key (brand_id, run_id) references public.import_runs (brand_id, id) on delete cascade
);

create index import_issues_run_idx           on public.import_issues (run_id, severity);
create index import_issues_brand_reason_idx  on public.import_issues (brand_id, reason_code);


-- ---------------------------------------------------------------------------
-- The same one line, twice more
-- ---------------------------------------------------------------------------

alter table public.import_runs   enable row level security;
alter table public.import_issues enable row level security;

create policy import_runs_isolation on public.import_runs
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));

create policy import_issues_isolation on public.import_issues
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));

-- Writing is the importer's job, and the importer runs under the service role
-- with an explicit brand filter. No signed-in user may write here: an import
-- report that its own reader can edit is not a report.
revoke all on public.import_runs   from anon, authenticated;
revoke all on public.import_issues from anon, authenticated;

grant select on public.import_runs   to authenticated;
grant select on public.import_issues to authenticated;
