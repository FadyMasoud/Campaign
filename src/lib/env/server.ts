// This import is a build-time tripwire. The `server-only` package has no
// browser build, so if any Client Component ever imports this file — directly
// or through a chain of imports — the build FAILS instead of quietly shipping
// a secret to the browser. It is one line and it is the whole reason secrets
// stay server-side.
import 'server-only'

/**
 * Reads a server-only secret, or explains precisely what is missing.
 *
 * Deliberately NOT validated at import time: we only demand a secret at the
 * moment we actually need it. That means the app still boots and the UI still
 * renders before the messaging provider key exists (we add it in the send
 * phase), while the code that needs it still refuses to guess.
 */
export function requireServerEnv(name: string): string {
  const value = process.env[name]

  if (!value || value.trim() === '') {
    throw new Error(
      `Missing required server environment variable: ${name}. ` +
        `Add it to .env.local for local development, or to your hosting ` +
        `provider's environment settings in production. ` +
        `Never prefix it with NEXT_PUBLIC_.`,
    )
  }

  return value
}
