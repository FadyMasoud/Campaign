import 'server-only'

import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { requirePublicEnv } from '@/lib/env/public'

/**
 * The Supabase client used inside `proxy.ts`, and nowhere else.
 *
 * It exists because of a specific constraint: a Server Component cannot write
 * cookies. When an access token is close to expiring, Supabase silently
 * refreshes it and hands back a new pair of cookies to store — and in a Server
 * Component that write is swallowed (see the comment in `server.ts`). If
 * nothing else picked it up, users would be signed out the moment their token
 * aged past an hour.
 *
 * Proxy runs before the response is generated, so it *can* set cookies. This
 * client wires Supabase to the request on the way in and the response on the
 * way out, which is what keeps a session alive across a long working session.
 *
 * The double write in `setAll` is deliberate and both halves are needed:
 * updating `request.cookies` so anything later in this same pass reads the new
 * token, and rebuilding the response so the browser is told to store it.
 */
export function createProxySupabaseClient(request: NextRequest) {
  const env = requirePublicEnv()

  let response = NextResponse.next({ request })

  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value)
          }

          response = NextResponse.next({ request })

          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options)
          }
        },
      },
    },
  )

  // The response is read through a getter rather than returned directly
  // because setAll replaces it: handing back the original object would discard
  // exactly the refreshed cookies this client exists to capture.
  return { supabase, getResponse: () => response }
}
