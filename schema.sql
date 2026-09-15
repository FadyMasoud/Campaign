-- GENERATED FILE — DO NOT EDIT.
--
-- Built from supabase/migrations by `npm run schema:build`.
-- The migrations are the source of truth; this is a single-file view of
-- them for reading. Edit a migration, then regenerate.
--
-- Migrations included (13):
--   20260913160000_brands_and_isolation.sql
--   20260914090000_import_runs_and_issues.sql
--   20260914120000_import_issue_summary.sql
--   20260914150000_analytics.sql
--   20260914170000_contactability_state.sql
--   20260914190000_campaign_performance_split.sql
--   20260914210000_contact_search.sql
--   20260914230000_sending.sql
--   20260915010000_provider_reports.sql
--   20260915030000_apply_reports_callable.sql
--   20260915060000_shared_reports.sql
--   20260915120000_send_batches.sql
--   20260915130000_mark_recipients_grants.sql

-- ===========================================================================
-- Phase 1 — brands, membership, and the isolation guarantee
-- ===========================================================================
--
-- THE ONE RULE:  a brand sees its own rows and nothing from another brand,
-- on every route into the data, including tables added after this file.
--
-- It is enforced here, in the database, by Row Level Security. The web app is
-- not in the loop: signing in to this project with any client — psql, curl,
-- the Supabase dashboard — is subject to the same rule.
--
-- The rule lives in ONE function, app.current_user_brand_ids(), and every
-- policy in this project is the same single line referring to it. There is no
-- second place to look and no policy that can drift from the others.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. A private schema for the predicate
-- ---------------------------------------------------------------------------
-- `app` is deliberately NOT in PostgREST's exposed schema list, so nothing in
-- here is reachable as an API endpoint. It is only ever called from inside a
-- policy, where PostgreSQL evaluates it as the querying user.

create schema if not exists app;

comment on schema app is
  'Internal helpers referenced by RLS policies. Not exposed through the API.';

revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 2. Brands
-- ---------------------------------------------------------------------------

create table public.brands (
  id            uuid primary key default gen_random_uuid(),
  code          text        not null unique check (code ~ '^[A-Z][A-Z_]{1,31}$'),
  name          text        not null check (length(btrim(name)) > 0),
  country_code  text        not null check (country_code ~ '^[A-Z]{2}$'),

  -- Campaign exports carry both an absolute UTC instant and a local wall-clock
  -- string. "How many campaigns went out on the 3rd?" has two defensible
  -- answers, and they differ. This column is what lets the app state which one
  -- it is showing instead of silently picking.
  timezone      text        not null,

  created_at    timestamptz not null default now()
);

comment on column public.brands.timezone is
  'IANA zone. The basis for any date shown as a local calendar date rather '
  'than a UTC instant; surfaced in the UI so the reader knows which was used.';


-- ---------------------------------------------------------------------------
-- 3. Who belongs to which brand, and in what capacity
-- ---------------------------------------------------------------------------
-- An owner may send campaigns; an analyst may only read. A user with no row
-- here belongs to no brand and — by the predicate below — sees nothing at all.
-- That is the "outsiders get in nowhere" case: it needs no special handling,
-- it is the default.

create type public.brand_role as enum ('owner', 'analyst');

create table public.brand_members (
  user_id    uuid              not null references auth.users (id) on delete cascade,
  brand_id   uuid              not null references public.brands (id) on delete cascade,
  role       public.brand_role not null,
  created_at timestamptz       not null default now(),

  primary key (user_id, brand_id)
);

create index brand_members_brand_id_idx on public.brand_members (brand_id);


-- ---------------------------------------------------------------------------
-- 4. THE PREDICATE — the single citable location of the isolation guarantee
-- ---------------------------------------------------------------------------
-- Every policy in this project reduces to: is this row's brand one of mine?
--
-- Three deliberate properties:
--
--   security definer  The function reads brand_members while brand_members is
--                     itself protected by a policy that calls this function.
--                     Running as the owner breaks that cycle. Without it,
--                     PostgreSQL raises "infinite recursion detected in policy".
--
--   set search_path   A security-definer function with a caller-controlled
--                     search_path is a privilege-escalation hole: the caller
--                     could shadow `brand_members` with their own table. The
--                     empty path forces every name here to be fully qualified.
--
--   stable + setof    Returning a set that does not depend on the row lets the
--                     planner hoist it out as an InitPlan: evaluated ONCE per
--                     statement and hashed, not re-run for each of the 84,000
--                     rows the largest brand holds. A predicate written as
--                     `app.can_see(brand_id)` would take a row argument and be
--                     re-evaluated per row — correct, but slow at this size.

create or replace function app.current_user_brand_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.brand_id
  from public.brand_members m
  where m.user_id = (select auth.uid());
$$;

comment on function app.current_user_brand_ids() is
  'THE data-isolation predicate. Every RLS policy in this project is '
  '"<brand column> in (select app.current_user_brand_ids())" and nothing else.';

revoke all on function app.current_user_brand_ids() from public;
grant execute on function app.current_user_brand_ids() to authenticated, service_role;


-- Role check, used where reading is allowed but acting is not. Kept separate
-- from the predicate above so that "can this brand see it" and "may this person
-- do it" never get tangled together in one expression.
create or replace function app.is_brand_owner(target_brand_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.brand_members m
    where m.brand_id = target_brand_id
      and m.user_id  = (select auth.uid())
      and m.role     = 'owner'
  );
$$;

revoke all on function app.is_brand_owner(uuid) from public;
grant execute on function app.is_brand_owner(uuid) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- 5. Vocabularies
-- ---------------------------------------------------------------------------
-- Taken from the exports themselves, not guessed. Between them the three
-- contact files spell the same four states six ways ('active', 'ACTIVE',
-- 'Active', 'active ', 'unsubscribe', ''), and express consent in eleven forms
-- ('true', '1', 'TRUE', 'yes', 'Y', 'f', 'no', 'FALSE', '0', 'false', '').
-- Normalising is the importer's job; these types are what it must normalise
-- TO. A value that cannot be mapped is rejected and reported, never stored as
-- a guess.

create type public.contact_status as enum ('active', 'pending', 'unsubscribed', 'bounced');
create type public.channel        as enum ('email', 'sms');
create type public.event_type     as enum ('open', 'click', 'bounce', 'complaint', 'unsubscribe');


-- ---------------------------------------------------------------------------
-- 6. Contacts
-- ---------------------------------------------------------------------------

create table public.contacts (
  id                uuid                  primary key default gen_random_uuid(),
  brand_id          uuid                  not null references public.brands (id) on delete cascade,

  -- The provider id for this person. Unique WITHIN a brand only: the three
  -- exports number their contacts from one shared pool, so CT-000484 occurs in
  -- more than one brand and means a different person in each. A globally
  -- unique constraint here would silently merge two people into one.
  external_id       text                  not null,

  full_name         text,
  email             text,
  phone_raw         text,                 -- exactly as exported, for audit
  phone_e164        text,                 -- normalised, for sending
  country_code      text,
  city              text,
  signup_at         timestamptz,

  status            public.contact_status not null,
  consent_marketing boolean               not null,
  deleted_at        timestamptz,
  suppressed_until  timestamptz,
  notes             text,

  -- Provenance: which export this row last arrived in. Re-importing the same
  -- file must leave one contact and not two, so the importer upserts on
  -- (brand_id, external_id); this records where the surviving version came
  -- from.
  source_file       text,
  first_seen_at     timestamptz           not null default now(),
  updated_at        timestamptz           not null default now(),

  constraint contacts_brand_external_id_key unique (brand_id, external_id),

  -- Not redundant with the primary key. It is the target of the composite
  -- foreign keys below, which is how the database — rather than application
  -- convention — refuses to let one brand row reference another brand row.
  constraint contacts_brand_id_id_key unique (brand_id, id),

  -- A contact with neither an address nor a number is reachable on no channel.
  -- Such rows are rejected at import and listed in the failure report rather
  -- than stored as dead weight.
  constraint contacts_reachable_check check (email is not null or phone_e164 is not null)
);

create index contacts_brand_status_idx on public.contacts (brand_id, status);
create index contacts_brand_email_idx  on public.contacts (brand_id, lower(email));
create index contacts_brand_signup_idx on public.contacts (brand_id, signup_at desc);


-- ---------------------------------------------------------------------------
-- 7. Campaigns
-- ---------------------------------------------------------------------------

