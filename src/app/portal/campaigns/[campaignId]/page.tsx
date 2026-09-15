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
import { BasisTag, CountingRule } from '../../basis'
import { ActionsPanel } from './actions-panel'
import styles from '../campaigns.module.css'

export const dynamic = 'force-dynamic'

/**
 * The campaign is resolved here as well as in the page so the title reflects
 * it, and because deciding existence before the first byte is flushed is the
 * only chance to influence the status. Both calls share one round trip:
 * getCampaignPerformance is wrapped in React's cache().
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
   * Found in the list the database already scoped, rather than fetched by id.
   * A campaign belonging to another brand is simply not in this list, so it
   * 404s — the same answer as an id that never existed, which leaks least.
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
          ← All campaigns
        </Link>
      </p>

      {/* --- Headline ------------------------------------------------------ */}
      <header className={styles.detailHead}>
        <div className={styles.detailTitleBlock}>
          <h1 className={styles.title}>{campaign.name}</h1>
          <p className={styles.lede}>
            <span className={campaign.channel === 'email' ? styles.chanEmail : styles.chanSms}>
              {campaign.channel}
            </span>
            {campaign.external_id}
            {campaign.sent_at ? (
              <>
                {' · '}
                {new Date(campaign.sent_at).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                  timeZone: brand.timezone,
                })}
              </>
            ) : null}
            {campaign.spend !== null ? (
              <> · spend {campaign.spend.toLocaleString('en', { minimumFractionDigits: 2 })}</>
            ) : null}
          </p>
        </div>

        {/* The four figures worth seeing without scrolling. */}
        <dl className={styles.headlineFigures}>
          <div className={styles.headlineFigure}>
            <dt>Sent</dt>
            <dd>{formatCount(campaign.reported_sent)}</dd>
          </div>
          <div className={styles.headlineFigure}>
            <dt>Delivered</dt>
            <dd>{formatPercent(deliveryRate)}</dd>
          </div>
          <div className={styles.headlineFigure}>
            <dt>Opens</dt>
            <dd>{formatCount(campaign.reported_opens)}</dd>
          </div>
          <div className={styles.headlineFigure}>
            <dt>Bounced</dt>
            <dd>{formatCount(campaign.reported_bounced)}</dd>
          </div>
        </dl>
      </header>

      {/* --- What you can do — owners only, and first ---------------------- */}
      <ActionsPanel campaignId={campaign.campaign_id} role={brand.role} />

      {campaign.parent_external_id ? (
        <p className={styles.warn}>
          This campaign names <strong>{campaign.parent_external_id}</strong> as its
          parent, which is not a {brand.brandName} campaign. The reference is
          kept as stated, but no link was made — a campaign cannot be joined to
          another brand&rsquo;s.
        </p>
      ) : null}

      {/* --- The numbers --------------------------------------------------- */}
      <div className={styles.twoUp}>
        <section className={styles.panel} aria-labelledby="provider">
          <div className={styles.panelHead}>
            <h2 id="provider" className={styles.panelTitle}>What the provider reported</h2>
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

          <CountingRule>Delivery rate is delivered ÷ sent, both as reported.</CountingRule>
        </section>

        <section className={styles.panel} aria-labelledby="log">
          <div className={styles.panelHead}>
            <h2 id="log" className={styles.panelTitle}>What the engagement log holds</h2>
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
                &ldquo;Events&rdquo; and &ldquo;people&rdquo; differ on purpose:
                one recipient opening twice is two opens and one person.
              </CountingRule>
            </>
          ) : (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>No engagement log</p>
              <p className={styles.emptyBody}>
                We hold no event rows for {campaign.external_id}. That is not the
                same as nobody engaging — there is nothing here to check the
                provider&rsquo;s figures against, so they stand unchecked.
              </p>
            </div>
          )}
        </section>
      </div>

      {/* --- Where they disagree ------------------------------------------- */}
      {campaign.has_events && detail ? (
        <section className={styles.panel} aria-labelledby="compare">
          <div className={styles.panelHead}>
            <h2 id="compare" className={styles.panelTitle}>Where the two disagree</h2>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Open rate, counted two ways</th>
                  <th scope="col" className={styles.thNum}>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th scope="row" className={styles.campaignCell}>
                    Provider opens ÷ provider delivered
                    <span className={styles.campaignMeta}>
                      {formatCount(campaign.reported_opens)} ÷ {formatCount(campaign.reported_delivered)}
                    </span>
                  </th>
                  <td className={styles.num}>{formatPercent(providerOpenRate)}</td>
                </tr>
                <tr>
                  <th scope="row" className={styles.campaignCell}>
                    People who opened ÷ provider delivered
                    <span className={styles.campaignMeta}>
                      {formatCount(detail.people_opened)} ÷ {formatCount(campaign.reported_delivered)}
                    </span>
                  </th>
                  <td className={styles.num}>{formatPercent(peopleOpenRate)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <p className={styles.warn}>
            Both use the provider&rsquo;s delivered figure as the denominator,
            because the log does not record deliveries. Neither rate is more
            correct — they answer different questions, and this portal will not
            pick one on your behalf.
          </p>
        </section>
      ) : null}
    </main>
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
