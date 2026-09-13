-- GENERATED FILE — DO NOT EDIT.
--
-- Built from supabase/migrations by `npm run schema:build`.
-- The migrations are the source of truth; this is a single-file view of
-- them for reading. Edit a migration, then regenerate.
--
-- Migrations included (1):
--   20260913160000_brands_and_isolation.sql

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