create table public.campaigns (
  id                  uuid           primary key default gen_random_uuid(),
  brand_id            uuid           not null references public.brands (id) on delete cascade,
  external_id         text           not null,
  name                text           not null,
  channel             public.channel not null,
  target_country_code text,

  -- What the provider claimed, kept verbatim and never recomputed. The app
  -- also counts the same quantities from the event log, and the two disagree.
  -- Both are shown and labelled, rather than one being quietly preferred.
  reported_sent       integer        check (reported_sent      >= 0),
  reported_delivered  integer        check (reported_delivered >= 0),
  reported_bounced    integer        check (reported_bounced   >= 0),
  reported_opens      integer        check (reported_opens     >= 0),
  reported_clicks     integer        check (reported_clicks    >= 0),
  spend               numeric(14,2)  check (spend              >= 0),

  -- NOTE: there is deliberately no "opens <= sent" constraint. In the real
  -- export KIL-0016 reports 12,679 opens against 10,640 sent, because one
  -- recipient opening twice is two opens. A constraint asserting otherwise
  -- would reject valid data.

  sent_at             timestamptz,
  send_local_time     text,
  parent_external_id  text,
  parent_campaign_id  uuid,

  created_at          timestamptz    not null default now(),
  updated_at          timestamptz    not null default now(),

  constraint campaigns_brand_external_id_key unique (brand_id, external_id),
  constraint campaigns_brand_id_id_key       unique (brand_id, id),

  -- Isolation enforced structurally rather than by convention. The Karoo
  -- export contains a campaign whose stated parent is KIL-0007, a Kilele
  -- campaign. Because brand_id sits on both sides of this key, that link
  -- cannot be stored at all: the importer resolves parents within the brand
  -- only, and reports the ones it could not resolve.
  constraint campaigns_parent_same_brand_fkey
    foreign key (brand_id, parent_campaign_id)
    references public.campaigns (brand_id, id)
);

create index campaigns_brand_sent_at_idx on public.campaigns (brand_id, sent_at desc);


-- ---------------------------------------------------------------------------
-- 8. Events reported by the provider
-- ---------------------------------------------------------------------------
-- Append-only. The provider reports these over time, out of order, and repeats
-- itself. Who is contactable is therefore derived from the whole set, never
-- from whichever report happened to arrive last.

create table public.contact_events (
  id          uuid              primary key default gen_random_uuid(),
  brand_id    uuid              not null references public.brands (id) on delete cascade,

  -- The provider id for the report itself. Unique per brand, which is what
  -- makes replaying a file a no-op instead of a duplicate.
  external_id text              not null,

  contact_id  uuid,
  campaign_id uuid,
  event_type  public.event_type not null,
  channel     public.channel    not null,

  -- When it happened, per the provider, against when we learned of it. Holding
  -- both is what lets a late report be applied correctly instead of being
  -- mistaken for the newest state.
  occurred_at timestamptz       not null,
  recorded_at timestamptz       not null default now(),

  constraint contact_events_brand_external_id_key unique (brand_id, external_id),

  constraint contact_events_contact_same_brand_fkey
    foreign key (brand_id, contact_id)  references public.contacts  (brand_id, id) on delete cascade,
  constraint contact_events_campaign_same_brand_fkey
    foreign key (brand_id, campaign_id) references public.campaigns (brand_id, id) on delete cascade
);

create index contact_events_brand_campaign_type_idx on public.contact_events (brand_id, campaign_id, event_type);
create index contact_events_brand_contact_idx       on public.contact_events (brand_id, contact_id, occurred_at desc);
create index contact_events_brand_occurred_idx      on public.contact_events (brand_id, occurred_at desc);


-- ---------------------------------------------------------------------------
-- 9. Keeping updated_at honest
-- ---------------------------------------------------------------------------

create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger contacts_touch_updated_at
  before update on public.contacts
  for each row execute function app.touch_updated_at();

create trigger campaigns_touch_updated_at
  before update on public.campaigns
  for each row execute function app.touch_updated_at();


-- ---------------------------------------------------------------------------
-- 10. Row Level Security — the same one line, five times
-- ---------------------------------------------------------------------------
-- Read these together. Every policy below is the identical predicate; only the
-- column name differs, and only because the brands table calls its own key
-- `id` rather than `brand_id`.
--
-- SELECT only, for the `authenticated` role only. Nothing here lets a signed-in
-- user write: imports, sends and webhooks all run server-side under the
-- service role, which filters by brand explicitly. Phase 5 adds the single
-- owner-gated write policy that sending needs, using app.is_brand_owner.
--
-- The `anon` role is granted nothing at all, so a caller holding only the
-- publishable key and no session reaches none of this — the privilege check
-- fails before any policy is even consulted.

alter table public.brands         enable row level security;
alter table public.brand_members  enable row level security;
alter table public.contacts       enable row level security;
alter table public.campaigns      enable row level security;
alter table public.contact_events enable row level security;

create policy brands_isolation on public.brands
  for select to authenticated
  using (id in (select app.current_user_brand_ids()));

create policy brand_members_isolation on public.brand_members
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));

create policy contacts_isolation on public.contacts
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));

create policy campaigns_isolation on public.campaigns
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));

create policy contact_events_isolation on public.contact_events
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));


-- Privileges, as a second independent layer. RLS decides which rows; these
-- decide whether the role may touch the table at all. Dropping a policy by
-- accident still leaves anon with no grant to exercise.
revoke all on public.brands         from anon, authenticated;
revoke all on public.brand_members  from anon, authenticated;
revoke all on public.contacts       from anon, authenticated;
revoke all on public.campaigns      from anon, authenticated;
revoke all on public.contact_events from anon, authenticated;

grant select on public.brands         to authenticated;
grant select on public.brand_members  to authenticated;
grant select on public.contacts       to authenticated;
grant select on public.campaigns      to authenticated;
grant select on public.contact_events to authenticated;


-- ---------------------------------------------------------------------------
-- 11. Tables that do not exist yet
-- ---------------------------------------------------------------------------
-- The guarantee has to hold for routes added after today, and the failure mode
-- is specific: RLS is off by default on a new table, while Supabase grants the
-- API roles broad privileges on new tables by default. A table added in a
-- later phase would therefore be world-readable until someone remembered to
-- lock it.
--
-- This removes that default, so the mistake is inverted: a new table is
-- unreachable until privileges are granted deliberately. Forgetting now fails
-- closed and is noticed immediately, instead of failing open and being noticed
-- by whoever finds the data.

alter default privileges in schema public revoke all    on tables    from anon, authenticated;
alter default privileges in schema public revoke all    on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 12. Making the guarantee testable
-- ---------------------------------------------------------------------------
-- Reports the security posture of every table in `public`, so the test suite
-- can assert it for tables that do not exist yet rather than for a list
-- written by hand today. Phase 5 and phase 7 add tables; if either arrives
-- without RLS, or reachable by anon, tests/isolation.test.ts fails without
-- being edited.

