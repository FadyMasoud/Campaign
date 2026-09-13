import 'server-only'

import { createClient } from '@supabase/supabase-js'
import { requirePublicEnv } from '@/lib/env/public'
import { requireServerEnv } from '@/lib/env/server'

/**
 * CLIENT #3 of 3 — the admin client. Handle with care.
 *
 * Holds the service-role (secret) key, which BYPASSES ROW LEVEL SECURITY
 * ENTIRELY. It can read and write every brand's data. None of the isolation
 * guarantees in this project apply to it.
 *
 * It exists because a few jobs legitimately have no logged-in user:
 *   - importing seed CSVs,
 *   - receiving webhooks from the messaging provider,
 *   - serving a password-protected public report to someone with no account.
 *
 * Rules for using it, which reviewers will check:
 *   1. Only ever inside server code. The `server-only` import above enforces it.
 *   2. Every call must filter by brand_id EXPLICITLY in the query. The database
 *      will not do it for you here — that safety net is switched off.
 *   3. Prefer createServerSupabaseClient(). Reach for this only when there is
 *      genuinely no user to act as.
 */
export function createAdminSupabaseClient() {
  const env = requirePublicEnv()
  const serviceRoleKey = requireServerEnv('SUPABASE_SERVICE_ROLE_KEY')

  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, serviceRoleKey, {
    auth: {
      // There is no user and no browser here, so there is no session to keep.
      // Leaving these on would have the admin client try to persist and refresh
      // tokens on a server that handles many users' requests at once.
      persistSession: false,
      autoRefreshToken: false,
    },
  })
}
