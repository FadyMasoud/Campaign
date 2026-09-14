'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { fetchProviderReports, type SyncState } from '@/lib/provider/actions'
import styles from '../../campaigns/[campaignId]/send/send.module.css'

/**
 * Pulls the provider's latest delivery reports.
 *
 * Pressing it twice is safe and that is the point, not a caveat: reports are
 * stored against the provider's own event id, so a second press reads the same
 * events and inserts none of them. The message says how many were new rather
 * than how many were read, so "50 read, 0 new" is legible as the guarantee
 * working instead of looking like a failure.
 */

const INITIAL: SyncState = { message: null, error: null }

function SyncButton() {
  const { pending } = useFormStatus()

  return (
    <button type="submit" className={styles.syncButton} disabled={pending}>
      {pending ? 'Reading reports…' : 'Fetch latest delivery reports'}
    </button>
  )
}

export function SyncReports({ sendId }: { sendId: string }) {
  const [state, formAction] = useActionState(fetchProviderReports, INITIAL)

  return (
    <form action={formAction} className={styles.form}>
      <input type="hidden" name="sendId" value={sendId} />

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}

      {state.message ? (
        <p className={styles.success} role="status">
          {state.message}
        </p>
      ) : null}

      <SyncButton />
    </form>
  )
}
