import 'server-only'

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { requireServerEnv } from '@/lib/env/server'

/**
 * Proving that somebody already typed the password, without a login.
 *
 * A shared report has no account behind it, so there is no Supabase session to
 * lean on. What is needed is narrow: a cookie that says "this browser answered
 * the password for THIS token, until THIS time", that the browser cannot forge
 * and cannot edit.
 *
 * An HMAC over the token and the expiry does that in a few lines, with no
 * table to keep and nothing to clean up. The signature covers the token, so a
 * cookie granted for one report cannot be replayed against another — which
 * would otherwise turn one leaked password into access to every report.
 *
 * The signing key is derived from the service-role key rather than being a new
 * secret of its own. That key is already required, already server-only, and
 * already the thing whose compromise would be total; adding a second secret
 * would be one more thing to set, store and rotate for no additional safety.
 * Rotating it invalidates every outstanding grant, which is the right
 * behaviour.
 */

const GRANT_TTL_MS = 2 * 60 * 60 * 1000 // two hours
const COOKIE_PREFIX = 'report_'

function signingKey(): Buffer {
  return createHmac('sha256', requireServerEnv('SUPABASE_SERVICE_ROLE_KEY'))
    .update('shared-report-grant-v1')
    .digest()
}

/** One cookie per report, so a grant is scoped to the thing it unlocked. */
export function grantCookieName(token: string): string {
  // The token is base64url from a CSPRNG, so it is already cookie-safe; this
  // only guards against a malformed value reaching a Set-Cookie header.
  return `${COOKIE_PREFIX}${token.replace(/[^A-Za-z0-9_-]/g, '')}`
}

export function issueGrant(token: string): { value: string; maxAge: number } {
  const expiresAt = Date.now() + GRANT_TTL_MS
  const signature = createHmac('sha256', signingKey())
    .update(`${token}.${expiresAt}`)
    .digest('base64url')

  return { value: `${expiresAt}.${signature}`, maxAge: Math.floor(GRANT_TTL_MS / 1000) }
}

/**
 * Rejects anything that is not a current, correctly signed grant for exactly
 * this token.
 */
export function grantIsValid(token: string, cookieValue: string | undefined): boolean {
  if (!cookieValue) return false

  const separator = cookieValue.indexOf('.')
  if (separator < 1) return false

  const expiresAt = Number(cookieValue.slice(0, separator))
  const provided = cookieValue.slice(separator + 1)

  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false

  const expected = createHmac('sha256', signingKey())
    .update(`${token}.${expiresAt}`)
    .digest('base64url')

  const a = Buffer.from(provided)
  const b = Buffer.from(expected)

  // Length must be compared first: timingSafeEqual throws on a mismatch, and
  // the comparison itself must not leak how much of the signature was right.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * A report token: 256 bits from a cryptographic source.
 *
 * Not randomUUID — a v4 UUID carries 122 bits and a recognisable shape. This
 * is the only thing standing between a stranger and the existence of a report,
 * so it is sized to make guessing not a strategy rather than merely slow.
 */
export function newReportToken(): string {
  return randomBytes(32).toString('base64url')
}
