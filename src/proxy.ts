import { NextResponse, type NextRequest } from 'next/server'
import { createProxySupabaseClient } from '@/lib/supabase/proxy-client'

/**
 * Runs before every request. It does two jobs, and deliberately not a third.
 *
 * 1. Keeps the session alive. Supabase rotates the access token roughly hourly
 *    and can only hand the new one back somewhere cookies may be written,
 *    which a Server Component is not. This is that place.
 *
 * 2. Sends signed-out visitors to the sign-in screen, so a protected page
 *    never begins rendering for someone who has no business seeing it.
 *
 * What it does NOT do is decide who may see which brand's rows. The Next.js
 * documentation is explicit that proxy is an optimistic check and not an
 * authorization mechanism — it runs on prefetches, it sees only what the
 * cookie claims, and a request that reaches a route handler directly has not
 * necessarily passed through it. The real guarantee is in the database (see
 * app.current_user_brand_ids()), with a second check in the data access layer
 * at src/lib/auth/dal.ts. If every line of this file were deleted, no brand
 * would become able to read another brand's data; users would simply see an
 * ugly redirect instead of a tidy one.
 *
 * In Next.js 16 this file is `proxy.ts`. It was called `middleware.ts` until
 * that release; the behaviour is unchanged.
 */

/**
 * Reachable without a session. Everything else requires one.
 *
 * `/r` is the shared campaign report, and it is the only page in the portal
 * meant for someone with no account. Being public here does not make it open:
 * it is guarded by an unguessable token and a password, checked inside the
 * database, and it can show one campaign's totals and nothing else.
 */
const PUBLIC_PATHS = ['/login', '/auth/callback', '/auth/signout', '/r']

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))
}

export async function proxy(request: NextRequest) {
  const { supabase, getResponse } = createProxySupabaseClient(request)

  // getUser(), never getSession(). getSession() reads the cookie and believes
  // it; getUser() revalidates the token against the auth server. A cookie is
  // client-controlled data, so trusting it unverified here would mean a forged
  // one could get a request past this point.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl

  if (!user && !isPublic(pathname)) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    // Remember where they were headed, so signing in resumes it rather than
    // dumping everyone on the same landing page.
    if (pathname !== '/') url.searchParams.set('next', pathname)
    return NextResponse.redirect(url)
  }

  if (user && pathname === '/login') {
    const url = request.nextUrl.clone()
    url.pathname = '/portal'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return getResponse()
}

export const config = {
  /*
   * Everything except Next.js internals and static files. Auth is one of the
   * few cases where the documentation recommends running on all routes: an
   * exclusion list that drifts out of date fails open, and a path left off it
   * by accident is a page that never refreshes its session.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
