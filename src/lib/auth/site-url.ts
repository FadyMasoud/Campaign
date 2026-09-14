import 'server-only'

import { headers } from 'next/headers'

/**
 * Working out the address this app is reachable at — which OAuth needs, because
 * Google has to be told where to send the user back to.
 *
 * Shared between the sign-in action and the callback route so the two cannot
 * disagree. They did briefly: the action normalised the host and the callback
 * used the raw request URL, which meant a sign-in could set off from
 * localhost and come back to somewhere unreachable.
 */

/**
 * Addresses that mean "listen on every interface" rather than naming a host.
 *
 * `next dev -H 0.0.0.0` makes the server reachable from other machines on the
 * network, and the browser then reports 0.0.0.0 as the host. Handing that to
 * Google as the return address produces a round trip ending on a URL nothing
 * can reliably connect to. The IPv6 spellings have the same problem.
 */
const UNROUTABLE = [
  ['://0.0.0.0', '://localhost'],
  ['://[::]', '://localhost'],
  ['://[::1]', '://localhost'],
] as const

export function browsable(url: string): string {
  return UNROUTABLE.reduce((result, [from, to]) => result.replace(from, to), url)
}

/**
 * Where this deployment lives.
 *
 * Derived from the request so the same code works on a laptop, on a Vercel
 * preview and in production — but NEXT_PUBLIC_SITE_URL wins when set, because
 * a request header is ultimately client-supplied and a deployment that knows
 * its own address should say so rather than infer it.
 *
 * Whatever the source, the result must also appear under Redirect URLs in the
 * Supabase dashboard. Supabase validates the address it is asked to return to
 * and quietly falls back to the project Site URL when it is not on the list,
 * which looks like the app ignoring its own configuration.
 */
export async function siteOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured) return browsable(configured.replace(/\/+$/, ''))

  const headerList = await headers()

  const origin = headerList.get('origin')
  if (origin) return browsable(origin)

  const host = headerList.get('x-forwarded-host') ?? headerList.get('host')
  const protocol = headerList.get('x-forwarded-proto') ?? 'http'

  return browsable(`${protocol}://${host}`)
}
