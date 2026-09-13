'use client'

import { createBrowserClient } from '@supabase/ssr'
import { requirePublicEnv } from '@/lib/env/public'

/**
 * CLIENT #1 of 3 — the browser client.
 *
 * Runs in the user's browser, holds the publishable key, and acts AS THE
 * SIGNED-IN USER. Every query it sends is filtered by Row Level Security in
 * the database, so the worst a hostile user can do by editing our JavaScript
 * is ask for data — and get back only their own brand's rows.
 *
 * Use for: live UI that reacts to the signed-in user (realtime, client-side
 * search). Never for anything that must be trusted.
 */
export function createBrowserSupabaseClient() {
  const env = requirePublicEnv()

  return createBrowserClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}
