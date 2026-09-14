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
