import 'server-only'

import { cache } from 'react'
import { redirect } from 'next/navigation'
import { createServerSupabaseClient } from '@/lib/supabase/server'

/**
 * The data access layer: the one place that answers "who is asking, and what
 * brand are they?"
 *
 * Pages never work this out for themselves. They call requireBrand() and are
 * handed a brand, or they are redirected. That matters because the alternative
 * — each page reading the session and deciding — is how one page eventually
 * forgets, and a forgotten check on a single route is the whole guarantee
 * gone.
 *
 * This is the *second* line of defence, not the first. Even a page that
 * skipped it entirely could not read another brand's rows, because the
 * database refuses (see app.current_user_brand_ids()). What this layer adds is
 * an answer to "which brand am I rendering for" and a clean redirect.
 */

export type BrandRole = 'owner' | 'analyst'

export type BrandContext = {
  userId: string
  email: string
  brandId: string
  brandCode: string
  brandName: string
  /** IANA zone. Needed wherever a UTC instant is shown as a calendar date. */
  timezone: string
  role: BrandRole
}

type MembershipRow = {
  role: BrandRole
  brands: {
    id: string
    code: string
    name: string
    timezone: string
  } | null
}

/**
 * Returns the signed-in user's brand, or null.
 *
 * Wrapped in React's cache() so that a layout, a page and three components in
 * the same render all share one round trip instead of making five. The cache
 * lasts exactly one render pass — it is not a cross-request cache, which would
 * be a way to serve one user another user's brand.
 */
export const getBrandContext = cache(async (): Promise<BrandContext | null> => {
  const supabase = await createServerSupabaseClient()

  // getUser() rather than getSession(): it revalidates the token with the auth
  // server instead of trusting what the cookie says about itself.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return null

  /*
   * The .eq('user_id') is load-bearing, not decorative. The policy on
   * brand_members lets you see every membership row of a brand you belong to,
   * so an owner also sees their analyst colleague. Without this filter a brand
   * with two members returns two rows and .single() fails — and, worse, the
   * page might pick whichever came first.
   */
  const { data, error } = await supabase
    .from('brand_members')
    .select('role, brands(id, code, name, timezone)')
    .eq('user_id', user.id)
    .maybeSingle<MembershipRow>()

  if (error || !data?.brands) return null

  return {
    userId: user.id,
    email: user.email ?? '',
    brandId: data.brands.id,
    brandCode: data.brands.code,
    brandName: data.brands.name,
    timezone: data.brands.timezone,
    role: data.role,
  }
})

/**
 * For any page that shows brand data. Redirects rather than returning null, so
 * a caller cannot accidentally carry on with an undefined brand.
 *
 * A signed-in account with no membership lands on /no-access. That is the
 * "outsiders get in nowhere" case, and it is reachable in practice: anyone
 * with a Google account can complete a Google sign-in and arrive here as a
 * genuine, authenticated user who belongs to nothing. They must be told so
 * plainly, and shown no data.
 */
export async function requireBrand(): Promise<BrandContext> {
  const supabase = await createServerSupabaseClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const context = await getBrandContext()
  if (!context) redirect('/no-access')

  return context
}

/**
 * For actions only an owner may take — sending, in phase 5.
 *
 * Re-checked on the server at the moment of acting, never inferred from the
 * fact that a button was rendered. Hiding a control is a courtesy to the
 * person using the app; it stops nobody who is determined, because the request
 * can be made without the page. The matching database-level check on the send
 * table is what actually refuses an analyst.
 */
export async function requireOwner(): Promise<BrandContext> {
  const context = await requireBrand()

  if (context.role !== 'owner') {
    throw new Error('This action is limited to brand owners.')
  }

  return context
}
