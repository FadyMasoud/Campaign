import type { Metadata } from 'next'
import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { formatCount, getCampaignPerformance } from '@/lib/analytics/queries'
import { BasisTag, CountingRule } from '../basis'
import styles from './campaigns.module.css'

export const metadata: Metadata = { title: 'Campaigns · Campaign Portal' }
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; ref?: string; sent?: string; page?: string }>
}) {
  const brand = await requireBrand()
  const params = await searchParams
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

  /*
   * Filtering happens here rather than in SQL because campaign_performance()
   * already returns the brand's whole set - 69 rows at the largest - and
   * paging it in the database would cost a second round trip to learn a total
   * we are already holding.
   */
  const q = (params.q ?? '').trim().toLowerCase()
  const ref = (params.ref ?? '').trim().toLowerCase()
  const sentFilter = params.sent === 'sent' || params.sent === 'unsent' ? params.sent : 'all'
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1)

  const matching = campaigns.filter((campaign) => {
    if (q && !campaign.name.toLowerCase().includes(q)) return false
    if (ref && !campaign.external_id.toLowerCase().includes(ref)) return false
    const hasSend = sentCampaigns.has(campaign.campaign_id)
    if (sentFilter === 'sent' && !hasSend) return false
    if (sentFilter === 'unsent' && hasSend) return false
    return true
  })

  const total = matching.length
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const current = Math.min(page, lastPage)
  const from = (current - 1) * PAGE_SIZE
  const visible = matching.slice(from, from + PAGE_SIZE)
  const filtered = Boolean(q || ref || sentFilter !== 'all')

  const href = (next: { page?: number }) => {
    const search = new URLSearchParams()
    if (params.q) search.set('q', params.q)
    if (params.ref) search.set('ref', params.ref)
    if (sentFilter !== 'all') search.set('sent', sentFilter)
    if (next.page && next.page > 1) search.set('page', String(next.page))
    const qs = search.toString()
    return qs ? `/portal/campaigns?${qs}` : '/portal/campaigns'
  }

  // Page numbers around the current one, always including first and last.
  const pageNumbers = (() => {
    const around = new Set<number>([1, lastPage, current])
    for (let offset = 1; offset <= 2; offset += 1) {
      if (current - offset > 1) around.add(current - offset)
      if (current + offset < lastPage) around.add(current + offset)
    }
    return [...around].sort((a, b) => a - b)
  })()

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
            {filtered ? (
              <>
                <strong>{total}</strong> of {campaigns.length} campaigns match{' · '}
                <Link href="/portal/campaigns" className={styles.link}>clear filters</Link>
              </>
            ) : (
              <>{campaigns.length} campaigns · {sentCampaigns.size} sent from this portal</>
            )}
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

      {/* A plain GET form: works without JavaScript, and the result is a real
          URL somebody can bookmark. */}
      <form id="campaign-filters" method="get" action="/portal/campaigns" role="search" />

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

            {/* One search box per column, under its own heading, so it is
                obvious which field each searches. The inputs reach the form
                through the `form` attribute, because a <form> cannot legally
                be a child of <table>. */}
            <tr className={styles.filterRow}>
              <td>
                <label htmlFor="c-q" className={styles.srOnly}>Search campaign name</label>
                <input
                  id="c-q" name="q" form="campaign-filters" type="search"
                  defaultValue={params.q ?? ''} placeholder="Campaign name"
                  className={styles.columnInput}
                />
                <label htmlFor="c-ref" className={styles.srOnly}>Search reference</label>
                <input
                  id="c-ref" name="ref" form="campaign-filters" type="search"
                  defaultValue={params.ref ?? ''} placeholder="KIL-0001"
                  className={styles.columnInputSmall}
                />
              </td>
              <td colSpan={5} />
              <td>
                <label htmlFor="c-sent" className={styles.srOnly}>Filter by send status</label>
                <select
                  id="c-sent" name="sent" form="campaign-filters"
                  defaultValue={sentFilter} className={styles.columnSelect}
                >
                  <option value="all">All</option>
                  <option value="sent">Sent</option>
                  <option value="unsent">Not sent</option>
                </select>
              </td>
              <td>
                <button type="submit" form="campaign-filters" className={styles.filterButton}>
                  Search
                </button>
              </td>
            </tr>
          </thead>
          <tbody>
            {visible.map((campaign) => {
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

      {total === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No campaigns match</p>
          <p className={styles.emptyBody}>
            Try part of a campaign name, or a reference such as KIL-0001.
          </p>
        </div>
      ) : null}

      {lastPage > 1 ? (
        <nav className={styles.pager} aria-label="Pages">
          {current > 1 ? (
            <Link href={href({ page: current - 1 })} className={styles.pageLink} rel="prev">
              ← Previous
            </Link>
          ) : (
            <span className={styles.pageDisabled}>← Previous</span>
          )}

          <ol className={styles.pageNumbers}>
            {pageNumbers.map((number, index) => (
              <li key={number}>
                {index > 0 && number - pageNumbers[index - 1] > 1 ? (
                  <span className={styles.gap}>…</span>
                ) : null}
                {number === current ? (
                  <span className={styles.pageCurrent} aria-current="page">{number}</span>
                ) : (
                  <Link href={href({ page: number })} className={styles.pageNumber}>{number}</Link>
                )}
              </li>
            ))}
          </ol>

          {current < lastPage ? (
            <Link href={href({ page: current + 1 })} className={styles.pageLink} rel="next">
              Next →
            </Link>
          ) : (
            <span className={styles.pageDisabled}>Next →</span>
          )}
        </nav>
      ) : null}

      <CountingRule>
        {PAGE_SIZE} campaigns per page. Opens in the log column count events, not people — one recipient opening
        twice is two opens. Open a campaign to see how many distinct people that
        was. Dates are shown in {brand.timezone.replace('_', ' ')}.
      </CountingRule>
    </main>
  )
}
