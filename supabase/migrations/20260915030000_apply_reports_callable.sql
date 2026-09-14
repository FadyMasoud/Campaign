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