create or replace function public.security_coverage()
returns table (
  table_name               text,
  rls_enabled              boolean,
  policy_count             integer,
  anon_can_select          boolean,
  authenticated_can_select boolean,
  authenticated_can_write  boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    c.relname::text,
    c.relrowsecurity,
    (select count(*)::integer from pg_catalog.pg_policy p where p.polrelid = c.oid),
    pg_catalog.has_table_privilege('anon',          c.oid, 'SELECT'),
    pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT'),
    pg_catalog.has_table_privilege('authenticated', c.oid, 'INSERT')
      or pg_catalog.has_table_privilege('authenticated', c.oid, 'UPDATE')
      or pg_catalog.has_table_privilege('authenticated', c.oid, 'DELETE')
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind = 'r'
  order by c.relname;
$$;

revoke all on function public.security_coverage() from public, anon, authenticated;
grant execute on function public.security_coverage() to service_role;


-- ---------------------------------------------------------------------------
-- 13. The three brands
-- ---------------------------------------------------------------------------
-- Reference data, not sample data: the importer resolves each export to a
-- brand by the `brand_code` column carried in the CSVs.

insert into public.brands (code, name, country_code, timezone) values
  ('KILELE',    'Kilele Rides',      'KE', 'Africa/Nairobi'),
  ('KAROO',     'Karoo Coaches',     'ZA', 'Africa/Johannesburg'),
  ('MARRAKECH', 'Marrakech Express', 'MA', 'Africa/Casablanca')
on conflict (code) do nothing;

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

-- ===========================================================================
-- Phase 3 — summarising an import for a person to read
-- ===========================================================================
--
-- One import produces tens of thousands of issue rows: 17,925 unreadable phone
-- numbers in a single file. Nobody reads that. What a marketer needs is
-- "17,925 phone numbers could not be read, here is an example and the line it
-- was on", and the ability to go deeper only if they want to.
--
-- Doing that grouping in the application would mean fetching every issue row
-- across the network to count them. This does it where the data is.
--
-- SECURITY INVOKER — which is the default for a function, and the opposite of
-- the choice made for app.current_user_brand_ids() — is load-bearing here. It
-- means the query inside runs as the person calling it, so the policy on
-- import_issues applies exactly as it would to a direct select, and one brand
-- cannot summarise another brand's import by passing its run id. A
-- SECURITY DEFINER function here would quietly bypass the guarantee the whole
-- project rests on.
-- ===========================================================================

create or replace function public.import_issue_summary(target_run_id uuid)
returns table (
  severity     public.import_severity,
  reason_code  text,
  issue_count  integer,
  example      text,
  example_line integer,
  example_value text
)
language sql
stable
as $$
  select
    i.severity,
    i.reason_code,
    count(*)::integer,
    -- The reasons within a code differ only by the value quoted in them, so
    -- any one of them reads correctly as the example.
    min(i.reason),
    min(i.source_line),
    min(i.value)
  from public.import_issues i
  where i.run_id = target_run_id
  group by i.severity, i.reason_code
  order by count(*) desc;
$$;

comment on function public.import_issue_summary(uuid) is
  'Groups an import run''s issues by reason for display. SECURITY INVOKER, so '
  'row level security on import_issues applies to the caller.';

revoke all on function public.import_issue_summary(uuid) from public;
grant execute on function public.import_issue_summary(uuid) to authenticated, service_role;

-- ===========================================================================
-- Phase 4 — the numbers, and where each one comes from
-- ===========================================================================
--
-- "A quietly wrong number is worse than no number. Where two careful people
--  could reasonably count something two ways, say on the screen which way you
--  counted."
--
-- Every figure the portal shows has exactly one of three bases, and the three
-- are never blended:
--
--   PROVIDER   campaigns.reported_* — what the messaging provider claimed,
--              stored verbatim at import and never recomputed.
--   EVENT LOG  counted from contact_events, the raw engagement log.
--   DERIVED    computed from contact state by a rule stated on screen.
--
-- The two disagree, substantially and systematically. Campaign KAR-0001 is
-- reported by the provider as 2,732 opens; the event log holds 704 of them,
-- from 687 distinct people. Campaign CMP-014 claims 3,600 sent and 1,800 opens
-- with no events at all. Neither source is "right" — they measure different
-- things — so the portal shows both, labelled, and never averages them into a
-- single confident-looking number.
--
-- All three functions below are SECURITY INVOKER, which is the default and the
-- deliberate opposite of the choice made for app.current_user_brand_ids().
-- They run as the caller, so the policies on contacts, campaigns and
-- contact_events apply exactly as they would to a direct select. A SECURITY
-- DEFINER function here would be a hole straight through the isolation
-- guarantee: one brand could read another brand's totals by calling it.
-- ===========================================================================


-- Aggregating opt-outs means asking "which people have an event of this type",
-- which is an index-only scan with this ordering and a sequential scan of
-- 301,209 rows without it.
create index if not exists contact_events_brand_type_contact_idx
  on public.contact_events (brand_id, event_type, contact_id);


-- ---------------------------------------------------------------------------
-- Who can still be contacted, and exactly who was excluded on the way
-- ---------------------------------------------------------------------------
-- This is the number two careful people are most likely to count differently,
-- so it is returned as a waterfall rather than a single figure: every contact
-- falls into exactly one bucket, the buckets sum to the total, and the screen
-- shows the whole descent from "everyone" to "contactable".
--
-- The order of the rules is a decision, not an accident. A person who is
-- removed AND unsubscribed is counted once, under `removed`, because that is
-- the first reason they are unreachable. Reordering the CASE would move people
-- between buckets without changing the final total.
--
-- Rules 6 and 7 are the ones that matter. The stored status column says 986
-- Karoo contacts unsubscribed; the event log says 8,437 people actually did.
-- The log is what happened, so the log wins — which is also what keeps this
-- number correct when the provider reports late, out of order, or while the
-- app is not looking.
create or replace function public.contactability_breakdown()
returns table (
  brand_id                uuid,
  total                   integer,
  removed                 integer,
  no_consent              integer,
  status_unsubscribed     integer,
  status_bounced          integer,
  suppressed              integer,
  opted_out_in_log        integer,
  bounced_in_log          integer,
  contactable             integer,
  future_dated_signups    integer,
  latest_signup_at        timestamptz
)
language sql
stable
as $$
  with opted_out as (
    select distinct contact_id
    from public.contact_events
    where event_type in ('unsubscribe', 'complaint')
      and contact_id is not null
  ),
  bounced as (
    select distinct contact_id
    from public.contact_events
    where event_type = 'bounce'
      and contact_id is not null
  ),
  bucketed as (
    select
      c.brand_id,
      c.signup_at,
      case
        when c.deleted_at is not null                then 'removed'
        when not c.consent_marketing                 then 'no_consent'
        when c.status = 'unsubscribed'               then 'status_unsubscribed'
        when c.status = 'bounced'                    then 'status_bounced'
        when c.suppressed_until > now()              then 'suppressed'
        when o.contact_id is not null                then 'opted_out_in_log'
        when b.contact_id is not null                then 'bounced_in_log'
        else 'contactable'
      end as bucket
    from public.contacts c
    left join opted_out o on o.contact_id = c.id
    left join bounced   b on b.contact_id = c.id
  )
  select
    bucketed.brand_id,
    count(*)::integer,
    count(*) filter (where bucket = 'removed')::integer,
    count(*) filter (where bucket = 'no_consent')::integer,
    count(*) filter (where bucket = 'status_unsubscribed')::integer,
    count(*) filter (where bucket = 'status_bounced')::integer,
    count(*) filter (where bucket = 'suppressed')::integer,
    count(*) filter (where bucket = 'opted_out_in_log')::integer,
    count(*) filter (where bucket = 'bounced_in_log')::integer,
    count(*) filter (where bucket = 'contactable')::integer,
    -- 88 Kilele contacts carry a signup date up to June 2027. They are real
    -- rows and are counted as customers, but a signup cannot have happened in
    -- the future, so they are excluded from any per-day trend and surfaced
    -- here instead of being quietly averaged in.
    count(*) filter (where signup_at > now())::integer,
    max(signup_at)
  from bucketed
  group by bucketed.brand_id;
$$;

comment on function public.contactability_breakdown() is
  'Contactability as a waterfall: every contact lands in exactly one bucket '
  'and the buckets sum to the total. SECURITY INVOKER, so RLS applies.';

revoke all on function public.contactability_breakdown() from public;
grant execute on function public.contactability_breakdown() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- Signups per day
-- ---------------------------------------------------------------------------
-- Two decisions are visible in this function, and both are stated on screen.
--
-- 1. A "day" is a day in the BRAND'S timezone, not UTC. A Kilele signup at
--    23:30 UTC happened on the following morning in Nairobi, and bucketing it
--    by UTC would file it under the wrong day. This is what brands.timezone
--    has been carried since phase 1 for.
--
-- 2. The window is the real last N days, ending today. For Karoo and Marrakech
--    that window is empty — their exports stop in April 2026 — and the screen
--    says so plainly rather than quietly sliding the window back to wherever
--    the data happens to be. An empty chart that explains itself is honest; a
--    full chart secretly labelled "last 30 days" is not.
--
-- Days with no signups are returned as zero rather than omitted, so the chart
-- has a flat run instead of a misleading gap.
create or replace function public.signups_per_day(window_days integer default 30)
returns table (
  brand_id uuid,
  day      date,
  signups  integer
)
language sql
stable
as $$
  with brand as (
    select b.id, b.timezone
    from public.brands b
  ),
  calendar as (
    select
      brand.id as brand_id,
      generate_series(
        (now() at time zone brand.timezone)::date - (greatest(window_days, 1) - 1),
        (now() at time zone brand.timezone)::date,
        interval '1 day'
      )::date as day
    from brand
  ),
  counted as (
    select
      c.brand_id,
      (c.signup_at at time zone b.timezone)::date as day,
      count(*)::integer as signups
    from public.contacts c
    join public.brands b on b.id = c.brand_id
    where c.signup_at is not null
      -- A signup cannot be in the future; those rows are reported separately.
      and c.signup_at <= now()
      and c.signup_at >= now() - make_interval(days => greatest(window_days, 1))
    group by c.brand_id, 2
  )
  select
    calendar.brand_id,
    calendar.day,
    coalesce(counted.signups, 0)::integer
  from calendar
  left join counted
    on counted.brand_id = calendar.brand_id
   and counted.day = calendar.day
  order by calendar.day;
$$;

comment on function public.signups_per_day(integer) is
  'Signups per day in the brand''s own timezone, zero-filled, excluding '
  'future-dated rows. SECURITY INVOKER, so RLS applies.';

revoke all on function public.signups_per_day(integer) from public;
grant execute on function public.signups_per_day(integer) to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- How each campaign performed — both ways
-- ---------------------------------------------------------------------------
-- The provider's figures and the event log's figures are returned side by
-- side, never reconciled. `opens` and `people_opened` are deliberately
-- separate: one recipient opening twice is two opens but one person, and the
-- provider's own export proves the distinction matters — KIL-0016 reports
-- 12,679 opens against 10,640 sent.
--
-- `has_events` exists so the screen can distinguish "this campaign got no
-- engagement" from "we hold no engagement log for this campaign". CMP-014
-- claims 3,600 sent and 1,800 opens with not a single event recorded; showing
-- a row of zeros without that distinction would be a quietly wrong number.
create or replace function public.campaign_performance()
returns table (
  campaign_id         uuid,
  brand_id            uuid,
  external_id         text,
  name                text,
  channel             public.channel,
  sent_at             timestamptz,
  spend               numeric,
  reported_sent       integer,
  reported_delivered  integer,
  reported_bounced    integer,
  reported_opens      integer,
  reported_clicks     integer,
  log_opens           integer,
  log_clicks          integer,
  log_bounces         integer,
  log_complaints      integer,
  log_unsubscribes    integer,
  people_opened       integer,
  people_clicked      integer,
  people_reached      integer,
  has_events          boolean
)
language sql
stable
as $$
  select
    c.id,
    c.brand_id,
    c.external_id,
    c.name,
    c.channel,
    c.sent_at,
    c.spend,
    c.reported_sent,
    c.reported_delivered,
    c.reported_bounced,
    c.reported_opens,
    c.reported_clicks,
    coalesce(e.opens, 0)::integer,
    coalesce(e.clicks, 0)::integer,
    coalesce(e.bounces, 0)::integer,
    coalesce(e.complaints, 0)::integer,
    coalesce(e.unsubscribes, 0)::integer,
    coalesce(e.people_opened, 0)::integer,
    coalesce(e.people_clicked, 0)::integer,
    coalesce(e.people_reached, 0)::integer,
    coalesce(e.total, 0) > 0
  from public.campaigns c
  left join lateral (
    select
      count(*)                                                        as total,
      count(*) filter (where ev.event_type = 'open')                  as opens,
      count(*) filter (where ev.event_type = 'click')                 as clicks,
      count(*) filter (where ev.event_type = 'bounce')                as bounces,
      count(*) filter (where ev.event_type = 'complaint')             as complaints,
      count(*) filter (where ev.event_type = 'unsubscribe')           as unsubscribes,
      count(distinct ev.contact_id) filter (where ev.event_type = 'open')  as people_opened,
      count(distinct ev.contact_id) filter (where ev.event_type = 'click') as people_clicked,
      count(distinct ev.contact_id)                                   as people_reached
    from public.contact_events ev
    where ev.campaign_id = c.id
  ) e on true;
$$;

comment on function public.campaign_performance() is
  'Per-campaign figures from the provider and from the event log, side by '
  'side and never reconciled. SECURITY INVOKER, so RLS applies.';

revoke all on function public.campaign_performance() from public;
grant execute on function public.campaign_performance() to authenticated, service_role;

-- ===========================================================================
-- Phase 4 — contactability as state, not as a question asked every time
-- ===========================================================================
--
-- The first version of contactability_breakdown() computed the answer by
-- joining 95,176 contacts against 371,249 events on every dashboard load. It
-- was correct and it took 4.3 seconds, which fails "as usable for the big
-- brand as the small one" on its own.
--
-- Worse, it was the wrong shape. "Has this person opted out?" is not a
-- question about today's query — it is a fact established the moment the
-- provider told us, and it never stops being true. Facts belong in columns.
--
-- So the two facts are stored on the contact and maintained by a trigger as
-- events arrive. This has three properties the brief asks for directly:
--
--   ORDER-INDEPENDENT  least() keeps the EARLIEST opt-out, so a report that
--                      turns up late cannot overwrite one already recorded,
--                      and applying yesterday's event today changes nothing.
--   IDEMPOTENT         re-applying the same event is a no-op, so replaying a
--                      whole file — or a provider sending a callback twice —
--                      leaves the same state.
--   ONE PATH           the trigger fires for the bulk importer and for the
--                      webhook alike, so there is no second implementation to
--                      keep in step.
--
-- A hard bounce or an unsubscribe flips contactable to false and nothing
-- flips it back, which is the behaviour required in the send phase.
-- ===========================================================================

alter table public.contacts
  add column if not exists opted_out_at timestamptz,
  add column if not exists bounced_at   timestamptz;

comment on column public.contacts.opted_out_at is
  'When this person first unsubscribed or complained, per the event log. '
  'Earliest wins, so a late report cannot overwrite an earlier opt-out.';
comment on column public.contacts.bounced_at is
  'When this person first bounced, per the event log. Earliest wins.';


-- ---------------------------------------------------------------------------
-- Applying events to contacts
-- ---------------------------------------------------------------------------
-- A statement-level trigger with a transition table, not a row-level one.
-- Row-level would fire 301,209 times during an import and issue as many
-- UPDATEs; this fires once per statement and does the work as a single
-- set-based update, which is as correct for one webhook row as for a chunk of
-- two thousand.

create or replace function app.apply_contact_events()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  with impact as (
    select
      n.contact_id,
      min(n.occurred_at) filter (where n.event_type in ('unsubscribe', 'complaint')) as opted_out_at,
      min(n.occurred_at) filter (where n.event_type = 'bounce')                      as bounced_at
    from new_rows n
    where n.contact_id is not null
      and n.event_type in ('unsubscribe', 'complaint', 'bounce')
    group by n.contact_id
  )
  update public.contacts c
     set opted_out_at = least(c.opted_out_at, impact.opted_out_at),
         bounced_at   = least(c.bounced_at,   impact.bounced_at)
    from impact
   where c.id = impact.contact_id
     -- Only touch rows that actually change. Without this, re-importing a
     -- file rewrites every contact for nothing and the updated_at trigger
     -- reports a change that did not happen.
     and (c.opted_out_at is distinct from least(c.opted_out_at, impact.opted_out_at)
       or c.bounced_at   is distinct from least(c.bounced_at,   impact.bounced_at));

  return null;
end;
$$;

comment on function app.apply_contact_events() is
  'Maintains contacts.opted_out_at / bounced_at from the event log. '
  'least() makes it order-independent; the change check makes it idempotent.';

-- least() ignores nulls in PostgreSQL — least(null, x) is x — which is exactly
-- the behaviour wanted here: the first opt-out recorded wins, and a contact
-- with no opt-out yet takes the incoming one.

drop trigger if exists contact_events_apply_to_contact on public.contact_events;

create trigger contact_events_apply_to_contact
  after insert on public.contact_events
  referencing new table as new_rows
  for each statement
  execute function app.apply_contact_events();


-- ---------------------------------------------------------------------------
-- Backfill from the events already loaded
-- ---------------------------------------------------------------------------

with impact as (
  select
    e.contact_id,
    min(e.occurred_at) filter (where e.event_type in ('unsubscribe', 'complaint')) as opted_out_at,
    min(e.occurred_at) filter (where e.event_type = 'bounce')                      as bounced_at
  from public.contact_events e
  where e.contact_id is not null
    and e.event_type in ('unsubscribe', 'complaint', 'bounce')
  group by e.contact_id
)
update public.contacts c
   set opted_out_at = least(c.opted_out_at, impact.opted_out_at),
       bounced_at   = least(c.bounced_at,   impact.bounced_at)
  from impact
 where c.id = impact.contact_id;


-- Supports the contactable predicate without reading the whole table.
create index if not exists contacts_brand_contactable_idx
  on public.contacts (brand_id)
  where deleted_at is null
    and consent_marketing
    and opted_out_at is null
    and bounced_at is null;


-- ---------------------------------------------------------------------------
-- The waterfall, now a single pass over one table
-- ---------------------------------------------------------------------------
-- Same buckets, same order, same numbers — the ordering of the CASE is still a
-- decision: someone both removed and unsubscribed is counted once, under the
-- first reason they are unreachable, so the buckets sum to the total exactly.

create or replace function public.contactability_breakdown()
returns table (
  brand_id             uuid,
  total                integer,
  removed              integer,
  no_consent           integer,
  status_unsubscribed  integer,
  status_bounced       integer,
  suppressed           integer,
  opted_out_in_log     integer,
  bounced_in_log       integer,
  contactable          integer,
  future_dated_signups integer,
  latest_signup_at     timestamptz
)
language sql
stable
as $$
  with bucketed as (
    select
      c.brand_id,
      c.signup_at,
      case
        when c.deleted_at is not null   then 'removed'
        when not c.consent_marketing    then 'no_consent'
        when c.status = 'unsubscribed'  then 'status_unsubscribed'
        when c.status = 'bounced'       then 'status_bounced'
        when c.suppressed_until > now() then 'suppressed'
        when c.opted_out_at is not null then 'opted_out_in_log'
        when c.bounced_at is not null   then 'bounced_in_log'
        else 'contactable'
      end as bucket
    from public.contacts c
  )
  select
    bucketed.brand_id,
    count(*)::integer,
    count(*) filter (where bucket = 'removed')::integer,
    count(*) filter (where bucket = 'no_consent')::integer,
    count(*) filter (where bucket = 'status_unsubscribed')::integer,
    count(*) filter (where bucket = 'status_bounced')::integer,
    count(*) filter (where bucket = 'suppressed')::integer,
    count(*) filter (where bucket = 'opted_out_in_log')::integer,
    count(*) filter (where bucket = 'bounced_in_log')::integer,
    count(*) filter (where bucket = 'contactable')::integer,
    count(*) filter (where signup_at > now())::integer,
    max(signup_at)
  from bucketed
  group by bucketed.brand_id;
$$;

revoke all on function public.contactability_breakdown() from public;
grant execute on function public.contactability_breakdown() to authenticated, service_role;

-- ===========================================================================
-- Phase 4 — separating what a list needs from what a detail page needs
-- ===========================================================================
--
-- The first campaign_performance() answered every question at once, including
-- "how many distinct PEOPLE opened this", for all 69 campaigns, in one query.
-- That took 3.4 seconds, because counting distinct contacts across 301,209
-- events cannot use a plain index scan — it has to sort or hash the lot.
--
-- The fix is not a faster query, it is a better question. A list of campaigns
-- does not need distinct-people counts; it needs totals, which are a filtered
-- count and take 179ms for every campaign at once. A detail page needs the
-- distinct counts, but only for the one campaign being looked at, which takes
-- 126ms.
--
-- Splitting them costs nothing in honesty — both screens still label which
-- basis every number came from — and turns an unusable page into two quick
-- ones. This is the whole of "as usable for the big brand as the small one":
-- not caching, just not asking for more than the screen displays.
-- ===========================================================================

drop function if exists public.campaign_performance();

-- ---------------------------------------------------------------------------
-- The list: every campaign, provider figures beside event-log totals
-- ---------------------------------------------------------------------------
create function public.campaign_performance()
returns table (
  campaign_id        uuid,
  brand_id           uuid,
  external_id        text,
  name               text,
  channel            public.channel,
  sent_at            timestamptz,
  send_local_time    text,
  spend              numeric,
  parent_external_id text,
  reported_sent      integer,
  reported_delivered integer,
  reported_bounced   integer,
  reported_opens     integer,
  reported_clicks    integer,
  log_opens          integer,
  log_clicks         integer,
  log_bounces        integer,
  log_complaints     integer,
  log_unsubscribes   integer,
  log_total          integer,
  has_events         boolean
)
language sql
stable
as $$
  with agg as (
    select
      ev.campaign_id,
      count(*)::integer                                             as total,
      count(*) filter (where ev.event_type = 'open')::integer        as opens,
      count(*) filter (where ev.event_type = 'click')::integer       as clicks,
      count(*) filter (where ev.event_type = 'bounce')::integer      as bounces,
      count(*) filter (where ev.event_type = 'complaint')::integer   as complaints,
      count(*) filter (where ev.event_type = 'unsubscribe')::integer as unsubscribes
    from public.contact_events ev
    where ev.campaign_id is not null
    group by ev.campaign_id
  )
  select
    c.id,
    c.brand_id,
    c.external_id,
    c.name,
    c.channel,
    c.sent_at,
    c.send_local_time,
    c.spend,
    c.parent_external_id,
    c.reported_sent,
    c.reported_delivered,
    c.reported_bounced,
    c.reported_opens,
    c.reported_clicks,
    coalesce(agg.opens, 0),
    coalesce(agg.clicks, 0),
    coalesce(agg.bounces, 0),
    coalesce(agg.complaints, 0),
    coalesce(agg.unsubscribes, 0),
    coalesce(agg.total, 0),
    -- Distinguishes "nobody engaged" from "we hold no engagement log for this
    -- campaign at all". Five campaigns are in the second case, including
    -- CMP-014, which the provider reports as 3,600 sent and 1,800 opens with
    -- not one event recorded. A row of zeros without this flag would be a
    -- quietly wrong number.
    coalesce(agg.total, 0) > 0
  from public.campaigns c
  left join agg on agg.campaign_id = c.id;
$$;

comment on function public.campaign_performance() is
  'Every campaign: provider-reported figures beside event-log totals, never '
  'reconciled. SECURITY INVOKER, so RLS applies.';

revoke all on function public.campaign_performance() from public;
grant execute on function public.campaign_performance() to authenticated, service_role;


-- ---------------------------------------------------------------------------
-- The detail: one campaign, including how many distinct people
-- ---------------------------------------------------------------------------
-- Opens and openers are different numbers and the export proves it: KIL-0016
-- is reported by the provider as 12,679 opens against 10,640 sent, because one
-- recipient opening twice is two opens and one person. Any rate built on
-- "opens" therefore answers a different question from one built on "people",
-- and the screen shows both rather than picking.
create or replace function public.campaign_engagement_detail(target_campaign_id uuid)
returns table (
  people_opened      integer,
  people_clicked     integer,
  people_bounced     integer,
  people_unsubscribed integer,
  people_complained  integer,
  people_engaged     integer,
  first_event_at     timestamptz,
  last_event_at      timestamptz
)
language sql
stable
as $$
  select
    count(distinct ev.contact_id) filter (where ev.event_type = 'open')::integer,
    count(distinct ev.contact_id) filter (where ev.event_type = 'click')::integer,
    count(distinct ev.contact_id) filter (where ev.event_type = 'bounce')::integer,
    count(distinct ev.contact_id) filter (where ev.event_type = 'unsubscribe')::integer,
    count(distinct ev.contact_id) filter (where ev.event_type = 'complaint')::integer,
    count(distinct ev.contact_id)::integer,
    min(ev.occurred_at),
    max(ev.occurred_at)
  from public.contact_events ev
  where ev.campaign_id = target_campaign_id;
$$;

comment on function public.campaign_engagement_detail(uuid) is
  'Distinct-people counts for one campaign. Separate from the list because '
  'counting distinct contacts across every campaign at once takes seconds. '
  'SECURITY INVOKER, so RLS applies and a foreign campaign id returns zeros.';

revoke all on function public.campaign_engagement_detail(uuid) from public;
grant execute on function public.campaign_engagement_detail(uuid) to authenticated, service_role;

-- ===========================================================================
-- Phase 4 — searching 81,842 customers without reading 81,842 rows
-- ===========================================================================
--
-- The contacts view has to be searchable and stay quick for the brand with
-- ninety times the data of the smallest. A plain `ilike '%term%'` cannot use a
-- btree index at all — the leading wildcard defeats it — so every keystroke
-- would read the whole table.
--
-- pg_trgm indexes the three-letter sequences inside each value, which makes a
-- contains-match indexable. It is the difference between a search box that
-- feels instant for Marrakech and unusable for Kilele, and one that behaves
-- the same for both.
-- ===========================================================================

create extension if not exists pg_trgm with schema extensions;

-- One index per searchable field rather than one over a concatenation: the
-- planner can then use whichever field the term actually matches, and combine
-- them with a bitmap OR when the term could match either.
create index if not exists contacts_full_name_trgm_idx
  on public.contacts using gin (full_name extensions.gin_trgm_ops);

create index if not exists contacts_email_trgm_idx
  on public.contacts using gin (email extensions.gin_trgm_ops);

-- The customer reference is searched by prefix far more often than by
-- fragment — people paste "CT-0057" — so a plain btree earns its keep here.
create index if not exists contacts_brand_external_id_idx
  on public.contacts (brand_id, external_id text_pattern_ops);

-- ===========================================================================
-- Phase 5 — sending, safely and honestly
-- ===========================================================================
--
-- "The count on the confirmation screen is what the marketer is approving, and
--  real money and real inboxes sit on the other side of it. A send that is
--  interrupted or retried shouldn't send twice or half-send silently, and what
--  someone approved last month should still read as approved."
--
-- Four ideas carry that:
--
--   THE APPROVED LIST IS STORED, NOT RECOMPUTED.
--     send_recipients is written at the moment of approval and never
--     recalculated. If it were recomputed at dispatch, the set that goes out
--     could differ from the set that was approved — someone unsubscribes in
--     between — and the number on the confirmation screen would have been a
--     guess about the future.
--
--   ONE LIVE SEND PER CAMPAIGN.
--     A partial unique index, not a disabled button. Two browser sessions
--     pressing confirm at the same moment both reach the database, and exactly
--     one of them wins; the loser is told the campaign has already been sent.
--     A button that disables itself stops an honest double-click and nothing
--     else.
--
--   THE APPROVAL IS A SEPARATE STEP FROM THE DISPATCH.
--     A send that dies between the two is left as 'approved' with its audience
--     intact, so it can be picked up and finished rather than restarted. That
--     is what makes it resumable instead of half-sent.
--
--   THE RECORD IS IMMUTABLE HISTORY.
--     approved_count, approved_at and requested_by are written once. Whatever
--     happens to the campaign afterwards, what was approved still reads as
--     approved.
-- ===========================================================================

create type public.send_status as enum (
  'approved',     -- the marketer has confirmed; the audience is frozen
  'dispatching',  -- handed to the provider, awaiting its answer
  'sent',         -- the provider accepted it
  'failed'        -- the provider refused, or we could not reach it
);

create type public.delivery_status as enum (
  'queued',       -- in the approved list, not yet reported on
  'accepted',     -- the provider took this recipient
  'rejected',     -- the provider refused this recipient
  'delivered',
  'bounced'
);


-- ---------------------------------------------------------------------------
-- One row per approved send
-- ---------------------------------------------------------------------------

create table public.campaign_sends (
  id              uuid               primary key default gen_random_uuid(),
  brand_id        uuid               not null references public.brands (id) on delete cascade,
  campaign_id     uuid               not null,

  -- Who pressed confirm. Kept even if the account is later removed, because
  -- an approval with nobody attached is not an audit trail.
  requested_by    uuid               references auth.users (id) on delete set null,
  requested_email text               not null,

  status          public.send_status not null default 'approved',

  -- What the marketer saw and agreed to. Never recalculated.
  approved_count  integer            not null check (approved_count >= 0),
  -- What the provider said it accepted. A gap between these two is a
  -- half-send, and it is visible rather than silent.
  accepted_count  integer            check (accepted_count >= 0),
  rejected_count  integer            check (rejected_count >= 0),

  provider_batch_id text,
  -- Where phase 6 has read up to in this batch's report stream.
  events_cursor     text,

  approved_at     timestamptz        not null default now(),
  dispatched_at   timestamptz,
  completed_at    timestamptz,
  error           text,

  constraint campaign_sends_brand_id_id_key unique (brand_id, id),
  constraint campaign_sends_campaign_same_brand_fkey
    foreign key (brand_id, campaign_id) references public.campaigns (brand_id, id) on delete cascade
);

/*
 * The double-send guard, enforced by the database rather than by the interface.
 *
 * Two sessions confirming the same campaign at the same instant both issue an
 * INSERT; the second violates this index and is refused. A failed send is
 * excluded so a campaign that genuinely could not be dispatched can be tried
 * again.
 */
create unique index campaign_sends_one_live_per_campaign
  on public.campaign_sends (brand_id, campaign_id)
  where status <> 'failed';

create index campaign_sends_brand_approved_idx
  on public.campaign_sends (brand_id, approved_at desc);


-- ---------------------------------------------------------------------------
-- The approved audience, frozen
-- ---------------------------------------------------------------------------

create table public.send_recipients (
  id                  bigint generated always as identity primary key,
  brand_id            uuid                   not null references public.brands (id) on delete cascade,
  send_id             uuid                   not null,
  contact_id          uuid                   not null,

  channel             public.channel         not null,
  -- The address as it stood when approved. Storing it rather than joining to
  -- the contact means the record still shows where the message actually went,
  -- even if the customer later changes their address.
  destination         text                   not null,

  status              public.delivery_status not null default 'queued',
  provider_message_id text,
  last_event_at       timestamptz,
  updated_at          timestamptz            not null default now(),

  -- One row per person per send: the provider reporting the same delivery
  -- twice cannot create a second recipient.
  constraint send_recipients_send_contact_key unique (send_id, contact_id),

  constraint send_recipients_send_same_brand_fkey
    foreign key (brand_id, send_id)    references public.campaign_sends (brand_id, id) on delete cascade,
  constraint send_recipients_contact_same_brand_fkey
    foreign key (brand_id, contact_id) references public.contacts (brand_id, id) on delete cascade
);

create index send_recipients_send_status_idx on public.send_recipients (send_id, status);
create index send_recipients_brand_idx       on public.send_recipients (brand_id);


-- ---------------------------------------------------------------------------
-- Row level security — the same one line, and one role check
-- ---------------------------------------------------------------------------

alter table public.campaign_sends  enable row level security;
alter table public.send_recipients enable row level security;

create policy campaign_sends_isolation on public.campaign_sends
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));

