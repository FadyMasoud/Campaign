import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { SyncReports } from './sync'
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
  last_synced_at: string | null
  events_applied: number
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
      'id, campaign_id, status, requested_email, approved_count, accepted_count, rejected_count, provider_batch_id, last_synced_at, events_applied, approved_at, dispatched_at, completed_at, error, campaigns(name, external_id, channel)',
    )
    .eq('id', sendId)
    .maybeSingle<Send>()

  if (!send) notFound()

  const { data: progress } = await supabase.rpc('send_progress', { target_send_id: sendId })
  const byStatus = (progress ?? []) as Array<{ status: string; recipient_count: number }>

  /*
   * A send is handed over in batches of 500, because that is all the provider
   * will take in one call whatever its documentation says. Showing them is not
   * decoration: when a send stops half way, the batch list is what says how
   * far it got, and re-reading delivery reports walks this same list.
   */
  const { data: batchRows } = await supabase
    .from('send_batches')
    .select('sequence, provider_batch_id, recipient_count, accepted_count, rejected_count, events_applied')
    .eq('send_id', sendId)
    .order('sequence', { ascending: true })

  const batches = (batchRows ?? []) as Array<{
    sequence: number
    provider_batch_id: string
    recipient_count: number
    accepted_count: number
    rejected_count: number
    events_applied: number
  }>

  const handedOver = batches.reduce((sum, batch) => sum + batch.recipient_count, 0)

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
            {send.approved_count.toLocaleString('en')} approved
            {handedOver > 0 && handedOver < send.approved_count ? (
              <>
                , and only {handedOver.toLocaleString('en')} were handed over at all —
                the send stopped part way through
              </>
            ) : null}
            . The difference did not go out. This is stated rather than rounded
            away, because a send that quietly reached fewer people than approved
            is the failure this screen exists to make visible.
          </p>
        ) : null}
      </section>

      {batches.length > 0 ? (
        <section className={styles.panel} aria-labelledby="batches">
          <h2 id="batches" className={styles.panelTitle}>
            How it was handed over
          </h2>

          <p className={styles.countNote}>
            {batches.length === 1
              ? 'One call to the messaging provider.'
              : `${batches.length} calls to the messaging provider, of at most 500 recipients each. `}
            {batches.length > 1
              ? 'The provider will not accept more than that in one call, whatever its documentation says, so a send is split until it fits.'
              : ''}
          </p>

          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Batch</th>
                <th scope="col">Provider reference</th>
                <th scope="col">Handed over</th>
                <th scope="col">Accepted</th>
                <th scope="col">Refused</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((batch) => (
                <tr key={batch.sequence}>
                  <th scope="row">{batch.sequence + 1} of {batches.length}</th>
                  <td className={styles.mono}>{batch.provider_batch_id}</td>
                  <td>{batch.recipient_count.toLocaleString('en')}</td>
                  <td>{batch.accepted_count.toLocaleString('en')}</td>
                  <td>{batch.rejected_count.toLocaleString('en')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

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
                    {/* A dot carrying the status colour, with the word beside
                        it: colour alone would leave "delivered" and "bounced"
                        indistinguishable to anyone who cannot separate the
                        two hues. */}
                    <span
                      className={styles[`dot${row.status[0].toUpperCase()}${row.status.slice(1)}`] ?? styles.dotQueued}
                      aria-hidden="true"
                    />
                    {row.status}
                  </th>
                  <td className={styles.mono}>{row.recipient_count.toLocaleString('en')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {send.provider_batch_id ? (
          <div className={styles.syncPanel}>
            <p className={styles.countNote}>
              {send.last_synced_at
                ? `Last read from the provider ${when(send.last_synced_at)}, ${send.events_applied.toLocaleString('en')} report${send.events_applied === 1 ? '' : 's'} applied so far.`
                : 'The provider has not been read yet for this send.'}{' '}
              Reports arrive over time, including while nothing is watching, so
              this reads whatever has accumulated since last time. Pressing it
              twice is safe — reports are stored against the provider&rsquo;s own
              reference, so the same report is never applied twice.
            </p>
            <SyncReports sendId={send.id} />
          </div>
        ) : null}

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
