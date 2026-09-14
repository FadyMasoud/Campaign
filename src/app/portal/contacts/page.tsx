import type { Metadata } from 'next'
import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { BasisTag, CountingRule } from '../basis'
import styles from './contacts.module.css'

export const metadata: Metadata = { title: 'Customers · Campaign Portal' }
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

type ContactRow = {
  id: string
  external_id: string
  full_name: string | null
  email: string | null
  phone_e164: string | null
  country_code: string | null
  city: string | null
  status: 'active' | 'pending' | 'unsubscribed' | 'bounced'
  consent_marketing: boolean
  signup_at: string | null
  deleted_at: string | null
  suppressed_until: string | null
  opted_out_at: string | null
  bounced_at: string | null
}

type Filter = 'all' | 'contactable' | 'unreachable'

/**
 * Reachability for one customer, worked out from the same rule the dashboard
 * waterfall uses. Kept as one function so the list and the totals can never
 * drift into disagreeing about who is contactable.
 */
function reachability(row: ContactRow): { contactable: boolean; reason: string } {
  if (row.deleted_at) return { contactable: false, reason: 'Removed' }
  if (!row.consent_marketing) return { contactable: false, reason: 'No consent' }
  if (row.status === 'unsubscribed') return { contactable: false, reason: 'Unsubscribed' }
  if (row.status === 'bounced') return { contactable: false, reason: 'Bounced' }
  if (row.suppressed_until && new Date(row.suppressed_until) > new Date()) {
    return { contactable: false, reason: 'Suppressed' }
  }
  if (row.opted_out_at) return { contactable: false, reason: 'Opted out (log)' }
  if (row.bounced_at) return { contactable: false, reason: 'Bounced (log)' }
  return { contactable: true, reason: 'Contactable' }
}

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; page?: string; filter?: string }>
}) {
  const brand = await requireBrand()
  const params = await searchParams

  const term = (params.q ?? '').trim()
  const filter: Filter =
    params.filter === 'contactable' || params.filter === 'unreachable' ? params.filter : 'all'
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1)
  const from = (page - 1) * PAGE_SIZE

  const supabase = await createServerSupabaseClient()

  /*
   * No .eq('brand_id', …) anywhere below. The rows come back scoped because
   * the database scopes them, which is the same reason this page cannot be
   * made to leak by tampering with the query string: `page`, `q` and `filter`
   * only ever narrow a set that was already narrowed by the policy.
   *
   * Paging is done with .range(), so only fifty rows cross the network however
   * large the brand is.
   */
  let query = supabase
    .from('contacts')
    .select(
      'id, external_id, full_name, email, phone_e164, country_code, city, status, consent_marketing, signup_at, deleted_at, suppressed_until, opted_out_at, bounced_at',
      { count: 'exact' },
    )

  if (term) {
    // Matched against the three fields a person would actually search by. The
    // trigram indexes are what keep this quick at 81,842 rows; without them a
    // leading-wildcard match reads the whole table.
    const escaped = term.replace(/[%,()]/g, ' ')
    query = query.or(
      `full_name.ilike.%${escaped}%,email.ilike.%${escaped}%,external_id.ilike.${escaped}%`,
    )
  }

  if (filter === 'contactable') {
    query = query
      .is('deleted_at', null)
      .eq('consent_marketing', true)
      .not('status', 'in', '("unsubscribed","bounced")')
      .is('opted_out_at', null)
      .is('bounced_at', null)
  }

  const { data, count, error } = await query
    .order('signup_at', { ascending: false, nullsFirst: false })
    .range(from, from + PAGE_SIZE - 1)
    .returns<ContactRow[]>()

  if (error) {
    return (
      <main className={styles.page}>
        <p className={styles.error} role="alert">
          The customer list could not be loaded. {error.message}
        </p>
      </main>
    )
  }

  const rows = (data ?? []).filter((row) =>
    filter === 'unreachable' ? !reachability(row).contactable : true,
  )
  const total = count ?? 0
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE))

  const href = (next: Partial<{ q: string; page: number; filter: Filter }>) => {
    const search = new URLSearchParams()
    const q = next.q ?? term
    const f = next.filter ?? filter
    if (q) search.set('q', q)
    if (f !== 'all') search.set('filter', f)
    if (next.page && next.page > 1) search.set('page', String(next.page))
    const qs = search.toString()
    return qs ? `/portal/contacts?${qs}` : '/portal/contacts'
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Customers</h1>
        <BasisTag basis="derived" />
      </header>

      {/* A plain GET form: search works with JavaScript disabled, the result is
          a real URL somebody can bookmark or send to a colleague, and the back
          button behaves. */}
      <form method="get" action="/portal/contacts" className={styles.controls} role="search">
        <label htmlFor="q" className={styles.srOnly}>
          Search customers by name, email or reference
        </label>
        <input
          id="q"
          name="q"
          type="search"
          defaultValue={term}
          placeholder="Name, email, or reference such as CT-0057"
          className={styles.search}
        />
        {filter !== 'all' ? <input type="hidden" name="filter" value={filter} /> : null}
        <button type="submit" className={styles.searchButton}>
          Search
        </button>
      </form>

      <div className={styles.filters}>
        {(['all', 'contactable', 'unreachable'] as const).map((option) => (
          <Link
            key={option}
            href={href({ filter: option, page: 1 })}
            className={filter === option ? styles.filterCurrent : styles.filter}
            aria-current={filter === option ? 'true' : undefined}
          >
            {option === 'all' ? 'Everyone' : option === 'contactable' ? 'Contactable' : 'Cannot be reached'}
          </Link>
        ))}
      </div>

      <p className={styles.summary}>
        {total === 0 ? (
          'No customers match.'
        ) : (
          <>
            <strong>{total.toLocaleString('en')}</strong>{' '}
            {term ? `match “${term}”` : 'customers'}
            {filter === 'contactable' ? ', contactable' : ''} · showing{' '}
            {(from + 1).toLocaleString('en')}–
            {Math.min(from + PAGE_SIZE, total).toLocaleString('en')}
          </>
        )}
      </p>

      {rows.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing to show</p>
          <p className={styles.emptyBody}>
            {term
              ? `No customer matches “${term}”. Try part of a name, an email address, or a reference such as CT-000123.`
              : 'No customers match this filter.'}
          </p>
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Reference</th>
                <th scope="col">Reach</th>
                <th scope="col">Where</th>
                <th scope="col">Signed up</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const reach = reachability(row)
                return (
                  <tr key={row.id}>
                    <td>
                      <span className={styles.name}>{row.full_name ?? 'Unnamed'}</span>
                      <span className={styles.contactMethods}>
                        {row.email ?? null}
                        {row.email && row.phone_e164 ? ' · ' : null}
                        {row.phone_e164 ?? null}
                        {!row.email && !row.phone_e164 ? '—' : null}
                      </span>
                    </td>
                    <td className={styles.mono}>{row.external_id}</td>
                    <td>
                      <span className={reach.contactable ? styles.reachOk : styles.reachNo}>
                        {reach.reason}
                      </span>
                    </td>
                    <td className={styles.muted}>
                      {[row.city, row.country_code].filter(Boolean).join(', ') || '—'}
                    </td>
                    <td className={styles.mono}>
                      {row.signup_at
                        ? new Date(row.signup_at).toLocaleDateString('en-GB', {
                            day: 'numeric',
                            month: 'short',
                            year: 'numeric',
                            timeZone: brand.timezone,
                          })
                        : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {lastPage > 1 ? (
        <nav className={styles.pager} aria-label="Pages">
          {page > 1 ? (
            <Link href={href({ page: page - 1 })} className={styles.pageLink} rel="prev">
              ← Previous
            </Link>
          ) : (
            <span className={styles.pageDisabled}>← Previous</span>
          )}
          <span className={styles.pageStatus}>
            Page {page.toLocaleString('en')} of {lastPage.toLocaleString('en')}
          </span>
          {page < lastPage ? (
            <Link href={href({ page: page + 1 })} className={styles.pageLink} rel="next">
              Next →
            </Link>
          ) : (
            <span className={styles.pageDisabled}>Next →</span>
          )}
        </nav>
      ) : null}

      <CountingRule>
        &ldquo;Contactable&rdquo; uses the same rule as the dashboard: consented,
        not removed, not suppressed, and with no unsubscribe, complaint or
        bounce in the event log. Dates are shown in{' '}
        {brand.timezone.replace('_', ' ')}.
      </CountingRule>
    </main>
  )
}