create policy send_recipients_isolation on public.send_recipients
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));

/*
 * The first and only write a signed-in user may make anywhere in this project,
 * and it is the one the brief singles out: owners can send, analysts cannot.
 *
 * The check lives here, in the database, so it holds for a request made with
 * curl and the publishable key just as it does for the button. The application
 * checks the role too — but that check is a courtesy that produces a decent
 * error message, and this one is the guarantee.
 *
 * Note both halves: the row must belong to a brand the user is in AND the user
 * must be an owner of it. Either alone would be a hole.
 */
create policy campaign_sends_owner_may_approve on public.campaign_sends
  for insert to authenticated
  with check (
    brand_id in (select app.current_user_brand_ids())
    and app.is_brand_owner(brand_id)
  );

revoke all on public.campaign_sends  from anon, authenticated;
revoke all on public.send_recipients from anon, authenticated;

grant select         on public.campaign_sends  to authenticated;
grant insert         on public.campaign_sends  to authenticated;
grant select         on public.send_recipients to authenticated;


-- ---------------------------------------------------------------------------
-- What a send looks like from the outside
-- ---------------------------------------------------------------------------
-- Grouped in the database because a send can hold 36,185 recipients and a
-- progress bar does not need to read them.

create or replace function public.send_progress(target_send_id uuid)
returns table (
  status              public.delivery_status,
  recipient_count     integer
)
language sql
stable
as $$
  select r.status, count(*)::integer
  from public.send_recipients r
  where r.send_id = target_send_id
  group by r.status
  order by count(*) desc;
