import type { Metadata } from 'next'
import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { formatCount, getCampaignPerformance } from '@/lib/analytics/queries'
import { BasisTag, CountingRule } from '../basis'
import styles from './campaigns.module.css'

export const metadata: Metadata = { title: 'Campaigns · Campaign Portal' }
export const dynamic = 'force-dynamic'

export default async function CampaignsPage() {
  const brand = await requireBrand()
  const supabase = await createServerSupabaseClient()

  const [campaigns, { data: sends }] = await Promise.all([
    getCampaignPerformance(),
    supabase
      .from('campaign_sends')
      .select('campaign_id, status')
      .neq('status', 'failed')
      .returns<Array<{ campaign_id: string; status: string }>>(),
  ])

  // Which campaigns have already gone out, so the list can say so rather than
  // making someone open each one to find out.
  const sentCampaigns = new Map((sends ?? []).map((row) => [row.campaign_id, row.status]))

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
      <header className={styles.pageHead}>
        <div>
          <h1 className={styles.title}>Campaigns</h1>
          <p className={styles.lede}>
            {campaigns.length} campaigns · {sentCampaigns.size} sent from this portal
          </p>
        </div>
      </header>

      <p className={styles.intro}>
        Two independent sets of figures are shown and never combined. The
        provider&rsquo;s numbers are what it told us; the log&rsquo;s numbers
        are what we hold rows for. Where they disagree, both are shown.
      </p>

      {withoutLog.length > 0 ? (
        <p className={styles.warn}>
          <strong>{withoutLog.length} of {campaigns.length} campaigns have no engagement log</strong>{' '}
          ({withoutLog.map((campaign) => campaign.external_id).join(', ')}). Their
          provider figures stand alone and cannot be checked against anything.
        </p>
      ) : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col" rowSpan={2} className={styles.thCampaign}>Campaign</th>
              <th scope="col" colSpan={3} className={styles.groupProvider}>
                <BasisTag basis="provider" />
              </th>
              <th scope="col" colSpan={2} className={styles.groupLog}>
                <BasisTag basis="log" />
              </th>
              <th scope="col" rowSpan={2}>Status</th>
              <th scope="col" rowSpan={2}><span className={styles.srOnly}>Actions</span></th>
            </tr>
            <tr>
              <th scope="col" className={styles.thNum}>Sent</th>
              <th scope="col" className={styles.thNum}>Delivered</th>
              <th scope="col" className={styles.thNum}>Opens</th>
              <th scope="col" className={styles.thNum}>Opens</th>
              <th scope="col" className={styles.thNum}>Opt-outs</th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => {
              const sentStatus = sentCampaigns.get(campaign.campaign_id)

              return (
                <tr key={campaign.campaign_id}>
                  <th scope="row" className={styles.campaignCell}>
                    <Link
                      href={`/portal/campaigns/${campaign.campaign_id}`}
                      className={styles.campaignLink}
                    >
                      {campaign.name}
                    </Link>
                    <span className={styles.campaignMeta}>
                      <span className={campaign.channel === 'email' ? styles.chanEmail : styles.chanSms}>
                        {campaign.channel}
                      </span>
                      {campaign.external_id}
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

                  {campaign.has_events ? (
                    <>
                      <td className={styles.numLog}>{formatCount(campaign.log_opens)}</td>
                      <td className={styles.numLog}>
                        {formatCount(campaign.log_unsubscribes + campaign.log_complaints)}
                      </td>
                    </>
                  ) : (
                    /* "no log" is not "zero". A row of zeros would assert that
                       nobody engaged, which we do not know. */
                    <td colSpan={2} className={styles.noLog}>no event log</td>
                  )}

                  <td>
                    {sentStatus ? (
                      <span className={styles.badgeSent}>Sent</span>
                    ) : (
                      <span className={styles.badgeIdle}>Not sent</span>
                    )}
                  </td>

                  {/* The row is clickable through the campaign name, but a
                      visible button is what most people look for — and it
                      gives the row an obvious target on a phone. */}
                  <td className={styles.actionCell}>
                    <Link
                      href={`/portal/campaigns/${campaign.campaign_id}`}
                      className={styles.viewButton}
                    >
                      View
                    </Link>
                  </td>
                </tr>
              )
            })}
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
