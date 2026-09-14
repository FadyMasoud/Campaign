import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { notFound } from 'next/navigation'
import { readSharedReport } from '@/lib/reports/read'
import { grantCookieName, grantIsValid } from '@/lib/reports/session'
import { UnlockForm } from './unlock'
import styles from './report.module.css'

/**
 * The public campaign report.
 *
 * Reachable with no account at all — it is listed in proxy.ts as a public
 * path, and it is the only page in the portal that is.
 */
export const dynamic = 'force-dynamic'

/*
 * A guessed token renders the not-found page. The status is 200 rather than
 * 404, and that is documented Next.js behaviour rather than an oversight here:
 * "Next.js will return a 200 HTTP status code for streamed responses, and 404
 * for non-streamed responses". This page is dynamic, so it streams.
 *
 * The SEO consequence is handled by the framework, which injects
 * <meta name="robots" content="noindex"> on the not-found response — verified
 * on this route. Nothing about any report reaches that page: a stranger
 * guessing gets the same empty 404 whether the token was never real, has been
 * withdrawn, or exists and they simply do not have it.
 *
 * noindex is set here too, for the report itself. A shared link that finds its
 * way into a search index is no longer shared, it is published.
 */
export const metadata: Metadata = {
  title: 'Campaign results',
  robots: { index: false, follow: false, nocache: true },
}

const n = (value: number | null) => (value === null ? '—' : value.toLocaleString('en'))
const percent = (a: number | null, b: number | null) =>
  a === null || b === null || b === 0 ? '—' : `${((a / b) * 100).toFixed(1)}%`

export default async function SharedReportPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  /*
   * The report is read BEFORE the password is considered, but nothing is
   * rendered from it until the grant checks out. That order is deliberate: an
   * unknown token and a known one must take the same path and produce the same
   * 404, so that response times and error pages do not tell a stranger which
   * tokens exist.
   */
  const report = await readSharedReport(token)
  if (!report) notFound()

  const store = await cookies()
  const unlocked = grantIsValid(token, store.get(grantCookieName(token))?.value)

  if (!unlocked) {
    return (
      <main className={styles.gate}>
        <div className={styles.gateCard}>
          <p className={styles.eyebrow}>Campaign results</p>
          <h1 className={styles.gateTitle}>This report is password-protected</h1>
          <p className={styles.gateBody}>
            Enter the password you were given alongside this link. It was set by
            whoever shared it with you.
          </p>
          <UnlockForm token={token} />
        </div>
      </main>
    )
  }

  const sentAt = report.sentAt
    ? new Date(report.sentAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: report.timezone,
      })
    : null

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>{report.brandName}</p>
        <h1 className={styles.title}>{report.campaignName}</h1>
        <p className={styles.lede}>
          {report.channel === 'email' ? 'Email' : 'SMS'} campaign
          {sentAt ? ` · sent ${sentAt}` : null} · reference {report.campaignRef}
        </p>
      </header>

      <section className={styles.panel} aria-labelledby="provider">
        <h2 id="provider" className={styles.panelTitle}>
          Reported by the messaging provider
        </h2>

        <dl className={styles.figures}>
          <Figure label="Sent" value={n(report.reportedSent)} />
          <Figure label="Delivered" value={n(report.reportedDelivered)} />
          <Figure label="Bounced" value={n(report.reportedBounced)} />
          <Figure
            label="Delivery rate"
            value={percent(report.reportedDelivered, report.reportedSent)}
          />
          <Figure label="Opens" value={n(report.reportedOpens)} />
          <Figure label="Clicks" value={n(report.reportedClicks)} />
        </dl>

        <p className={styles.note}>
          These are the provider&rsquo;s own figures, reproduced exactly as it
          stated them. Delivery rate is delivered ÷ sent.
        </p>
      </section>

      <section className={styles.panel} aria-labelledby="engagement">
        <h2 id="engagement" className={styles.panelTitle}>
          Counted from the engagement log
        </h2>

        {report.hasEvents ? (
          <>
            <dl className={styles.figures}>
              <Figure label="Opens" value={n(report.logOpens)} />
              <Figure label="People who opened" value={n(report.peopleOpened)} />
              <Figure label="Clicks" value={n(report.logClicks)} />
              <Figure label="People who clicked" value={n(report.peopleClicked)} />
              <Figure label="Unsubscribed" value={n(report.logUnsubscribes)} />
            </dl>

            <p className={styles.note}>
              Opens count events and &ldquo;people&rdquo; counts individuals —
              one recipient opening twice is two opens and one person. These are
              counted independently of the provider&rsquo;s figures above and
              will not always agree with them; both are shown rather than one
              being chosen.
            </p>
          </>
        ) : (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No engagement log for this campaign</p>
            <p className={styles.emptyBody}>
              There are no individual engagement records held for this campaign,
              so the provider&rsquo;s figures above stand on their own.
            </p>
          </div>
        )}
      </section>

      <footer className={styles.footer}>
        <p>
          Prepared for {report.brandName} ·{' '}
          {new Date(report.publishedAt).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: report.timezone,
          })}
        </p>
        <p className={styles.footerNote}>
          This page shows one campaign&rsquo;s totals. It contains no customer
          details and no other campaign.
        </p>
      </footer>
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
