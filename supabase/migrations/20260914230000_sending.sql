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
