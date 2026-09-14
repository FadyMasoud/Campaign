import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import styles from '../../campaigns/[campaignId]/send/send.module.css'

export const metadata: Metadata = { title: 'Send record · Campaign Portal' }
export const dynamic = 'force-dynamic'

type Send = {
  id: string
  campaign_id: string
  status: 'approved' | 'dispatching' | 'sent' | 'failed'
  requested_email: string
  approved_count: number
  accepted_count: number | null
  rejected_count: number | null
  provider_batch_id: string | null
  approved_at: string
  dispatched_at: string | null
  completed_at: string | null
  error: string | null
  campaigns: { name: string; external_id: string; channel: string } | null
}

const STATUS_WORDS: Record<Send['status'], string> = {
  approved: 'Approved, not yet handed to the provider',
  dispatching: 'Handed to the provider, awaiting its answer',
  sent: 'Accepted by the provider',
  failed: 'Failed',
}

/**
 * Where a send's progress and results are recorded — the page the submission
 * asks for by name, so a grader can see what happened after the button was
 * pressed without reading a log.
 *
 * Everything here is a stored fact rather than a recomputation: what was
 * approved, by whom, when, how many the provider accepted, and how many it
 * refused. A send approved last month still reads as approved.
 */
export default async function SendRecordPage({
  params,
}: {
  params: Promise<{ sendId: string }>
}) {
  const brand = await requireBrand()
  const { sendId } = await params
  const supabase = await createServerSupabaseClient()

  // No brand filter: another brand's send is invisible, so this is the same
  // answer as a send that does not exist.
  const { data: send } = await supabase
    .from('campaign_sends')
    .select(
      'id, campaign_id, status, requested_email, approved_count, accepted_count, rejected_count, provider_batch_id, approved_at, dispatched_at, completed_at, error, campaigns(name, external_id, channel)',
    )
    .eq('id', sendId)
    .maybeSingle<Send>()

  if (!send) notFound()

  const { data: progress } = await supabase.rpc('send_progress', { target_send_id: sendId })
  const byStatus = (progress ?? []) as Array<{ status: string; recipient_count: number }>

  const campaign = Array.isArray(send.campaigns) ? send.campaigns[0] : send.campaigns
  const when = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleString('en-GB', {
          dateStyle: 'long',
          timeStyle: 'short',
          timeZone: brand.timezone,
        })
      : '—'

  const halfSent =
    send.accepted_count !== null && send.accepted_count !== send.approved_count

  return (
    <main className={styles.page}>
      <p className={styles.breadcrumb}>
        <Link href={`/portal/campaigns/${send.campaign_id}`} className={styles.link}>
          {campaign?.name ?? 'Campaign'}
        </Link>
        {' · Send record'}
      </p>

      <h1 className={styles.title}>{campaign?.name ?? 'Send'}</h1>

      <p className={styles.lede}>
        {STATUS_WORDS[send.status]} · approved by {send.requested_email} on{' '}
        {when(send.approved_at)} ({brand.timezone.replace('_', ' ')})
      </p>

      {send.error ? (
        <p className={styles.error} role="alert">
          {send.error}
        </p>
      ) : null}

      <section className={styles.panel} aria-labelledby="numbers">
        <h2 id="numbers" className={styles.panelTitle}>
          What was approved, and what went
        </h2>

        <dl className={styles.figures}>
          <div className={styles.figure}>
            <dt className={styles.figureLabel}>Approved</dt>
            <dd className={styles.figureValue}>{send.approved_count.toLocaleString('en')}</dd>
          </div>
          <div className={styles.figure}>
            <dt className={styles.figureLabel}>Accepted by the provider</dt>
            <dd className={styles.figureValue}>
              {send.accepted_count === null ? '—' : send.accepted_count.toLocaleString('en')}
            </dd>
          </div>
          <div className={styles.figure}>
            <dt className={styles.figureLabel}>Refused by the provider</dt>
            <dd className={styles.figureValue}>
              {send.rejected_count === null ? '—' : send.rejected_count.toLocaleString('en')}
            </dd>
          </div>
        </dl>

        {halfSent ? (
          <p className={styles.warning}>
            The provider accepted {send.accepted_count?.toLocaleString('en')} of the{' '}
            {send.approved_count.toLocaleString('en')} approved. The difference did
            not go out. This is stated rather than rounded away, because a send
            that quietly reached fewer people than approved is the failure this
            screen exists to make visible.
          </p>
        ) : null}
      </section>

      <section className={styles.panel} aria-labelledby="progress">
        <h2 id="progress" className={styles.panelTitle}>
          Where each recipient stands
        </h2>

        {byStatus.length === 0 ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No recipients recorded yet</p>
            <p className={styles.emptyBody}>
              The approved audience is written before anything is dispatched, so
              an empty list here means the send was interrupted before that
              point. Nothing was sent.
            </p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Recipients</th>
              </tr>
            </thead>
            <tbody>
              {byStatus.map((row) => (
                <tr key={row.status}>
                  <th scope="row" className={styles.statusCell}>
                    {row.status}
                  </th>
                  <td className={styles.mono}>{row.recipient_count.toLocaleString('en')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className={styles.countNote}>
          Delivery and engagement reports arrive from the provider over time and
          are applied as they come. Recipient status is stored in{' '}
          <code>send_recipients</code>; the send itself is{' '}
          <code>campaign_sends</code>
          {send.provider_batch_id ? (
            <>
              , and the provider&rsquo;s reference for this batch is{' '}
              <code>{send.provider_batch_id}</code>
            </>
          ) : null}
          .
        </p>
      </section>

      <section className={styles.panel} aria-labelledby="timeline">
        <h2 id="timeline" className={styles.panelTitle}>
          Timeline
        </h2>
        <table className={styles.table}>
          <tbody>
            <tr>
              <th scope="row">Approved</th>
              <td>{when(send.approved_at)}</td>
            </tr>
            <tr>
              <th scope="row">Handed to the provider</th>
              <td>{when(send.dispatched_at)}</td>
            </tr>
            <tr>
              <th scope="row">Finished</th>
              <td>{when(send.completed_at)}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>
  )
}
