/*
 * A stand-in for the `server-only` package while testing.
 *
 * The real package throws the moment it is imported outside a React Server
 * Component, which is exactly what makes it useful in the app: a client
 * component that reaches for the service-role key fails the build instead of
 * shipping the secret to a browser.
 *
 * Vitest is neither, so importing the real thing fails with "This module
 * cannot be imported from a Client Component module". Aliasing it to nothing
 * here lets the tests drive server modules directly — the guarantee is a
 * build-time one, and the build still enforces it.
 */
export {}