$$;

comment on function public.send_progress(uuid) is
  'Recipient counts by delivery status for one send. SECURITY INVOKER, so RLS '
  'applies and another brand''s send id returns nothing.';

revoke all on function public.send_progress(uuid) from public;
grant execute on function public.send_progress(uuid) to authenticated, service_role;

-- ===========================================================================
-- Phase 6 — the provider talks back, and we keep up
-- ===========================================================================
--
-- "Delivery, bounces, opens and unsubscribes arrive over time, including while
--  your app isn't looking, and your picture of who's contactable has to stay
--  correct against what actually happened."
--
-- The provider's documentation says its report stream is "clean and complete:
-- every event is delivered exactly once and in order". It is neither, and that
-- was measured rather than assumed:
--
--   * polling one batch three times returned the same event ids three times;
--   * within a single page, ids run ahead of timestamps — the first page of a
--     real send reads 11:55:45Z, 11:56:40Z, 11:55:46Z.
--
-- So nothing here relies on a report arriving once, or in order, or at all.
-- Three mechanisms carry that, and two of them already existed:
--
--   IDEMPOTENT   Provider reports land in contact_events keyed on the
--                provider's own event_id, against the existing
--                unique (brand_id, external_id). Re-reading a page inserts
--                nothing. This is the same constraint that made re-importing
--                a seed file a no-op in phase 3.
--
--   ORDER-FREE   Contactability is maintained by the trigger added in phase 4,
--                which keeps the EARLIEST opt-out with least(). A report that
--                turns up late cannot undo one already recorded.
--
--   PRECEDENCE   Delivery status is ranked rather than overwritten, so a
--                'delivered' arriving after a 'bounced' does not quietly mark
--                a dead address as reachable again.
-- ===========================================================================

