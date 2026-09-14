import type { Metadata } from 'next'
import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { signOut } from '@/lib/auth/actions'
import styles from './portal.module.css'

export const metadata: Metadata = {
  title: 'Portal · Campaign Portal',
}

/*
 * Reads cookies and live data, so it is rendered per request. Caching this
 * would be a correctness bug rather than a performance win: a cached page is a
 * page one brand could be served from another brand's render.
 */
export const dynamic = 'force-dynamic'

type Totals = { contacts: number; campaigns: number; events: number; rejected: number }

/**
 * Counts what this brand can see.
 *
 * Note what is missing: any `.eq('brand_id', …)`. These queries ask for
 * *everything* in each table, and come back with one brand's rows, because the
 * database applies the policy. That is the guarantee doing its job — if it
 * were switched off, this page would silently start reporting all three
 * brands' totals, which is exactly what the isolation test checks for.
 */
async function readTotals(): Promise<Totals> {
  const supabase = await createServerSupabaseClient()

  const [contacts, campaigns, events, rejected] = await Promise.all([
    supabase.from('contacts').select('*', { count: 'exact', head: true }),
    supabase.from('campaigns').select('*', { count: 'exact', head: true }),
    supabase.from('contact_events').select('*', { count: 'exact', head: true }),
    // Refused rows are surfaced on the landing screen rather than buried, so
    // nobody reads a customer count without knowing some rows did not make it.
    supabase.from('import_issues').select('*', { count: 'exact', head: true }).eq('severity', 'rejected'),
  ])

  return {
    contacts: contacts.count ?? 0,
    campaigns: campaigns.count ?? 0,
    events: events.count ?? 0,
    rejected: rejected.count ?? 0,
  }
}

export default async function PortalPage() {
  const brand = await requireBrand()
  const totals = await readTotals()

  const isEmpty = totals.contacts === 0 && totals.campaigns === 0 && totals.events === 0

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <p className={styles.eyebrow}>Campaign Portal</p>
          <h1 className={styles.brandName}>{brand.brandName}</h1>
        </div>

        <div className={styles.account}>
          <div className={styles.identity}>
            <span className={styles.email}>{brand.email}</span>
            <span
              className={brand.role === 'owner' ? styles.roleOwner : styles.roleAnalyst}
            >
              {brand.role === 'owner' ? 'Owner' : 'Analyst'}
            </span>
          </div>

          <form action={signOut}>
            <button type="submit" className={styles.signOut}>
              Sign out
            </button>
          </form>
        </div>
      </header>

      <main className={styles.main}>
        <section className={styles.panel} aria-labelledby="totals-heading">
          <h2 id="totals-heading" className={styles.panelTitle}>
            Your data
          </h2>

          {isEmpty ? (
            <div className={styles.empty}>
              <p className={styles.emptyTitle}>Nothing imported yet</p>
              <p className={styles.emptyBody}>
                {brand.brandName} has no customers, campaigns or results in the
                portal so far. They arrive with the first import, which is the
                next piece of work. This screen is empty because the data is
                genuinely absent — not because it failed to load.
              </p>
            </div>
          ) : (
            <dl className={styles.totals}>
              <div className={styles.total}>
                <dt className={styles.totalLabel}>Customers</dt>
                <dd className={styles.totalValue}>
                  {totals.contacts.toLocaleString('en')}
                </dd>
              </div>
              <div className={styles.total}>
                <dt className={styles.totalLabel}>Campaigns</dt>
                <dd className={styles.totalValue}>
                  {totals.campaigns.toLocaleString('en')}
                </dd>
              </div>
              <div className={styles.total}>
                <dt className={styles.totalLabel}>Recorded results</dt>
                <dd className={styles.totalValue}>
                  {totals.events.toLocaleString('en')}
                </dd>
              </div>
            </dl>
          )}

          {totals.rejected > 0 ? (
            <p className={styles.refused}>
              <strong>{totals.rejected.toLocaleString('en')} rows were refused</strong>{' '}
              during import and are not counted above.{' '}
              <Link href="/portal/imports" className={styles.link}>
                See what did not load and why
              </Link>
              .
            </p>
          ) : (
            <p className={styles.footnote}>
              <Link href="/portal/imports" className={styles.link}>
                Import history
              </Link>
            </p>
          )}
        </section>

        <section className={styles.panel} aria-labelledby="permissions-heading">
          <h2 id="permissions-heading" className={styles.panelTitle}>
            What this account can do
          </h2>

          <ul className={styles.permissions}>
            <li className={styles.permission}>
              <span className={styles.permissionAllowed} aria-hidden="true">
                ✓
              </span>
              Read {brand.brandName}&rsquo;s customers, campaigns and results
            </li>
            <li className={styles.permission}>
              <span
                className={
                  brand.role === 'owner'
                    ? styles.permissionAllowed
                    : styles.permissionDenied
                }
                aria-hidden="true"
              >
                {brand.role === 'owner' ? '✓' : '✕'}
              </span>
              Send a campaign
              {brand.role === 'analyst' ? (
                <span className={styles.permissionNote}>
                  {' '}
                  — analysts have read-only access. Hiding the control is only a
                  courtesy: the database refuses the write as well, so it cannot
                  be done by going around this screen.
                </span>
              ) : null}
            </li>
            <li className={styles.permission}>
              <span className={styles.permissionDenied} aria-hidden="true">
                ✕
              </span>
              See any other brand&rsquo;s data — enforced in the database, not
              here
            </li>
          </ul>
        </section>

        <p className={styles.footnote}>
          Dates and times are shown in {brand.timezone.replace('_', ' ')}, the
          working timezone for {brand.brandName}.
        </p>
      </main>
    </div>
  )
}
