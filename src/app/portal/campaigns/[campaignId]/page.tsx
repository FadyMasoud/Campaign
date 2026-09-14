import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireBrand } from '@/lib/auth/dal'
import {
  formatCount,
  formatPercent,
  getCampaignPerformance,
  getEngagementDetail,
  rate,
} from '@/lib/analytics/queries'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { BasisTag, CountingRule } from '../../basis'
import styles from '../campaigns.module.css'

export const dynamic = 'force-dynamic'

/**
 * The campaign is resolved here as well as in the page, and deliberately so.
 *
 * A page that calls notFound() cannot set a 404 status if the response has
 * already begun streaming — and it has, because the portal layout renders the
 * header first. The result was a 404 page served with a 200, which is correct
 * on screen and wrong to every crawler and uptime check that reads it.
 *
 * Metadata is resolved before the first byte is flushed, because the title has
 * to go in the head. Deciding here is therefore the only place the status can
 * still be changed. Both calls share one round trip: getCampaignPerformance is
 * wrapped in React's cache().
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ campaignId: string }>
}): Promise<Metadata> {
  const { campaignId } = await params
  const campaigns = await getCampaignPerformance()
  const campaign = campaigns.find((row) => row.campaign_id === campaignId)

  if (!campaign) notFound()

  return { title: `${campaign.name} · Campaign Portal` }
}

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ campaignId: string }>
}) {
  const brand = await requireBrand()
  const { campaignId } = await params

  /*
   * The campaign is found in the list the database already scoped, rather than
   * fetched by id. A campaign id belonging to another brand simply is not in
   * this list, so it 404s — the same answer a stranger gets for an id that
   * does not exist, which is the answer that leaks least.
   */
  const campaigns = await getCampaignPerformance()
  const campaign = campaigns.find((row) => row.campaign_id === campaignId)
  if (!campaign) notFound()

  const detail = campaign.has_events ? await getEngagementDetail(campaignId) : null

  const deliveryRate = rate(campaign.reported_delivered, campaign.reported_sent)
  const providerOpenRate = rate(campaign.reported_opens, campaign.reported_delivered)
  const peopleOpenRate = rate(detail?.people_opened ?? null, campaign.reported_delivered)

  return (
    <main className={styles.page}>
      <p className={styles.breadcrumb}>
        <Link href="/portal/campaigns" className={styles.link}>
          Campaigns
        </Link>
        {' · '}
        {campaign.external_id}
      </p>

      <h1 className={styles.title}>{campaign.name}</h1>

      <p className={styles.lede}>
        {campaign.channel === 'email' ? 'Email' : 'SMS'} campaign
        {campaign.sent_at ? (
          <>
            {' '}
            sent{' '}
            {new Date(campaign.sent_at).toLocaleString('en-GB', {
              dateStyle: 'long',
              timeStyle: 'short',
              timeZone: brand.timezone,
            })}{' '}
            ({brand.timezone.replace('_', ' ')})
          </>
        ) : null}
        {campaign.spend !== null ? (
          <>
            {' '}
            · spend {campaign.spend.toLocaleString('en', { minimumFractionDigits: 2 })}
          </>
        ) : null}
      </p>

      {campaign.spend !== null ? (
        <CountingRule>
          The export does not state a currency for spend, so none is shown. The
          figure is reproduced exactly as the provider gave it.
        </CountingRule>
      ) : null}

      <SendPanel campaignId={campaign.campaign_id} role={brand.role} />

      {campaign.parent_external_id ? (
        <p className={styles.warn}>
          This campaign names <strong>{campaign.parent_external_id}</strong> as its
          parent, which is not a {brand.brandName} campaign. The reference is
          kept as stated, but no link was made — a campaign cannot be joined to
          another brand&rsquo;s.
        </p>
      ) : null}

      {/* --- Provider --------------------------------------------------- */}
      <section className={styles.panel} aria-labelledby="provider">
        <div className={styles.panelHead}>
          <h2 id="provider" className={styles.panelTitle}>
            What the provider reported
          </h2>
          <BasisTag basis="provider" />
        </div>

        <dl className={styles.figures}>
          <Figure label="Sent" value={formatCount(campaign.reported_sent)} />
          <Figure label="Delivered" value={formatCount(campaign.reported_delivered)} />
          <Figure label="Bounced" value={formatCount(campaign.reported_bounced)} />
          <Figure label="Opens" value={formatCount(campaign.reported_opens)} />
          <Figure label="Clicks" value={formatCount(campaign.reported_clicks)} />
          <Figure label="Delivery rate" value={formatPercent(deliveryRate)} />
        </dl>

        <CountingRule>
          Delivery rate is delivered ÷ sent, both as reported by the provider.
        </CountingRule>
      </section>

      {/* --- Event log --------------------------------------------------- */}
      <section className={styles.panel} aria-labelledby="log">
        <div className={styles.panelHead}>
          <h2 id="log" className={styles.panelTitle}>
            What the engagement log holds
          </h2>
          <BasisTag basis="log" />
        </div>

        {campaign.has_events && detail ? (
          <>
            <dl className={styles.figures}>
              <Figure label="Opens (events)" value={formatCount(campaign.log_opens)} />
              <Figure label="People who opened" value={formatCount(detail.people_opened)} />
              <Figure label="Clicks (events)" value={formatCount(campaign.log_clicks)} />
              <Figure label="People who clicked" value={formatCount(detail.people_clicked)} />
              <Figure label="Unsubscribed" value={formatCount(detail.people_unsubscribed)} />
              <Figure label="Complained" value={formatCount(detail.people_complained)} />
            </dl>

            <CountingRule>
              &ldquo;Events&rdquo; and &ldquo;people&rdquo; are different numbers
              on purpose: one recipient opening twice is two opens and one
              person. Rates built on each answer different questions, so both
              are given.
            </CountingRule>
          </>
        ) : (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No engagement log for this campaign</p>
            <p className={styles.emptyBody}>
              We hold no event rows for {campaign.external_id}. That is not the
              same as nobody engaging — it means there is nothing here to
              compare the provider&rsquo;s figures against, so they stand
              unchecked.
            </p>
          </div>
        )}
      </section>

      {/* --- The disagreement -------------------------------------------- */}
      {campaign.has_events && detail ? (
        <section className={styles.panel} aria-labelledby="compare">
          <div className={styles.panelHead}>
            <h2 id="compare" className={styles.panelTitle}>
              Where the two disagree
            </h2>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Open rate, counted two ways</th>
                  <th scope="col">Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className={styles.campaignCell}>
                    Provider opens ÷ provider delivered
                    <span className={styles.campaignMeta}>
                      {formatCount(campaign.reported_opens)} ÷{' '}
                      {formatCount(campaign.reported_delivered)}
                    </span>
                  </th>
                  <td className={styles.num}>{formatPercent(providerOpenRate)}</td>
                </tr>
                <tr>
                  <th scope="row" className={styles.campaignCell}>
                    People who opened ÷ provider delivered
                    <span className={styles.campaignMeta}>
                      {formatCount(detail.people_opened)} ÷{' '}
                      {formatCount(campaign.reported_delivered)}
                    </span>
                  </th>
                  <td className={styles.num}>{formatPercent(peopleOpenRate)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className={styles.warn}>
            Both rates use the provider&rsquo;s delivered figure as the
            denominator, because the log does not record deliveries. Neither
            rate is more correct than the other — they answer different
            questions, and this portal will not pick one on your behalf.
          </p>
        </section>
      ) : null}
    </main>
  )
}

