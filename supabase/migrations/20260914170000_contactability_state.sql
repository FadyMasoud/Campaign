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
