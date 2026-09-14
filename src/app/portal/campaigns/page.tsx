import type { Metadata } from 'next'
import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import { formatCount, getCampaignPerformance } from '@/lib/analytics/queries'
import { BasisTag, CountingRule } from '../basis'
import styles from './campaigns.module.css'

export const metadata: Metadata = { title: 'Campaigns · Campaign Portal' }
export const dynamic = 'force-dynamic'

export default async function CampaignsPage() {
  const brand = await requireBrand()
  const campaigns = await getCampaignPerformance()

  if (campaigns.length === 0) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Campaigns</h1>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No campaigns yet</p>
          <p className={styles.emptyBody}>
            Nothing has been loaded for {brand.brandName}.{' '}
            <Link href="/portal/imports" className={styles.link}>
              Import history
            </Link>
          </p>
        </div>
      </main>
    )
  }

  const withoutLog = campaigns.filter((campaign) => !campaign.has_events)

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Campaigns</h1>

      <p className={styles.lede}>
        Two independent sets of figures are shown for every campaign and they
        are never combined. The provider&rsquo;s numbers are what it told us;
        the log&rsquo;s numbers are what we hold rows for. Where they disagree,
        both are shown rather than one being chosen.
      </p>

      {withoutLog.length > 0 ? (
        <p className={styles.warn}>
          {withoutLog.length} of {campaigns.length} campaigns have no engagement
          log at all ({withoutLog.map((campaign) => campaign.external_id).join(', ')}).
          Their provider figures stand alone and cannot be checked against
          anything.
        </p>
      ) : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" rowSpan={2}>Campaign</th>
              <th scope="col" colSpan={4} className={styles.groupProvider}>
                <BasisTag basis="provider" />
              </th>
              <th scope="col" colSpan={3} className={styles.groupLog}>
                <BasisTag basis="log" />
              </th>
            </tr>
            <tr>
              <th scope="col">Sent</th>
              <th scope="col">Delivered</th>
              <th scope="col">Opens</th>
              <th scope="col">Clicks</th>
              <th scope="col">Opens</th>
              <th scope="col">Clicks</th>
              <th scope="col">Opt-outs</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign.campaign_id}>
                <th scope="row" className={styles.campaignCell}>
                  <Link
                    href={`/portal/campaigns/${campaign.campaign_id}`}
                    className={styles.campaignLink}
                  >
                    {campaign.name}
                  </Link>
                  <span className={styles.campaignMeta}>
                    {campaign.external_id} · {campaign.channel}
                    {campaign.sent_at
                      ? ` · ${new Date(campaign.sent_at).toLocaleDateString('en-GB', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                          timeZone: brand.timezone,
                        })}`
                      : ''}
                  </span>
                </th>
                <td className={styles.num}>{formatCount(campaign.reported_sent)}</td>
                <td className={styles.num}>{formatCount(campaign.reported_delivered)}</td>
                <td className={styles.num}>{formatCount(campaign.reported_opens)}</td>
                <td className={styles.num}>{formatCount(campaign.reported_clicks)}</td>
                {campaign.has_events ? (
                  <>
                    <td className={styles.numLog}>{formatCount(campaign.log_opens)}</td>
                    <td className={styles.numLog}>{formatCount(campaign.log_clicks)}</td>
                    <td className={styles.numLog}>
                      {formatCount(campaign.log_unsubscribes + campaign.log_complaints)}
                    </td>
                  </>
                ) : (
                  /* "no log" is not "zero". A row of zeros here would assert
                     that nobody engaged, which we do not know. */
                  <td colSpan={3} className={styles.noLog}>
                    no event log
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <CountingRule>
        Opens in the log column count events, not people — one recipient opening
        twice is two opens. Open a campaign to see how many distinct people that
        was. Dates are shown in {brand.timezone.replace('_', ' ')}.
      </CountingRule>
    </main>
  )
}