alter table public.campaign_sends
  add column if not exists last_synced_at  timestamptz,
  add column if not exists events_applied  integer not null default 0
    check (events_applied >= 0);

comment on column public.campaign_sends.events_cursor is
  'Where the provider report stream has been read up to. An optimisation '
  'only: correctness never depends on it, because events are keyed on the '
  'provider event id and may arrive more than once regardless.';


-- ---------------------------------------------------------------------------
-- Delivery status is ranked, not overwritten
-- ---------------------------------------------------------------------------
-- The ordering is a judgement, and it is deliberately pessimistic about
-- reachability: once a message to somebody has bounced, a later 'delivered'
-- report for the same recipient does not make them reachable again. Getting
-- this backwards would mean a stale report resurrecting a dead address, which
-- is the exact failure the brief describes.

create or replace function app.delivery_rank(state public.delivery_status)
returns integer
language sql
immutable
as $$
  select case state
    when 'queued'    then 0
    when 'accepted'  then 1
    when 'delivered' then 2
    when 'rejected'  then 3
    when 'bounced'   then 4
  end;
$$;

comment on function app.delivery_rank(public.delivery_status) is
  'Precedence for delivery status. Higher wins, so a late "delivered" cannot '
  'overwrite a "bounced".';


/**
 * Applies one page of provider reports, atomically.
 *
 * Taking arrays rather than one row at a time means a page of a thousand
 * events is a single statement, and — more importantly — it is one
 * transaction. A page is applied completely or not at all, so an interrupted
 * sync cannot leave a recipient marked delivered while the matching row in the
 * engagement log is missing.
 *
 * The brand is passed in by the caller, which knows it from the send it is
 * syncing. It is never taken from the provider: the provider's own brand_code
 * field comes back as "account" regardless of what was sent, and letting a
 * third party decide which tenant a row belongs to would put the isolation
 * guarantee in their hands.
 */
