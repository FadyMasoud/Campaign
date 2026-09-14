import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { browsable } from '@/lib/auth/site-url'

/**
 * Where Google sends the user back to.
 *
 * Supabase uses PKCE, so what arrives here is a short-lived single-use `code`,
 * not a token. Exchanging it server-side is the point: the resulting session
 * is written as HttpOnly cookies, so the page's own JavaScript never holds it.
 * A token returned in a URL fragment instead would be visible to any script on
 * the page and would sit in browser history.
 *
 * Arriving here having successfully proved a Google identity says nothing
 * about being allowed into a brand. That check happens in the data access
 * layer: a genuine Google account with no row in brand_members is sent to
 * /no-access and shown nothing.
 */
/**
 * Which failures deserve their own words on the sign-in screen.
 *
 * `signup_disabled` is the one worth singling out, because it is not a fault
 * and the generic message actively misleads. Supabase treats a first-time
 * Google identity as a sign-up, so when account creation is turned off, a
 * perfectly valid Google login is refused before it ever reaches this route.
 * Telling that person "something went wrong, try again" invites them to try
 * again forever. They need to know an account has to be provisioned.
 */
const KNOWN_ERRORS = new Set(['signup_disabled', 'access_denied'])

function errorRedirect(origin: string, code: string | null): NextResponse {
  const known = code && KNOWN_ERRORS.has(code) ? code : 'google'
  return NextResponse.redirect(`${origin}/login?error=${known}`)
}

export async function GET(request: NextRequest) {
  const { searchParams, origin: rawOrigin } = new URL(request.url)

  // Same normalisation as the sign-in action. Without it a round trip that
  // began on localhost finishes on 0.0.0.0, which the browser cannot open.
  const origin = browsable(rawOrigin)

  const code = searchParams.get('code')
  const error = searchParams.get('error')
  // Supabase passes its own reason through as error_code; Google's own
  // refusals arrive in `error` (access_denied when consent is declined).
  const errorCode = searchParams.get('error_code') ?? error

  if (error || errorCode) {
    return errorRedirect(origin, errorCode)
  }

  if (!code) {
    return errorRedirect(origin, null)
  }

  const supabase = await createServerSupabaseClient()
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

  if (exchangeError) {
    return errorRedirect(origin, exchangeError.code ?? null)
  }

  // Same rule as the sign-in form: only ever continue to a path inside this
  // app, never to a host supplied in the query string.
  const requested = searchParams.get('next')
  const next = requested && requested.startsWith('/') && !requested.startsWith('//')
    ? requested
    : '/portal'

  return NextResponse.redirect(`${origin}${next}`)
}
