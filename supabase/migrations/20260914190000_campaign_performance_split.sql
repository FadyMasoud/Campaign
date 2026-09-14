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