create or replace function app.apply_provider_reports(
  target_brand_id    uuid,
  target_send_id     uuid,
  target_campaign_id uuid,
  send_channel       public.channel,
  event_ids          text[],
  recipient_refs     text[],
  event_types        text[],
  occurred_ats       timestamptz[]
)
returns TABLE (engagement_inserted integer, recipients_touched integer, unmatched integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  inserted_count integer := 0;
  touched_count  integer := 0;
  unmatched_count integer := 0;
begin
  create temporary table incoming on commit drop as
  select
    u.event_id,
    u.recipient_ref,
    u.event_type,
    u.occurred_at,
    c.id as contact_id
  from unnest(event_ids, recipient_refs, event_types, occurred_ats)
       as u(event_id, recipient_ref, event_type, occurred_at)
  -- Resolved within this brand only. A recipient reference the provider
  -- echoes back that does not belong to this brand matches nothing.
  left join public.contacts c
    on c.brand_id = target_brand_id
   and c.external_id = u.recipient_ref;

  select count(*)::integer into unmatched_count from incoming where contact_id is null;

  /*
   * Engagement. 'delivered' is not recorded here: the portal's event log holds
   * things a customer did, and being delivered to is not one of them. It is
   * recorded against the recipient instead, below.
   */
  with mapped as (
    select
      i.event_id,
      i.contact_id,
      i.occurred_at,
      case i.event_type
        when 'bounced'      then 'bounce'::public.event_type
        when 'opened'       then 'open'::public.event_type
        when 'unsubscribed' then 'unsubscribe'::public.event_type
      end as mapped_type
    from incoming i
    where i.contact_id is not null
      and i.event_type in ('bounced', 'opened', 'unsubscribed')
  ),
  written as (
    insert into public.contact_events (
      brand_id, external_id, contact_id, campaign_id, event_type, channel, occurred_at
    )
    select
      target_brand_id, m.event_id, m.contact_id, target_campaign_id,
      m.mapped_type, send_channel, m.occurred_at
    from mapped m
    -- The idempotency key. The provider re-serves events it has already given
    -- out, so this is hit constantly and by design.
    on conflict (brand_id, external_id) do nothing
    returning 1
  )
  select count(*)::integer into inserted_count from written;

  -- Delivery status, ranked so a late report cannot downgrade a worse one.
  with ranked as (
    select
      i.contact_id,
      max(
        app.delivery_rank(
          case i.event_type
            when 'delivered' then 'delivered'::public.delivery_status
            when 'bounced'   then 'bounced'::public.delivery_status
            else 'accepted'::public.delivery_status
          end
        )
      ) as incoming_rank,
      max(i.occurred_at) as last_at
    from incoming i
    where i.contact_id is not null
      and i.event_type in ('delivered', 'bounced')
    group by i.contact_id
  ),
  updated as (
    update public.send_recipients r
       set status = case
             when ranked.incoming_rank = 4 then 'bounced'::public.delivery_status
             when ranked.incoming_rank = 2 then 'delivered'::public.delivery_status
             else r.status
           end,
           last_event_at = greatest(r.last_event_at, ranked.last_at),
           updated_at = now()
      from ranked
     where r.send_id = target_send_id
       and r.contact_id = ranked.contact_id
       and ranked.incoming_rank > app.delivery_rank(r.status)
    returning 1
  )
  select count(*)::integer into touched_count from updated;

  return query select inserted_count, touched_count, unmatched_count;
end;
$$;

comment on function app.apply_provider_reports is
  'Applies one page of provider delivery reports idempotently and '
  'order-independently. The brand is supplied by the caller, never by the '
  'provider.';

revoke all on function app.apply_provider_reports from public;
grant execute on function app.apply_provider_reports to service_role;

-- ===========================================================================
-- Phase 6 — making the report applier reachable, and atomic in one statement
-- ===========================================================================
--
-- Two corrections to the previous migration, both found by running it.
--
-- 1. It lived in the `app` schema, which is deliberately not exposed through
--    the API — that is the whole reason the isolation predicate lives there.
--    But this function has to be called BY the application over the API, so it
--    belongs in `public`. Exposing the name costs nothing: execute is granted
--    to service_role alone, so anon and authenticated cannot call it. The
--    same arrangement already applies to security_coverage().
--
-- 2. It used a temporary table across two statements. One statement with
--    common table expressions is simpler and genuinely atomic: a page of
--    reports is applied in full or not at all, so an interrupted sync can
--    never leave a recipient marked delivered while the matching row in the
--    engagement log is missing.
-- ===========================================================================

drop function if exists app.apply_provider_reports(
  uuid, uuid, uuid, public.channel, text[], text[], text[], timestamptz[]
);

create or replace function public.apply_provider_reports(
  target_brand_id    uuid,
  target_send_id     uuid,
  target_campaign_id uuid,
  send_channel       public.channel,
  event_ids          text[],
  recipient_refs     text[],
  event_types        text[],
  occurred_ats       timestamptz[]
)
returns table (engagement_inserted integer, recipients_touched integer, unmatched integer)
language sql
security definer
set search_path = ''
as $$
  with incoming as (
    select
      u.event_id,
      u.event_type,
      u.occurred_at,
      c.id as contact_id
    from unnest(event_ids, recipient_refs, event_types, occurred_ats)
         as u(event_id, recipient_ref, event_type, occurred_at)
    /*
     * Resolved within this brand only, from the brand the CALLER supplies —
     * which it knows from the send it is syncing. The provider's own
     * brand_code field is ignored entirely: it comes back as "account"
     * whatever was sent, and letting a third party decide which tenant a row
     * belongs to would hand them the isolation guarantee.
     */
    left join public.contacts c
      on c.brand_id = target_brand_id
     and c.external_id = u.recipient_ref
  ),

  -- 'delivered' is not engagement. The event log holds things a customer did,
  -- and being delivered to is not one of them; it is recorded against the
  -- recipient instead.
  mapped as (
    select
      i.event_id,
      i.contact_id,
      i.occurred_at,
      case i.event_type
        when 'bounced'      then 'bounce'::public.event_type
        when 'opened'       then 'open'::public.event_type
        when 'unsubscribed' then 'unsubscribe'::public.event_type
      end as mapped_type
    from incoming i
    where i.contact_id is not null
      and i.event_type in ('bounced', 'opened', 'unsubscribed')
  ),

  written as (
    insert into public.contact_events (
      brand_id, external_id, contact_id, campaign_id, event_type, channel, occurred_at
    )
    select
      target_brand_id, m.event_id, m.contact_id, target_campaign_id,
      m.mapped_type, send_channel, m.occurred_at
    from mapped m
    -- The idempotency key, and the same constraint that made re-importing a
    -- seed file a no-op. The provider re-serves events it has already given
    -- out, so this conflict is hit constantly and by design.
    on conflict (brand_id, external_id) do nothing
    returning 1
  ),

  -- Delivery status is ranked, never overwritten: a 'delivered' arriving after
  -- a 'bounced' must not mark a dead address reachable again.
  ranked as (
    select
      i.contact_id,
      max(app.delivery_rank(
        case i.event_type
          when 'delivered' then 'delivered'::public.delivery_status
          when 'bounced'   then 'bounced'::public.delivery_status
          else 'accepted'::public.delivery_status
        end
      )) as incoming_rank,
      max(i.occurred_at) as last_at
    from incoming i
    where i.contact_id is not null
      and i.event_type in ('delivered', 'bounced')
    group by i.contact_id
  ),

  updated as (
    update public.send_recipients r
       set status = case
             when ranked.incoming_rank = 4 then 'bounced'::public.delivery_status
             when ranked.incoming_rank = 2 then 'delivered'::public.delivery_status
             else r.status
           end,
           last_event_at = greatest(r.last_event_at, ranked.last_at),
           updated_at = now()
      from ranked
     where r.send_id = target_send_id
       and r.contact_id = ranked.contact_id
       and ranked.incoming_rank > app.delivery_rank(r.status)
    returning 1
  )

  select
    (select count(*)::integer from written),
    (select count(*)::integer from updated),
    (select count(*)::integer from incoming where contact_id is null);
$$;

comment on function public.apply_provider_reports is
  'Applies one page of provider delivery reports idempotently and '
  'order-independently, in a single statement. The brand is supplied by the '
  'caller, never by the provider. service_role only.';

revoke all on function public.apply_provider_reports from public, anon, authenticated;
grant execute on function public.apply_provider_reports to service_role;

-- ===========================================================================
-- Phase 7 — a link safe to send to a stranger
-- ===========================================================================
--
-- "It shows one campaign's results and nothing else, and nothing a stranger
--  could reach by guessing the address or getting past the password."
--
-- Two sentences, two separate problems, and they need different answers.
--
--   GUESSING THE ADDRESS is answered by the token being 256 bits of
--   randomness. There is nothing to enumerate, no sequence to walk, and an
--   unknown token is answered exactly as a revoked one is — so probing tells
--   an attacker nothing about which tokens exist.
--
--   GETTING PAST THE PASSWORD is answered by there being nothing else behind
--   it. Even with the right token and the right password, the page can only
--   ever show aggregates for ONE campaign. There is no id to substitute, no
--   list to page through, no customer rows. The blast radius of a leaked link
--   is precisely the thing it was shared to show.
--
-- The password is never stored, never travels back to the application, and is
-- never compared in JavaScript. It is hashed with bcrypt inside the database,
-- and the comparison happens in the function below — so even a full dump of
-- the table hands an attacker work rather than passwords.
-- ===========================================================================

create extension if not exists pgcrypto with schema extensions;

create type public.report_outcome as enum ('ok', 'denied', 'locked');


create table public.shared_reports (
  id             uuid        primary key default gen_random_uuid(),
  brand_id       uuid        not null references public.brands (id) on delete cascade,
  campaign_id    uuid        not null,

  -- 256 bits, generated with a CSPRNG in the application. Unique so a
  -- collision is an error rather than a silent overwrite, and long enough that
  -- guessing is not a strategy.
  token          text        not null unique check (length(token) >= 40),

  -- bcrypt. The plain password exists only in the browser of the person
  -- creating it and in the request that created it.
  password_hash  text        not null,

  created_by     uuid        references auth.users (id) on delete set null,
  created_email  text        not null,
  created_at     timestamptz not null default now(),

  -- Revocation is a timestamp rather than a delete, so a report that was
  -- shared and later withdrawn leaves a record that it existed.
  revoked_at     timestamptz,

  last_viewed_at timestamptz,
  view_count     integer     not null default 0 check (view_count >= 0),

  -- Password attempts are counted so a shared link cannot be brute-forced at
  -- leisure. A wrong password is cheap for an attacker and expensive for
  -- nobody else; this makes it cost time.
  failed_attempts integer    not null default 0 check (failed_attempts >= 0),
  locked_until    timestamptz,

  constraint shared_reports_brand_id_id_key unique (brand_id, id),
  constraint shared_reports_campaign_same_brand_fkey
    foreign key (brand_id, campaign_id) references public.campaigns (brand_id, id) on delete cascade
);

create index shared_reports_brand_campaign_idx on public.shared_reports (brand_id, campaign_id);


-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------
-- The same one line for reading, and the same owner gate for creating that
-- campaign_sends uses. The public page does NOT read this table as anon — it
-- goes through the function below, which is why anon is granted nothing here.

alter table public.shared_reports enable row level security;

create policy shared_reports_isolation on public.shared_reports
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));

create policy shared_reports_owner_may_publish on public.shared_reports
  for insert to authenticated
  with check (
    brand_id in (select app.current_user_brand_ids())
    and app.is_brand_owner(brand_id)
  );

revoke all on public.shared_reports from anon, authenticated;
grant select, insert on public.shared_reports to authenticated;


