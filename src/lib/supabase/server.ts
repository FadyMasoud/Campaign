import 'server-only'

import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { requirePublicEnv } from '@/lib/env/public'

/**
 * CLIENT #2 of 3 — the server client, acting as the signed-in user.
 *
 * This is the one you should reach for by default on the server. It uses the
 * same publishable key as the browser, and reads the user's session from the
 * request cookies, so the database still sees a specific logged-in person and
 * still applies Row Level Security to every query.
 *
 * Use for: Server Components, Server Actions, and route handlers that read or
 * write on behalf of the user.
 */
export async function createServerSupabaseClient() {
  const env = requirePublicEnv()

  // In Next.js 15+ `cookies()` is async, because the framework resolves the
  // incoming request lazily. Forgetting the await gives a Promise with no
  // .getAll method and a confusing runtime error.
  const cookieStore = await cookies()

  return createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options)
            }
          } catch {
            // Server Components are not allowed to write cookies — by the time
            // they run, response headers may already have been sent. Supabase
            // calls setAll here when it refreshes an expiring token.
            //
            // Swallowing it is safe ONLY because a root proxy.ts refreshes the
            // session on every request, which we add in the auth phase.
            // (In Next.js 16 the file formerly called middleware.ts is now
            // called proxy.ts — same behaviour, new name.)
          }
        },
      },
    },
  )
}