/**
 * The send affordance, and the send record once there is one.
 *
 * An analyst is told plainly that they cannot send, rather than simply not
 * being shown the button — a control that silently vanishes leaves someone
 * wondering whether the feature is broken or they are not allowed. Hiding it
 * stops nobody determined in any case: the guarantee is the insert policy on
 * campaign_sends, which requires app.is_brand_owner.
 */
async function SendPanel({ campaignId, role }: { campaignId: string; role: 'owner' | 'analyst' }) {
  const supabase = await createServerSupabaseClient()

  const { data: send } = await supabase
    .from('campaign_sends')
    .select('id, status, approved_count, requested_email, approved_at')
    .eq('campaign_id', campaignId)
    .neq('status', 'failed')
    .maybeSingle<{
      id: string
      status: string
      approved_count: number
      requested_email: string
      approved_at: string
    }>()

  if (send) {
    return (
      <section className={styles.panel} aria-labelledby="send">
        <div className={styles.panelHead}>
          <h2 id="send" className={styles.panelTitle}>
            Sent
          </h2>
        </div>
        <p className={styles.lede}>
          {send.approved_count.toLocaleString('en')} recipients, approved by{' '}
          {send.requested_email}. This campaign cannot be sent again.{' '}
          <Link href={`/portal/sends/${send.id}`} className={styles.link}>
            See the send record
          </Link>
          .
        </p>
      </section>
    )
  }

  return (
    <section className={styles.panel} aria-labelledby="send">
      <div className={styles.panelHead}>
        <h2 id="send" className={styles.panelTitle}>
          Send
        </h2>
      </div>
      {role === 'owner' ? (
        <p className={styles.lede}>
          <Link href={`/portal/campaigns/${campaignId}/send`} className={styles.link}>
            Review the audience and send this campaign
          </Link>
          . You will see exactly who it goes to, and how many, before anything
          is sent.
        </p>
      ) : (
        <p className={styles.lede}>
          This account is an analyst, so it cannot send campaigns. The database
          refuses the write, not just this screen.
        </p>
      )}
    </section>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.figure}>
      <dt className={styles.figureLabel}>{label}</dt>
      <dd className={styles.figureValue}>{value}</dd>
    </div>
  )
}
