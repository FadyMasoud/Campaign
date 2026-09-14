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
