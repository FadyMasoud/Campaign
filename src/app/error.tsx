'use client'

import { useEffect } from 'react'
import styles from './states.module.css'

/*
 * An error boundary for this route segment. Next.js renders it instead of the
 * page when a Server Component throws.
 *
 * It MUST be a Client Component ('use client' above): recovering from an error
 * needs a button, and buttons need event handlers, which only run in the
 * browser.
 *
 * Note what is NOT shown: `error.message`. In production Next.js deliberately
 * replaces the real message with a generic one and a `digest` hash, because
 * error text routinely leaks connection strings, table names and internal
 * paths. We show the digest so an operator can find the real error in the
 * server logs, and the user sees something they can act on.
 */
export default function ErrorState({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // In a real deployment this is where an error reporter would be called.
    console.error('Route error:', error)
  }, [error])

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <div role="alert" className={styles.errorPanel}>
          <p className={styles.errorEyebrow}>Something went wrong</p>

          <h1 className={styles.errorTitle}>We could not load this page</h1>

          <p className={styles.errorBody}>
            This is usually a configuration problem rather than a fault with
            your data. Nothing has been changed or lost.
          </p>

          {error.digest && (
            <p className={styles.errorDigest}>
              Reference: <code>{error.digest}</code>
            </p>
          )}

          <button type="button" className={styles.button} onClick={reset}>
            Try again
          </button>
        </div>
      </div>
    </main>
  )
}
