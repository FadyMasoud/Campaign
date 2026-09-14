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