-- ---------------------------------------------------------------------------
-- Opening a shared report
-- ---------------------------------------------------------------------------
/**
 * Checks a token and password, and says only whether the door opened.
 *
 * It deliberately returns an outcome and NOT the report data. Were it to
 * return the figures, it would be an anon-callable endpoint that hands out a
 * campaign's results to anyone who can guess a token and a password — and any
 * future caller could reach it directly. Instead the application verifies the
 * password here, then reads the aggregates under the service role, which is
 * not reachable from a browser at all.
 *
 * 'denied' is returned identically for a token that does not exist, a token
 * that has been revoked, and a correct token with the wrong password. A
 * stranger probing the URL space learns nothing about which tokens are real.
 *
 * SECURITY DEFINER because anon must be able to call it, and anon has no
 * privilege on shared_reports whatsoever. The search_path is pinned for the
 * usual reason.
 */
create or replace function public.unlock_shared_report(
  report_token text,
  attempt      text
)
returns public.report_outcome
language plpgsql
security definer
set search_path = ''
as $$
declare
  found   public.shared_reports%rowtype;
  matches boolean;
begin
  select * into found
  from public.shared_reports r
  where r.token = report_token
    and r.revoked_at is null;

  -- No such token, or withdrawn. Identical answer to a wrong password, so
  -- probing cannot distinguish the two.
  if not found.id is not null then
    return 'denied';
  end if;

  if found.locked_until is not null and found.locked_until > now() then
    return 'locked';
  end if;

  -- bcrypt: crypt() re-hashes the attempt with the stored salt and compares.
  matches := extensions.crypt(attempt, found.password_hash) = found.password_hash;

  if matches then
    update public.shared_reports
       set view_count      = view_count + 1,
           last_viewed_at  = now(),
           failed_attempts = 0,
           locked_until    = null
     where id = found.id;
    return 'ok';
  end if;

  -- Five wrong guesses buys a fifteen-minute pause. Enough to make an
  -- automated attack pointless; short enough that a client who mistyped is
  -- not locked out of their own report for the afternoon.
  update public.shared_reports
     set failed_attempts = failed_attempts + 1,
         locked_until = case
           when failed_attempts + 1 >= 5 then now() + interval '15 minutes'
           else locked_until
         end
   where id = found.id;

  return 'denied';
end;
$$;

comment on function public.unlock_shared_report(text, text) is
  'Verifies a shared report token and password. Returns only an outcome, '
  'never the report, so it cannot be used as a data endpoint.';

revoke all on function public.unlock_shared_report(text, text) from public;
grant execute on function public.unlock_shared_report(text, text) to anon, authenticated, service_role;


/**
 * Hashes a password on its way in.
 *
 * Exists so the plain password never has to be hashed in application code and
 * never sits in a JavaScript variable longer than the request. bcrypt with a
 * work factor of 12 — deliberately slow, which is the point.
 */
create or replace function public.hash_report_password(plain text)
returns text
language sql
volatile
security definer
set search_path = ''
as $$
  select extensions.crypt(plain, extensions.gen_salt('bf', 12));
$$;

revoke all on function public.hash_report_password(text) from public, anon;
grant execute on function public.hash_report_password(text) to authenticated, service_role;

-- ===========================================================================
-- Phase 6 correction — a send is more than one provider call
-- ===========================================================================
--
-- Two faults found by reading the live data back, not by a test.
--
-- 1. PostgREST caps every response at 1,000 rows (`db.max_rows`), and it does
--    so silently: `.limit(50000)` and `.range(0, 49999)` both come back with
--    exactly 1,000 rows and no error. The audience freeze in dispatch.ts
--    trusted that limit, so a Kilele send recorded approved_count 23,969
--    while only the first 1,000 people were ever written to send_recipients.
--    The portal then displayed a number it had no rows to support — the exact
--    half-send the brief warns about, except the portal was the one lying.
--
-- 2. The provider's own documentation claims "Up to 100,000 recipients per
--    call" and that `rejected` is "normally empty". Three separate sends of
--    1,000 came back accepted 500 / rejected 500, while a send of 240 came
--    back 240 / 0. There is a hard cap at 500 per call that the docs deny.
--    (This is the same provider whose docs promise events are delivered
--    "exactly once and in order"; they repeat and arrive out of order.)
--
-- Fixing (1) alone would have made a 23,969-person send honest but useless:
-- 500 accepted and 23,469 marked rejected. So a send now fans out into as
-- many provider calls as it needs, and each call is recorded here.
--
-- campaign_sends keeps provider_batch_id and events_cursor, holding the FIRST
-- batch. Sends made before this migration have no rows here, and the reader
-- falls back to those columns, so existing sends still sync.
-- ===========================================================================

create table if not exists public.send_batches (
  id                bigint      generated always as identity primary key,
  brand_id          uuid        not null references public.brands (id) on delete cascade,
  send_id           uuid        not null,

  -- 0, 1, 2 … in dispatch order, so the screen can say "batch 3 of 48"
  -- without sorting on a provider-generated string.
  sequence          integer     not null check (sequence >= 0),

  provider_batch_id text        not null,
  recipient_count   integer     not null check (recipient_count >= 0),
  accepted_count    integer     not null default 0 check (accepted_count >= 0),
  rejected_count    integer     not null default 0 check (rejected_count >= 0),

  -- Each batch has its own report stream, so each carries its own cursor.
  -- One cursor for the whole send would re-read batch 1 forty-eight times.
  events_cursor     text,
  events_applied    integer     not null default 0 check (events_applied >= 0),
  last_synced_at    timestamptz,

  created_at        timestamptz not null default now(),

  constraint send_batches_send_sequence_key unique (send_id, sequence),

  -- The brand travels with the reference on both sides, so a batch cannot be
  -- attached to another brand's send even by a client with RLS switched off.
  constraint send_batches_send_same_brand_fkey
    foreign key (brand_id, send_id) references public.campaign_sends (brand_id, id) on delete cascade
);

create index if not exists send_batches_send_idx on public.send_batches (send_id, sequence);

alter table public.send_batches enable row level security;

create policy send_batches_isolation on public.send_batches
  for select to authenticated
  using (brand_id in (select app.current_user_brand_ids()));

revoke all    on public.send_batches from anon, authenticated;
grant  select on public.send_batches to   authenticated;


-- ---------------------------------------------------------------------------
-- Marking a chunk's outcome without putting 23,969 ids in a URL
-- ---------------------------------------------------------------------------
-- The previous code marked recipients with `.in('contact_id', [...])`, which
-- PostgREST renders into the query string. At 500 uuids that is an 18 KB URL —
-- past what most proxies accept — and at 23,969 it is hopeless. Arrays in a
-- POST body have no such limit, and this matches how apply_provider_reports()
-- already takes its work.
--
-- Recipients are named by the contact's external_id, which is what the
-- provider echoes back. Resolution is confined to the caller's brand: a
-- reference belonging to another tenant matches nothing rather than matching
-- the wrong person.
-- ---------------------------------------------------------------------------

create or replace function public.mark_send_recipients(
  target_brand_id uuid,
  target_send_id  uuid,
  accepted_refs   text[],
  rejected_refs   text[]
)
returns table (accepted integer, rejected integer)
language sql
security definer
set search_path = ''
as $$
  with accepted_rows as (
    update public.send_recipients r
       set status = 'accepted', updated_at = now()
      from public.contacts c
     where r.send_id  = target_send_id
       and r.brand_id = target_brand_id
       and c.id       = r.contact_id
       and c.brand_id = target_brand_id
       and c.external_id = any (accepted_refs)
    returning 1
  ),
  rejected_rows as (
    update public.send_recipients r
       set status = 'rejected', updated_at = now()
      from public.contacts c
     where r.send_id  = target_send_id
       and r.brand_id = target_brand_id
       and c.id       = r.contact_id
       and c.brand_id = target_brand_id
       and c.external_id = any (rejected_refs)
    returning 1
  )
  select (select count(*) from accepted_rows)::integer,
         (select count(*) from rejected_rows)::integer;
$$;

-- Only the server may mark a send. A signed-in user has no write access to
-- send_recipients at all, and this function must not become a way around that.
revoke all     on function public.mark_send_recipients(uuid, uuid, text[], text[]) from anon, authenticated;
grant  execute on function public.mark_send_recipients(uuid, uuid, text[], text[]) to   service_role;

-- ===========================================================================
-- Correction — revoking from a role list is not revoking from PUBLIC
-- ===========================================================================
--
-- The previous migration wrote:
--
--   revoke all on function public.mark_send_recipients(...) from anon, authenticated;
--
-- which reads as though it locks the function down, and does not. Postgres
-- grants EXECUTE on a new function to PUBLIC, and `authenticated` holds that
-- privilege through PUBLIC rather than in its own right — so revoking it from
-- the role by name leaves the inherited grant untouched.
--
-- The test that caught it signs in as a real owner and calls the function:
-- it expected an error and got a result. Every other function in this project
-- revokes `from public` first; this one did not, and nothing but a test that
-- actually tried it would have shown that.
-- ===========================================================================

revoke all     on function public.mark_send_recipients(uuid, uuid, text[], text[]) from public, anon, authenticated;
grant  execute on function public.mark_send_recipients(uuid, uuid, text[], text[]) to   service_role;
