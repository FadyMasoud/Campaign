import type { SignupDay } from '@/lib/analytics/queries'
import { CountingRule } from './basis'
import styles from './dashboard.module.css'

/**
 * Signups per day, drawn as bars with no charting library.
 *
 * A dependency would add ~60KB of JavaScript to render 30 rectangles, and a
 * bar chart made of divs works without JavaScript at all — which also means it
 * is present in the HTML for a screen reader, as a real table would be.
 *
 * The empty case is the interesting one. Karoo and Marrakech have no signups
 * in the real last 30 days, because their exports stop in April 2026. The
 * chart says so in words rather than showing a flat line that looks like a
 * bug, and names the most recent signup so the reader knows the data is old
 * rather than missing.
 */
export function SignupChart({
  days,
  timezone,
  latestSignupAt,
  futureDated,
  windowTotal,
}: {
  days: SignupDay[]
  timezone: string
  latestSignupAt: string | null
  futureDated: number
  windowTotal: number
}) {
  const peak = Math.max(1, ...days.map((day) => day.signups))

  const formatDay = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      timeZone: 'UTC',
    })

  if (windowTotal === 0) {
    return (
      <div className={styles.empty}>
        <p className={styles.emptyTitle}>No signups in the last 30 days</p>
        <p className={styles.emptyBody}>
          This is the real last 30 days, not the last 30 days containing data.
          {latestSignupAt ? (
            <>
              {' '}
              The most recent signup for this brand was{' '}
              <strong>
                {new Date(latestSignupAt).toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                  timeZone: timezone,
                })}
              </strong>
              .
            </>
          ) : null}{' '}
          The chart is empty because nothing happened, not because nothing
          loaded.
        </p>
      </div>
    )
  }

  return (
    <>
      <div className={styles.chart} role="img" aria-label={`Signups per day for the last ${days.length} days`}>
        {days.map((day) => (
          <div key={day.day} className={styles.barColumn}>
            <div
              className={day.signups > 0 ? styles.bar : styles.barEmpty}
              style={{ blockSize: `${Math.round((day.signups / peak) * 100)}%` }}
              title={`${formatDay(day.day)}: ${day.signups.toLocaleString('en')}`}
            />
          </div>
        ))}
      </div>

      <div className={styles.chartAxis}>
        <span>{days.length > 0 ? formatDay(days[0].day) : ''}</span>
        <span>{windowTotal.toLocaleString('en')} in this window</span>
        <span>{days.length > 0 ? formatDay(days[days.length - 1].day) : ''}</span>
      </div>

      {/* The table is not decoration: a bar chart made of divs is unreadable to
          a screen reader, and 30 numbers is a small enough table to just say. */}
      <details className={styles.details}>
        <summary className={styles.summary}>The same figures as a table</summary>
        <table className={styles.dayTable}>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Signups</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.day}>
                <th scope="row">{formatDay(day.day)}</th>
                <td>{day.signups.toLocaleString('en')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      <CountingRule>
        A day is a day in {timezone.replace('_', ' ')}, this brand&rsquo;s own
        timezone — not UTC. A signup at 23:30 UTC belongs to the next morning
        here, and bucketing by UTC would file it under the wrong day.
        {futureDated > 0 ? (
          <>
            {' '}
            {futureDated.toLocaleString('en')} customer
            {futureDated === 1 ? ' has a signup date' : 's have signup dates'} in
            the future, which cannot have happened; they are counted as
            customers but excluded from this trend.
          </>
        ) : null}
      </CountingRule>
    </>
  )
}
