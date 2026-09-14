'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { approveAndSend, type SendState } from '@/lib/send/actions'
import styles from './send.module.css'

/**
 * The confirm button.
 *
 * It disables itself while the request is in flight, which stops an honest
 * double-click from making two requests. That is a courtesy and nothing more —
 * it does not survive a second browser tab, a refresh mid-request, or anyone
 * posting the form directly. The actual guarantee is a unique index in the
 * database allowing one live send per campaign, so two sessions confirming at
 * the same instant produce one send and one refusal.
 *
 * The approved count travels in the form and is re-checked on the server. It
 * is not trusted as input — it is compared, and a mismatch stops the send.
 */

const INITIAL: SendState = { error: null }

function ConfirmButton({ count, name }: { count: number; name: string }) {
  const { pending } = useFormStatus()

  return (
    <button type="submit" className={styles.confirm} disabled={pending}>
      {pending
        ? 'Sending…'
        : `Send “${name}” to ${count.toLocaleString('en')} ${count === 1 ? 'person' : 'people'}`}
    </button>
  )
}

export function SendConfirmation({
  campaignId,
  campaignName,
  approvedCount,
}: {
  campaignId: string
  campaignName: string
  approvedCount: number
}) {
  const [state, formAction] = useActionState(approveAndSend, INITIAL)

  return (
    <form action={formAction} className={styles.form}>
      <input type="hidden" name="campaignId" value={campaignId} />
      <input type="hidden" name="approvedCount" value={approvedCount} />

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}

      <p className={styles.warning}>
        This sends real messages through the messaging provider. It cannot be
        undone, and the campaign cannot be sent a second time.
      </p>

      <ConfirmButton count={approvedCount} name={campaignName} />
    </form>
  )
}
