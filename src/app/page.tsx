import { redirect } from 'next/navigation'
import { getBrandContext } from '@/lib/auth/dal'

/*
 * The root is a signpost, not a page.
 *
 * Proxy has already turned away anyone without a session by the time this
 * runs, so the only question left is where a signed-in person belongs. Asking
 * it here rather than rendering a landing page means there is no "logged-in
 * home screen" to keep in step with the portal.
 */
export const dynamic = 'force-dynamic'

export default async function RootPage() {
  const brand = await getBrandContext()

  // Signed in but attached to no brand: say so plainly rather than showing an
  // empty portal that looks broken.
  redirect(brand ? '/portal' : '/no-access')
}
