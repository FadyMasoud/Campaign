import 'server-only'

import { getPublicEnv } from '@/lib/env/public'
import { createServerSupabaseClient } from './server'

/**
 * A setup diagnostic, not a monitoring endpoint.
 *
 * Its job is to answer, in order, the three questions that go wrong when you
 * first wire up Supabase:
 *   1. Have I filled in my environment variables at all?
 *   2. Is that URL actually a live Supabase project?
 *   3. Does that project accept the key I pasted?
 *
 * Each check is separate on purpose. "It doesn't work" is not a useful error;
 * "the URL resolves but the key is rejected" tells you exactly what to fix.
 */

export type CheckStatus = 'pass' | 'fail' | 'skip'

export type Check = {
  id: string
  label: string
  status: CheckStatus
  detail: string
}

export type HealthReport = {
  configured: boolean
  checks: Check[]
}

const PROBE_TIMEOUT_MS = 5000

export async function checkSupabaseHealth(): Promise<HealthReport> {
  const checks: Check[] = []

  // ---- 1. Configuration ---------------------------------------------------
  const envResult = getPublicEnv()

  if (!envResult.ok) {
    checks.push({
      id: 'env',
      label: 'Environment variables',
      status: 'fail',
      detail: envResult.problems.join(' · '),
    })

    // The remaining checks need a URL and a key. Reporting them as failures
    // would be misleading, so they are explicitly skipped.
    checks.push(
      {
        id: 'reachable',
        label: 'Supabase project reachable',
        status: 'skip',
        detail: 'Waiting for environment variables.',
      },
      {
        id: 'key',
        label: 'Publishable key accepted',
        status: 'skip',
        detail: 'Waiting for environment variables.',
      },
      {
        id: 'session',
        label: 'Server can read the session cookie',
        status: 'skip',
        detail: 'Waiting for environment variables.',
      },
    )

    return { configured: false, checks }
  }

  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_ANON_KEY: key } =
    envResult.env

  checks.push({
    id: 'env',
    label: 'Environment variables',
    status: 'pass',
    detail: `Project URL and publishable key are present.`,
  })

  // ---- 2. Is the project alive? ------------------------------------------
  // GoTrue (Supabase Auth) exposes a health endpoint. A 200 here proves the
  // URL points at a real, running project.
  //
  // The apikey header is required: Supabase rejects unauthenticated requests
  // to this endpoint with a 401. Verified against the live API — an earlier
  // version of this file omitted it and reported a false failure.
  try {
    const response = await fetch(`${url}/auth/v1/health`, {
      headers: { apikey: key },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: 'no-store',
    })

    checks.push({
      id: 'reachable',
      label: 'Supabase project reachable',
      status: response.ok ? 'pass' : 'fail',
      detail: response.ok
        ? `Auth service responded ${response.status}.`
        : `Auth service responded ${response.status}. Check the project URL is exact and the project is not paused.`,
    })
  } catch (error) {
    checks.push({
      id: 'reachable',
      label: 'Supabase project reachable',
      status: 'fail',
      detail:
        error instanceof Error && error.name === 'TimeoutError'
          ? `No response within ${PROBE_TIMEOUT_MS}ms.`
          : `Could not reach ${url}. Check the URL for typos.`,
    })
  }

  // ---- 3. Does the project accept this key? -------------------------------
  // We cannot probe the Data API root: Supabase restricts schema introspection
  // to SECRET keys, so a perfectly valid publishable key gets a 401 there.
  // (That restriction is a good thing — it stops a public key dumping our
  // table structure.)
  //
  // Instead, ask PostgREST for a table that deliberately does not exist and
  // read which error comes back:
  //
  //   401 "Invalid API key" -> the key is wrong
  //   404 PGRST205          -> the key was ACCEPTED and we reached the
  //                            database; the table simply is not there, which
  //                            is the correct answer before we build any.
  //
  // Both branches were verified against the live API, not assumed.
  try {
    const response = await fetch(
      `${url}/rest/v1/__connectivity_probe?select=*`,
      {
        headers: { apikey: key },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        cache: 'no-store',
      },
    )

    const keyRejected = response.status === 401

    checks.push({
      id: 'key',
      label: 'Publishable key accepted',
      status: keyRejected ? 'fail' : 'pass',
      detail: keyRejected
        ? 'The Data API rejected this key. Re-copy it from Project Settings → API Keys and check it belongs to this project.'
        : 'The Data API accepted the key.',
    })
  } catch {
    checks.push({
      id: 'key',
      label: 'Publishable key accepted',
      status: 'fail',
      detail: 'Could not reach the Data API.',
    })
  }

  // ---- 4. Can the server read a session? ----------------------------------
  // No user exists yet, so "no session" is the CORRECT answer at this stage.
  // What we are proving is that the server client builds, reads cookies, and
  // talks to Auth without throwing.
  try {
    const supabase = await createServerSupabaseClient()
    const { data } = await supabase.auth.getUser()

    checks.push({
      id: 'session',
      label: 'Server can read the session cookie',
      status: 'pass',
      detail: data.user
        ? `Signed in as ${data.user.email}.`
        : 'No user signed in — expected, we have not built sign-in yet.',
    })
  } catch (error) {
    checks.push({
      id: 'session',
      label: 'Server can read the session cookie',
      status: 'fail',
      detail: error instanceof Error ? error.message : 'Unknown error.',
    })
  }

  return {
    configured: checks.every((check) => check.status !== 'fail'),
    checks,
  }
}
