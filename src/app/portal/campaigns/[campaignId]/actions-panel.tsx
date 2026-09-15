import Link from 'next/link'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { siteOrigin } from '@/lib/auth/site-url'
import { revokeReport } from '@/lib/reports/actions'
import { PublishReport } from './publish'
import styles from '../campaigns.module.css'

/**
 * What an owner can DO with this campaign, gathered into one place at the top
 * of the page rather than scattered between the figures.
 *
 * An analyst is shown nothing at all — not a disabled button, not an
 * explanation. They came to read the numbers, and a panel telling them what
 * they cannot do is clutter on every campaign they open. The refusal still
 * exists where it is actually needed: typing the /send URL directly answers
 * plainly, and the database refuses the write regardless.
 */
export async function ActionsPanel({
  campaignId,
  role,
}: {
  campaignId: string
  role: 'owner' | 'analyst'
}) {
  const supabase = await createServerSupabaseClient()

  const [{ data: send }, { data: reports }, origin] = await Promise.all([
    supabase
      .from('campaign_sends')
      .select('id, status, approved_count, accepted_count, requested_email, approved_at')
      .eq('campaign_id', campaignId)
      .neq('status', 'failed')
      .maybeSingle<{
        id: string
        status: string
        approved_count: number
        accepted_count: number | null
        requested_email: string
        approved_at: string
      }>(),
    supabase
      .from('shared_reports')
      .select('id, token, created_email, view_count')
      .eq('campaign_id', campaignId)
      .is('revoked_at', null)
      .order('created_at', { ascending: false })
      .returns<Array<{ id: string; token: string; created_email: string; view_count: number }>>(),
    siteOrigin(),
  ])

  const live = reports ?? []

  // An analyst sees the send RESULT if there is one — that is a number, not an
  // action — but never an action card.
  if (role !== 'owner') {
    if (!send) return null

    return (
      <section className={styles.resultBanner} aria-labelledby="sent">
        <h2 id="sent" className={styles.resultTitle}>Sent</h2>
        <p className={styles.resultBody}>
          {(send.accepted_count ?? send.approved_count).toLocaleString('en')} recipients ·
          approved by {send.requested_email}
          {' · '}
          <Link href={`/portal/sends/${send.id}`} className={styles.link}>
            see the send record
          </Link>
        </p>
      </section>
    )
  }

  return (
    <section className={styles.actions} aria-labelledby="actions">
      <h2 id="actions" className={styles.actionsTitle}>What you can do</h2>

      <div className={styles.actionGrid}>
        {/* --- Step 1: send ------------------------------------------------ */}
        <div className={send ? styles.actionCardDone : styles.actionCardPrimary}>
          <div className={styles.actionHead}>
            <span className={send ? styles.stepDone : styles.stepNumber}>
              {send ? '✓' : '1'}
            </span>
            <h3 className={styles.actionName}>Send this campaign</h3>
          </div>

          {send ? (
            <>
              <p className={styles.actionBody}>
                Sent to{' '}
                <strong>{(send.accepted_count ?? send.approved_count).toLocaleString('en')}</strong>{' '}
                recipients, approved by {send.requested_email}. A campaign
                cannot be sent twice.
              </p>
              <Link href={`/portal/sends/${send.id}`} className={styles.actionLinkSecondary}>
                See the send record →
              </Link>
            </>
          ) : (
            <>
              <p className={styles.actionBody}>
                You will see exactly who it goes to, and how many people that
                is, before anything is sent.
              </p>
              <Link href={`/portal/campaigns/${campaignId}/send`} className={styles.actionButton}>
                Review audience and send
              </Link>
            </>
          )}
        </div>

        {/* --- Step 2: share ----------------------------------------------- */}
        <div className={live.length > 0 ? styles.actionCardDone : styles.actionCard}>
          <div className={styles.actionHead}>
            <span className={live.length > 0 ? styles.stepDone : styles.stepNumber}>
              {live.length > 0 ? '✓' : '2'}
            </span>
            <h3 className={styles.actionName}>Share results with a client</h3>
          </div>

          {live.length > 0 ? (
            <>
              <p className={styles.actionBody}>
                A password-protected page showing this campaign&rsquo;s totals
                only — no customer details, no other campaign.
              </p>
              <ul className={styles.reportList}>
                {live.map((report) => (
                  <li key={report.id} className={styles.reportItem}>
                    <code className={styles.code}>{`${origin}/r/${report.token}`}</code>
                    <span className={styles.reportMeta}>
                      by {report.created_email} · viewed{' '}
                      {report.view_count.toLocaleString('en')}{' '}
                      {report.view_count === 1 ? 'time' : 'times'}
                    </span>
                    <form action={revokeReport}>
                      <input type="hidden" name="reportId" value={report.id} />
                      <input type="hidden" name="campaignId" value={campaignId} />
                      <button type="submit" className={styles.revokeButton}>
                        Withdraw this link
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <p className={styles.actionBody}>
                Creates a password-protected page showing this campaign&rsquo;s
                totals — for a client who has no login.
              </p>
              <PublishReport campaignId={campaignId} origin={origin} />
            </>
          )}
        </div>
      </div>
    </section>
  )
}
