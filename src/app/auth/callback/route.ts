import { NextResponse, type NextRequest } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'

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
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url)

  const code = searchParams.get('code')
  const error = searchParams.get('error')

  // The user pressed cancel on Google's consent screen, or Google refused.
  if (error) {
    return NextResponse.redirect(`${origin}/login?error=google`)
  }

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=google`)
  }

  const supabase = await createServerSupabaseClient()
  const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code)

  if (exchangeError) {
    return NextResponse.redirect(`${origin}/login?error=google`)
  }

  // Same rule as the sign-in form: only ever continue to a path inside this
  // app, never to a host supplied in the query string.
  const requested = searchParams.get('next')
  const next = requested && requested.startsWith('/') && !requested.startsWith('//')
    ? requested
    : '/portal'

  return NextResponse.redirect(`${origin}${next}`)
}
