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
