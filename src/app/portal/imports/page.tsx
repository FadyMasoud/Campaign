import type { Metadata } from 'next'
import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import styles from './imports.module.css'

export const metadata: Metadata = { title: 'Imports · Campaign Portal' }
export const dynamic = 'force-dynamic'

type Run = {
  id: string
  source_file: string
  entity: string
  status: 'running' | 'succeeded' | 'failed'
  started_at: string
  finished_at: string | null
  rows_read: number
  rows_created: number
  rows_updated: number
  rows_rejected: number
  rows_duplicate: number
  error: string | null
}

type IssueSummary = {
  severity: 'rejected' | 'warning'
  reason_code: string
  issue_count: number
  example: string
  example_line: number | null
  example_value: string | null
}

const n = (value: number) => value.toLocaleString('en')

/**
 * Plain-English titles for the machine-readable reason codes.
 *
 * The code is what the database stores and what groups thousands of rows into
 * one line; this is what a marketer reads. Without it the screen says
 * `phone_unreadable` 44,686 times over, which is accurate and useless.
 */
const REASON_TITLE: Record<string, string> = {
  phone_unreadable: 'Phone number could not be read',
  consent_absent: 'No marketing consent recorded',
  email_invalid: 'Email address not usable',
  date_without_time: 'Date had no time on it',
  date_ambiguous: 'Date could be read two ways',
  duplicate_conflicting: 'Same customer listed twice, differently',
  country_unreadable: 'Country not recognised',
  unknown_campaign_reference: 'Result names a campaign we do not have',
  parent_campaign_unresolved: 'Parent campaign belongs to another brand',
  unreachable: 'No usable email and no usable phone',
  wrong_brand: 'Row belongs to a different brand',
  status_unknown: 'Customer status not recognised',
  status_missing: 'Customer status was blank',
  unknown_contact_reference: 'Result belongs to a customer we do not have',
  nul_byte: 'Row contained an unstorable character',
  repeated_header_row: 'Column headings repeated mid-file',
  external_id_missing: 'Row had no customer reference',
  consent_unreadable: 'Consent value was neither yes nor no',
  number_unreadable: 'Value was not a number',
  date_unreadable: 'Date could not be read',
  channel_unknown: 'Channel was not email or SMS',
  event_type_unknown: 'Result type not recognised',
  occurred_at_missing: 'Result had no date',
  contact_reference_missing: 'Result did not say which customer',
}

const ENTITY_WORD: Record<string, string> = {
  contacts: 'Customers',
  campaigns: 'Campaigns',
  events: 'Results',
}

