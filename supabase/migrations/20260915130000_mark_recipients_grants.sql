-- ===========================================================================
-- Correction — revoking from a role list is not revoking from PUBLIC
-- ===========================================================================
--
-- The previous migration wrote:
--
--   revoke all on function public.mark_send_recipients(...) from anon, authenticated;
--
-- which reads as though it locks the function down, and does not. Postgres
-- grants EXECUTE on a new function to PUBLIC, and `authenticated` holds that
-- privilege through PUBLIC rather than in its own right — so revoking it from
-- the role by name leaves the inherited grant untouched.
--
-- The test that caught it signs in as a real owner and calls the function:
-- it expected an error and got a result. Every other function in this project
-- revokes `from public` first; this one did not, and nothing but a test that
-- actually tried it would have shown that.
-- ===========================================================================

revoke all     on function public.mark_send_recipients(uuid, uuid, text[], text[]) from public, anon, authenticated;
grant  execute on function public.mark_send_recipients(uuid, uuid, text[], text[]) to   service_role;
