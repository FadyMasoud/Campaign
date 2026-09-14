'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { unlockReport, type UnlockState } from '@/lib/reports/actions'
import styles from './report.module.css'

/**
 * The password gate.
 *
 * The password is posted to a Server Action and checked inside the database;
 * it is never compared in the browser and the page never receives the hash.
 * The error message is identical whether the token is unknown, withdrawn, or
 * simply has a different password, so a stranger probing the URL space learns
 * nothing from it.
 */

const INITIAL: UnlockState = { error: null }

function UnlockButton() {
  const { pending } = useFormStatus()

  return (
    <button type="submit" className={styles.unlockButton} disabled={pending}>
      {pending ? 'Checking…' : 'View results'}
    </button>
  )
}

export function UnlockForm({ token }: { token: string }) {
  const [state, formAction] = useActionState(unlockReport, INITIAL)

  return (
    <form action={formAction} className={styles.unlockForm}>
      <input type="hidden" name="token" value={token} />

      <label htmlFor="password" className={styles.label}>
        Password
      </label>
      <input
        id="password"
        name="password"
        type="password"
        autoComplete="off"
        required
        className={styles.input}
        aria-describedby={state.error ? 'unlock-error' : undefined}
      />

      {state.error ? (
        <p id="unlock-error" className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}

      <UnlockButton />
    </form>
  )
}