export default async function ImportsPage() {
  const brand = await requireBrand()
  const supabase = await createServerSupabaseClient()

  // No brand filter. One brand's runs come back because the database applies
  // the policy, exactly as everywhere else in this app.
  const { data: runs, error } = await supabase
    .from('import_runs')
    .select('*')
    .order('started_at', { ascending: false })
    .returns<Run[]>()

  if (error) {
    return (
      <main className={styles.page}>
        <p className={styles.error} role="alert">
          The import history could not be loaded. {error.message}
        </p>
      </main>
    )
  }

  // Grouped in the database: one import can produce tens of thousands of issue
  // rows, and counting them here would mean fetching all of them.
  const summaries = await Promise.all(
    (runs ?? []).map(async (run) => {
      const { data } = await supabase.rpc('import_issue_summary', { target_run_id: run.id })
      return { run, issues: (data ?? []) as IssueSummary[] }
    }),
  )

  const totals = (runs ?? []).reduce(
    (acc, run) => ({
      read: acc.read + run.rows_read,
      loaded: acc.loaded + run.rows_created + run.rows_updated,
      rejected: acc.rejected + run.rows_rejected,
    }),
    { read: 0, loaded: 0, rejected: 0 },
  )

  if (!runs || runs.length === 0) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Data imports</h1>
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No imports yet</p>
          <p className={styles.emptyBody}>
            Nothing has been loaded for {brand.brandName}. When an export is
            imported, this page lists what arrived and what was refused.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>What loaded, and what did not</h1>
        <p className={styles.lede}>
          Every export loaded for {brand.brandName}. A row listed as refused is
          not in the portal — it was never stored in a half-corrected form.
        </p>
      </header>

      {/* A sentence first, then the numbers. Most people want the shape of the
          answer before the digits. */}
      <section className={styles.summaryCard}>
        <p className={styles.summarySentence}>
          Out of <strong>{n(totals.read)}</strong> rows across {runs.length} files,{' '}
          <strong>{n(totals.loaded)}</strong> made it into the portal
          {totals.rejected > 0 ? (
            <> and <strong className={styles.refusedWord}>{n(totals.rejected)}</strong> were refused.</>
          ) : (
            <> and none were refused.</>
          )}
        </p>

        {/* One bar beats three numbers for "how much of it worked". */}
        <div className={styles.bar} role="img" aria-label={`${n(totals.loaded)} loaded, ${n(totals.rejected)} refused`}>
          <div
            className={styles.barLoaded}
            style={{ inlineSize: `${(totals.loaded / Math.max(totals.read, 1)) * 100}%` }}
          />
          <div
            className={styles.barRefused}
            style={{ inlineSize: `${(totals.rejected / Math.max(totals.read, 1)) * 100}%` }}
          />
        </div>

        <dl className={styles.totals}>
          <div className={styles.total}>
            <dt>Rows read</dt>
            <dd>{n(totals.read)}</dd>
          </div>
          <div className={styles.total}>
            <dt>Loaded</dt>
            <dd className={styles.valueOk}>{n(totals.loaded)}</dd>
          </div>
          <div className={styles.total}>
            <dt>Refused</dt>
            <dd className={totals.rejected > 0 ? styles.valueBad : undefined}>{n(totals.rejected)}</dd>
          </div>
        </dl>
      </section>

      <div className={styles.runs}>
        {summaries.map(({ run, issues }) => {
          const refused = issues.filter((issue) => issue.severity === 'rejected')
          const warnings = issues.filter((issue) => issue.severity === 'warning')
          const loaded = run.rows_created + run.rows_updated

          return (
            <section key={run.id} className={styles.run} aria-labelledby={`run-${run.id}`}>
              {/* The navy header, matching the sidebar — each file reads as its
                  own titled object rather than another box on a pale page. */}
              <header className={styles.runHeader}>
                <div className={styles.runHeading}>
                  <h2 id={`run-${run.id}`} className={styles.runTitle}>
                    {run.source_file}
                  </h2>
                  <p className={styles.runMeta}>
                    {ENTITY_WORD[run.entity] ?? run.entity} ·{' '}
                    {new Date(run.started_at).toLocaleString('en-GB', {
                      timeZone: brand.timezone,
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                  </p>
                </div>
                <span className={run.status === 'succeeded' ? styles.ok : styles.bad}>
                  {run.status === 'succeeded' ? 'Loaded' : run.status}
                </span>
              </header>

              <div className={styles.runBody}>
                <p className={styles.runSentence}>
                  Read <strong>{n(run.rows_read)}</strong> rows.{' '}
                  {run.rows_created > 0 ? <>Added <strong>{n(run.rows_created)}</strong>. </> : null}
                  {run.rows_updated > 0 ? <>Updated <strong>{n(run.rows_updated)}</strong>. </> : null}
                  {run.rows_rejected > 0 ? (
                    <>Refused <strong className={styles.refusedWord}>{n(run.rows_rejected)}</strong>. </>
                  ) : null}
                  {run.rows_duplicate > 0 ? (
                    <>{n(run.rows_duplicate)} rows repeated a customer already in the file. </>
                  ) : null}
                </p>

                {run.error ? (
                  <p className={styles.error} role="alert">{run.error}</p>
                ) : null}

                {refused.length > 0 ? (
                  <>
                    <h3 className={styles.groupTitle}>
                      <span className={styles.dotBad} aria-hidden="true" />
                      Refused — these rows are not in the portal
                    </h3>
                    <ul className={styles.issueList}>
                      {refused.map((issue) => (
                        <IssueRow key={issue.reason_code} issue={issue} tone="bad" />
                      ))}
                    </ul>
                  </>
                ) : null}

                {warnings.length > 0 ? (
                  <>
                    <h3 className={styles.groupTitle}>
                      <span className={styles.dotWarn} aria-hidden="true" />
                      Loaded, with something changed or assumed
                    </h3>
                    <ul className={styles.issueList}>
                      {warnings.map((issue) => (
                        <IssueRow key={issue.reason_code} issue={issue} tone="warn" />
                      ))}
                    </ul>
                  </>
                ) : null}

                {issues.length === 0 ? (
                  <p className={styles.clean}>
                    Every one of the {n(loaded)} rows in this file loaded cleanly.
                  </p>
                ) : null}
              </div>
            </section>
          )
        })}
      </div>

      <p className={styles.footnote}>
        Times shown in {brand.timezone.replace('_', ' ')}.{' '}
        <Link href="/portal" className={styles.link}>Back to the dashboard</Link>
      </p>
    </main>
  )
}

/**
 * One reason, as a count, a plain title, and a real example.
 *
 * The count leads because "44,686" is the thing a person reacts to; the
 * example follows because it is what makes the number actionable — a line
 * number and the actual offending value, so the export can be fixed.
 */
function IssueRow({ issue, tone }: { issue: IssueSummary; tone: 'bad' | 'warn' }) {
  const title = REASON_TITLE[issue.reason_code] ?? issue.reason_code.replace(/_/g, ' ')

  return (
    <li className={styles.issue}>
      <span className={tone === 'bad' ? styles.issueCountBad : styles.issueCountWarn}>
        {n(issue.issue_count)}
      </span>

      <div className={styles.issueText}>
        <p className={styles.issueTitle}>{title}</p>
        <p className={styles.issueExplain}>{issue.example}</p>

        {issue.example_line || issue.example_value ? (
          <p className={styles.issueExample}>
            {issue.example_line ? (
              <span className={styles.line}>e.g. line {n(issue.example_line)}</span>
            ) : null}
            {issue.example_value ? <code className={styles.value}>{issue.example_value}</code> : null}
          </p>
        ) : null}
      </div>
    </li>
  )
}
