'use server'

import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createServerSupabaseClient } from '@/lib/supabase/server'

/**
 * Everything that starts or ends a session.
 *
 * These run as Server Actions rather than in the browser for one concrete
 * reason: the session cookies must be marked HttpOnly. Signing in from a
 * Client Component means the browser holds the tokens in JavaScript-reachable
 * storage, and any injected script on the page can then read them. Doing the
 * exchange here means the tokens are written as cookies the page's own
 * JavaScript cannot see.
 */

export type LoginState = { error: string | null }

const credentialsSchema = z.object({
  email: z.email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
})

/**
 * Where this deployment lives, for OAuth to return to.
 *
 * Built from the request rather than a hard-coded URL so the same code works
 * on localhost, on a Vercel preview and in production. `x-forwarded-*` is what
 * the proxy in front of the app sets; `host` is the fallback for running it
 * directly.
 */
async function siteOrigin(): Promise<string> {
  const headerList = await headers()

  const origin = headerList.get('origin')
  if (origin) return origin

  const host = headerList.get('x-forwarded-host') ?? headerList.get('host')
  const protocol = headerList.get('x-forwarded-proto') ?? 'http'

  return `${protocol}://${host}`
}

/**
 * Only ever redirect to a path inside this app.
 *
 * Without this, `/login?next=https://example.com` would hand an attacker a
 * link that looks like our domain, signs the victim in, and drops them on a
 * page the attacker controls. Requiring a single leading slash — and rejecting
 * `//host`, which browsers read as protocol-relative and therefore external —
 * keeps the destination inside this origin.
 */
function safeNext(next: string | null | undefined): string {
  if (!next) return '/portal'
  if (!next.startsWith('/') || next.startsWith('//')) return '/portal'
  return next
}

export async function signInWithPassword(
  _previous: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check your details and try again.' }
  }

  const supabase = await createServerSupabaseClient()
  const { error } = await supabase.auth.signInWithPassword(parsed.data)

  if (error) {
    /*
     * Deliberately one message for every failure. Saying "no account with that
     * email" would turn this form into a way to test whether an address is
     * registered, which is worth having even against a demo.
     */
    return { error: 'That email and password do not match an account.' }
  }

  // redirect() works by throwing, so it must sit outside any try/catch —
  // wrapping it would swallow the redirect and look like a silent failure.
  redirect(safeNext(formData.get('next')?.toString()))
}

export async function signInWithGoogle(formData: FormData): Promise<void> {
  const supabase = await createServerSupabaseClient()
  const next = safeNext(formData.get('next')?.toString())
  const origin = await siteOrigin()

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}`,
    },
  })

  if (error || !data?.url) {
    redirect('/login?error=google')
  }

  redirect(data.url)
}

export async function signOut(): Promise<void> {
  const supabase = await createServerSupabaseClient()
  await supabase.auth.signOut()
  redirect('/login')
}
