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
