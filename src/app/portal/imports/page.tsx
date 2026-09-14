import type { Metadata } from 'next'
import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import styles from './imports.module.css'

export const metadata: Metadata = {
  title: 'Imports · Campaign Portal',
}

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

  // Summaries are grouped in the database: a single import can produce tens of
  // thousands of issue rows, and counting them here would mean fetching all of
  // them across the network.
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

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>
          <Link href="/portal" className={styles.back}>
            {brand.brandName}
          </Link>
          {' · Data imports'}
        </p>
        <h1 className={styles.title}>What loaded, and what did not</h1>
        <p className={styles.lede}>
          Every export that has been loaded for {brand.brandName}, with the rows
          that were refused and the reason for each. A row listed as refused is
          not in the portal — it was not stored in a half-corrected form.
        </p>
      </header>

      {runs && runs.length > 0 ? (
        <>
          <dl className={styles.totals}>
            <div className={styles.total}>
              <dt className={styles.totalLabel}>Rows read</dt>
              <dd className={styles.totalValue}>{n(totals.read)}</dd>
            </div>
            <div className={styles.total}>
              <dt className={styles.totalLabel}>Rows loaded</dt>
              <dd className={styles.totalValue}>{n(totals.loaded)}</dd>
            </div>
            <div className={styles.total}>
              <dt className={styles.totalLabel}>Rows refused</dt>
              <dd className={totals.rejected > 0 ? styles.totalValueWarn : styles.totalValue}>
                {n(totals.rejected)}
              </dd>
            </div>
          </dl>

          <div className={styles.runs}>
            {summaries.map(({ run, issues }) => (
              <section key={run.id} className={styles.run} aria-labelledby={`run-${run.id}`}>
                <header className={styles.runHeader}>
                  <div>
                    <h2 id={`run-${run.id}`} className={styles.runTitle}>
                      {run.source_file}
                    </h2>
                    <p className={styles.runMeta}>
                      {run.entity} ·{' '}
                      {new Date(run.started_at).toLocaleString('en-GB', {
                        timeZone: brand.timezone,
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}{' '}
                      ({brand.timezone.replace('_', ' ')})
                    </p>
                  </div>
                  <span className={run.status === 'succeeded' ? styles.ok : styles.bad}>
                    {run.status}
                  </span>
                </header>

                <dl className={styles.counts}>
                  <div>
                    <dt>Read</dt>
                    <dd>{n(run.rows_read)}</dd>
                  </div>
                  <div>
                    <dt>Added</dt>
                    <dd>{n(run.rows_created)}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>{n(run.rows_updated)}</dd>
                  </div>
                  <div>
                    <dt>Refused</dt>
                    <dd className={run.rows_rejected > 0 ? styles.warnText : undefined}>
                      {n(run.rows_rejected)}
                    </dd>
                  </div>
                  <div>
                    <dt>Listed twice</dt>
                    <dd>{n(run.rows_duplicate)}</dd>
                  </div>
                </dl>

                {run.error ? (
                  <p className={styles.error} role="alert">
                    {run.error}
                  </p>
                ) : null}

                {issues.length > 0 ? (
                  <table className={styles.table}>
                    <caption className={styles.caption}>
                      Refused rows are not in the portal. Warnings were loaded,
                      with the noted field dropped or assumed.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Rows</th>
                        <th scope="col">What happened</th>
                        <th scope="col">Example</th>
                      </tr>
                    </thead>
                    <tbody>
                      {issues.map((issue) => (
                        <tr key={`${issue.severity}-${issue.reason_code}`}>
                          <td className={styles.countCell}>
                            <span
                              className={
                                issue.severity === 'rejected' ? styles.badgeBad : styles.badgeWarn
                              }
                            >
                              {issue.severity === 'rejected' ? 'refused' : 'kept'}
                            </span>
                            {n(issue.issue_count)}
                          </td>
                          <td>{issue.example}</td>
                          <td className={styles.exampleCell}>
                            {issue.example_line ? (
                              <span className={styles.line}>line {n(issue.example_line)}</span>
                            ) : null}
                            {issue.example_value ? (
                              <code className={styles.value}>{issue.example_value}</code>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className={styles.clean}>Every row in this file loaded cleanly.</p>
                )}
              </section>
            ))}
          </div>
        </>
      ) : (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No imports yet</p>
          <p className={styles.emptyBody}>
            Nothing has been loaded for {brand.brandName}. When an export is
            imported, this page lists what arrived and what was refused.
          </p>
        </div>
      )}
    </main>
  )
}
