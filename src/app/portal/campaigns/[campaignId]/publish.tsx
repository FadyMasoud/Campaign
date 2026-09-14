'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { publishReport, type PublishState } from '@/lib/reports/actions'
import styles from '../campaigns.module.css'

/**
 * Publishing a campaign's results as a shareable link.
 *
 * The password is shown back exactly once, immediately after publishing, and
 * the screen says so. It is stored only as a bcrypt hash, so there is no
 * "show password" to add later — that is a property worth having, not a
 * limitation to apologise for, and the copy explains it rather than leaving
 * someone to discover it when they come back.
 */

const INITIAL: PublishState = { error: null }

function PublishButton() {
  const { pending } = useFormStatus()

  return (
    <button type="submit" className={styles.publishButton} disabled={pending}>
      {pending ? 'Creating link…' : 'Create shareable link'}
    </button>
  )
}

export function PublishReport({
  campaignId,
  origin,
}: {
  campaignId: string
  origin: string
}) {
  const [state, formAction] = useActionState(publishReport, INITIAL)

  if (state.token && state.password) {
    const url = `${origin}/r/${state.token}`

    return (
      <div className={styles.published}>
        <p className={styles.publishedTitle}>Link created</p>

        <dl className={styles.publishedDetails}>
          <dt>Link</dt>
          <dd>
            <code className={styles.code}>{url}</code>
          </dd>
          <dt>Password</dt>
          <dd>
            <code className={styles.code}>{state.password}</code>
          </dd>
        </dl>

        <p className={styles.warn}>
          Copy the password now. It is stored only as a hash, so it cannot be
          shown again — if it is lost, publish a new link instead. Anyone with
          both the link and the password can see this campaign&rsquo;s totals,
          and nothing else.
        </p>
      </div>
    )
  }

  return (
    <form action={formAction} className={styles.publishForm}>
      <input type="hidden" name="campaignId" value={campaignId} />

      <label htmlFor="report-password" className={styles.publishLabel}>
        Password for the link
      </label>
      <input
        id="report-password"
        name="password"
        type="text"
        minLength={8}
        required
        autoComplete="off"
        placeholder="At least 8 characters"
        className={styles.publishInput}
      />

      {state.error ? (
        <p className={styles.error} role="alert">
          {state.error}
        </p>
      ) : null}

      <PublishButton />
    </form>
  )
}
