import { z } from 'zod'

/**
 * Public environment variables — the ones Next.js is allowed to send to the
 * browser. Everything here is readable by anyone using the app. That is fine:
 * neither value grants access on its own.
 */
const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .url('must be the full project URL, e.g. https://abcdefgh.supabase.co'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, 'looks too short to be a real key — did you paste the whole thing?'),
})

export type PublicEnv = z.infer<typeof publicEnvSchema>

export type PublicEnvResult =
  | { ok: true; env: PublicEnv }
  | { ok: false; problems: string[] }

/**
 * Why this returns a result instead of throwing:
 *
 * A missing key is a *setup* problem, not a crash. Returning a value lets the
 * page render a helpful "finish your setup" screen instead of a stack trace.
 * The Supabase client factories still refuse to run without it, so an
 * unconfigured app can never silently talk to the wrong place.
 */
export function getPublicEnv(): PublicEnvResult {
  // These must be written out in full, character for character. Next.js does a
  // literal find-and-replace on the text `process.env.NEXT_PUBLIC_...` when it
  // builds. A dynamic lookup like process.env[someVariable] is not replaced and
  // would come back undefined in the browser.
  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  })

  if (parsed.success) return { ok: true, env: parsed.data }

  return {
    ok: false,
    problems: parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    ),
  }
}

/** Same check, but for code paths that cannot sensibly continue without it. */
export function requirePublicEnv(): PublicEnv {
  const result = getPublicEnv()
  if (!result.ok) {
    throw new Error(
      `Supabase is not configured.\n${result.problems.join('\n')}\n` +
        `Copy .env.example to .env.local and fill in the values.`,
    )
  }
  return result.env
}
