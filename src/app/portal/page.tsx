import type { Metadata } from 'next'
import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import {
  formatCount,
  getCampaignPerformance,
  getContactability,
  getSignupsPerDay,
} from '@/lib/analytics/queries'
import { BasisTag, CountingRule } from './basis'
import { SignupChart } from './signup-chart'
import styles from './dashboard.module.css'

export const metadata: Metadata = { title: 'Dashboard · Campaign Portal' }
export const dynamic = 'force-dynamic'

const WINDOW_DAYS = 30

export default async function DashboardPage() {
  const brand = await requireBrand()
  const [contactability, signups, campaigns] = await Promise.all([
    getContactability(),
    getSignupsPerDay(WINDOW_DAYS),
    getCampaignPerformance(),
  ])

  if (!contactability || contactability.total === 0) {
    return (
      <main className={styles.page}>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No customers yet</p>
          <p className={styles.emptyBody}>
            {brand.brandName} has nothing loaded. Run an import, then this
            screen will show who can be contacted and how campaigns performed.{' '}
            <Link href="/portal/imports" className={styles.link}>
              Import history
            </Link>
          </p>
        </div>
      </main>
    )
  }

  const c = contactability
  const windowTotal = signups.reduce((sum, day) => sum + day.signups, 0)
  const campaignsWithoutLog = campaigns.filter((campaign) => !campaign.has_events).length

  // Sum the two bases across campaigns so the headline disagreement is visible
  // before anyone opens a single campaign.
  const providerOpens = campaigns.reduce((sum, x) => sum + (x.reported_opens ?? 0), 0)
  const logOpens = campaigns.reduce((sum, x) => sum + x.log_opens, 0)

  const waterfall = [
    { label: 'Removed from the list', value: c.removed },
    { label: 'No marketing consent', value: c.no_consent },
    { label: 'Unsubscribed (customer record)', value: c.status_unsubscribed },
    { label: 'Bounced (customer record)', value: c.status_bounced },
    { label: 'Suppressed until a future date', value: c.suppressed },
    { label: 'Unsubscribed or complained (event log)', value: c.opted_out_in_log },
    { label: 'Bounced (event log)', value: c.bounced_in_log },
  ].filter((step) => step.value > 0)

  return (
    <main className={styles.page}>
      <h1 className={styles.title}>Dashboard</h1>

      {/* --- Total customers and contactable ------------------------------ */}
      <section className={styles.panel} aria-labelledby="audience">
        <div className={styles.panelHead}>
          <h2 id="audience" className={styles.panelTitle}>
            Audience
          </h2>
          <BasisTag basis="derived" />
        </div>

        <dl className={styles.figures}>
          <div className={styles.figure}>
            <dt className={styles.figureLabel}>Total customers</dt>
            <dd className={styles.figureValue}>{formatCount(c.total)}</dd>
            <CountingRule>
              Every customer record held for {brand.brandName}, including{' '}
              {formatCount(c.removed)} marked as removed. Rows refused at import
              are not counted —{' '}
              <Link href="/portal/imports" className={styles.link}>
                see what did not load
              </Link>
              .
            </CountingRule>
          </div>

          <div className={styles.figure}>
            <dt className={styles.figureLabel}>Contactable now</dt>
            <dd className={styles.figureValueAccent}>{formatCount(c.contactable)}</dd>
            <CountingRule>
              Counted the cautious way: a customer is contactable only if they
              have consented, are not removed or suppressed, and the event log
              holds no unsubscribe, complaint or bounce for them.
            </CountingRule>
          </div>
        </dl>

        {/* The whole descent from "everyone" to "contactable", because this is
            the number two careful people are most likely to count differently. */}
        <details className={styles.details}>
          <summary className={styles.summary}>
            How {formatCount(c.total)} becomes {formatCount(c.contactable)}
          </summary>

          <table className={styles.waterfall}>
            <tbody>
              <tr>
                <th scope="row">All customers</th>
                <td>{formatCount(c.total)}</td>
              </tr>
              {waterfall.map((step) => (
                <tr key={step.label}>
                  <th scope="row" className={styles.stepLabel}>
                    − {step.label}
                  </th>
                  <td className={styles.stepValue}>{formatCount(step.value)}</td>
                </tr>
              ))}
              <tr className={styles.waterfallTotal}>
                <th scope="row">Contactable</th>
                <td>{formatCount(c.contactable)}</td>
              </tr>
            </tbody>
          </table>

          <p className={styles.note}>
            Each customer is counted once, under the first reason they cannot be
            reached, so the rows above sum to the total exactly.
          </p>

          {c.opted_out_in_log > c.status_unsubscribed ? (
            <p className={styles.warn}>
              The customer records say {formatCount(c.status_unsubscribed)} people
              unsubscribed, but the event log shows a further{' '}
              {formatCount(c.opted_out_in_log)} who unsubscribed or complained
              without their record being updated. This portal believes the event
              log, because it is a record of what actually happened.
            </p>
          ) : null}
        </details>
      </section>

      {/* --- Signups per day ---------------------------------------------- */}
      <section className={styles.panel} aria-labelledby="signups">
        <div className={styles.panelHead}>
          <h2 id="signups" className={styles.panelTitle}>
            Signups per day · last {WINDOW_DAYS} days
          </h2>
          <BasisTag basis="derived" />
        </div>

        <SignupChart
          days={signups}
          timezone={brand.timezone}
          latestSignupAt={c.latest_signup_at}
          futureDated={c.future_dated_signups}
          windowTotal={windowTotal}
        />
      </section>

      {/* --- Campaign performance ----------------------------------------- */}
      <section className={styles.panel} aria-labelledby="campaigns">
        <div className={styles.panelHead}>
          <h2 id="campaigns" className={styles.panelTitle}>
            Campaign performance
          </h2>
        </div>

        <dl className={styles.figures}>
          <div className={styles.figure}>
            <dt className={styles.figureLabel}>
              Opens <BasisTag basis="provider" />
            </dt>
            <dd className={styles.figureValue}>{formatCount(providerOpens)}</dd>
          </div>
          <div className={styles.figure}>
            <dt className={styles.figureLabel}>
              Opens <BasisTag basis="log" />
            </dt>
            <dd className={styles.figureValue}>{formatCount(logOpens)}</dd>
          </div>
        </dl>

        <p className={styles.warn}>
          These two numbers measure different things and are not reconciled. The
          provider reports what it observed across the whole send; the event log
          is the engagement we hold rows for. Where they disagree, both are
          shown —{' '}
          <Link href="/portal/campaigns" className={styles.link}>
            campaign by campaign
          </Link>
          .
          {campaignsWithoutLog > 0 ? (
            <>
              {' '}
              {campaignsWithoutLog} of {campaigns.length} campaigns have no event
              log at all, so their engagement is provider-reported only.
            </>
          ) : null}
        </p>
      </section>
    </main>
  )
}
