import type { Metadata } from 'next'
import Link from 'next/link'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { BasisTag, CountingRule } from '../basis'
import styles from './contacts.module.css'

export const metadata: Metadata = { title: 'Customers · Campaign Portal' }
export const dynamic = 'force-dynamic'

const PAGE_SIZE = 20

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
 * Reachability for one customer, by the same rule the dashboard waterfall
 * uses. One function, so the list and the totals can never drift into
 * disagreeing about who is contactable.
 */
function reachability(row: ContactRow): { contactable: boolean; reason: string } {
  if (row.deleted_at) return { contactable: false, reason: 'Removed' }
  if (!row.consent_marketing) return { contactable: false, reason: 'No consent' }
  if (row.status === 'unsubscribed') return { contactable: false, reason: 'Unsubscribed' }
  if (row.status === 'bounced') return { contactable: false, reason: 'Bounced' }
  if (row.suppressed_until && new Date(row.suppressed_until) > new Date()) {
    return { contactable: false, reason: 'Suppressed' }
  }
  if (row.opted_out_at) return { contactable: false, reason: 'Opted out' }
  if (row.bounced_at) return { contactable: false, reason: 'Bounced' }
  return { contactable: true, reason: 'Contactable' }
}

/** Escapes characters PostgREST reads as syntax inside an or() filter. */
const clean = (value: string) => value.replace(/[%,()]/g, ' ').trim()

export default async function ContactsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string
    ref?: string
    loc?: string
    filter?: string
    page?: string
  }>
}) {
  const brand = await requireBrand()
  const params = await searchParams

  const q = (params.q ?? '').trim()
  const ref = (params.ref ?? '').trim()
  const loc = (params.loc ?? '').trim()
  const filter: Filter =
    params.filter === 'contactable' || params.filter === 'unreachable' ? params.filter : 'all'
  const page = Math.max(1, Number.parseInt(params.page ?? '1', 10) || 1)
  const from = (page - 1) * PAGE_SIZE

  const supabase = await createServerSupabaseClient()

  /*
   * No .eq('brand_id', …) anywhere below. Rows come back scoped because the
   * database scopes them, which is why tampering with the query string cannot
   * widen the result: every parameter only ever narrows a set the policy has
   * already narrowed.
   */
  let query = supabase
    .from('contacts')
    .select(
      'id, external_id, full_name, email, phone_e164, country_code, city, status, consent_marketing, signup_at, deleted_at, suppressed_until, opted_out_at, bounced_at',
      { count: 'exact' },
    )

  // Each column filters its own field, so a search for "CT-0057" in the
  // reference column cannot accidentally match somebody's notes.
  if (q) query = query.or(`full_name.ilike.%${clean(q)}%,email.ilike.%${clean(q)}%`)
  if (ref) query = query.ilike('external_id', `%${clean(ref)}%`)
  if (loc) query = query.or(`city.ilike.%${clean(loc)}%,country_code.ilike.%${clean(loc)}%`)

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

  const href = (next: Partial<{ page: number; filter: Filter }>) => {
    const search = new URLSearchParams()
    if (q) search.set('q', q)
    if (ref) search.set('ref', ref)
    if (loc) search.set('loc', loc)
    const f = next.filter ?? filter
    if (f !== 'all') search.set('filter', f)
    if (next.page && next.page > 1) search.set('page', String(next.page))
    const qs = search.toString()
    return qs ? `/portal/contacts?${qs}` : '/portal/contacts'
  }

  const filtered = Boolean(q || ref || loc || filter !== 'all')

  // Page numbers around the current one, so 4,093 pages do not print 4,093
  // links. Always includes the first and last.
  const pageNumbers = (() => {
    const around = new Set<number>([1, lastPage, page])
    for (let offset = 1; offset <= 2; offset += 1) {
      if (page - offset > 1) around.add(page - offset)
      if (page + offset < lastPage) around.add(page + offset)
    }
    return [...around].sort((a, b) => a - b)
  })()

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <h1 className={styles.title}>Customers</h1>
        <BasisTag basis="derived" />
      </header>

      {/*
        A plain GET form. Search works with JavaScript disabled, the result is
        a real URL somebody can bookmark or send to a colleague, and the back
        button behaves. The inputs live inside the table head and reach this
        form through the `form` attribute, because a <form> cannot legally be a
        child of <table>.
      */}
      <form id="contact-filters" method="get" action="/portal/contacts" role="search" />

      <div className={styles.toolbar}>
        <p className={styles.summary}>
          {total === 0 ? (
            'No customers match.'
          ) : (
            <>
              <strong>{total.toLocaleString('en')}</strong>{' '}
              {filtered ? 'matching' : 'customers'} · showing{' '}
              {(from + 1).toLocaleString('en')}–
              {Math.min(from + PAGE_SIZE, total).toLocaleString('en')}
            </>
          )}
        </p>

        {filtered ? (
          <Link href="/portal/contacts" className={styles.clearLink}>
            Clear all filters
          </Link>
        ) : null}
      </div>

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

            {/* One search box per column, sitting directly under its heading —
                so it is obvious which field each one searches. */}
            <tr className={styles.filterRow}>
              <td>
                <label htmlFor="f-q" className={styles.srOnly}>Search name or email</label>
                <input
                  id="f-q" name="q" form="contact-filters" type="search"
                  defaultValue={q} placeholder="Name or email"
                  className={styles.columnInput}
                />
              </td>
              <td>
                <label htmlFor="f-ref" className={styles.srOnly}>Search reference</label>
                <input
                  id="f-ref" name="ref" form="contact-filters" type="search"
                  defaultValue={ref} placeholder="CT-000123"
                  className={styles.columnInput}
                />
              </td>
              <td>
                <label htmlFor="f-filter" className={styles.srOnly}>Filter by reach</label>
                <select
                  id="f-filter" name="filter" form="contact-filters"
                  defaultValue={filter} className={styles.columnSelect}
                >
                  <option value="all">Everyone</option>
                  <option value="contactable">Contactable</option>
                  <option value="unreachable">Cannot be reached</option>
                </select>
              </td>
              <td>
                <label htmlFor="f-loc" className={styles.srOnly}>Search city or country</label>
                <input
                  id="f-loc" name="loc" form="contact-filters" type="search"
                  defaultValue={loc} placeholder="City or country"
                  className={styles.columnInput}
                />
              </td>
              <td>
                <button type="submit" form="contact-filters" className={styles.filterButton}>
                  Search
                </button>
              </td>
            </tr>
          </thead>

          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className={styles.emptyCell}>
                  <p className={styles.emptyTitle}>Nothing matches</p>
                  <p className={styles.emptyBody}>
                    Try part of a name, an email address, or a reference such as
                    CT-000123.
                  </p>
                </td>
              </tr>
            ) : (
              rows.map((row) => {
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
                            day: 'numeric', month: 'short', year: 'numeric',
                            timeZone: brand.timezone,
                          })
                        : '—'}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {lastPage > 1 ? (
        <nav className={styles.pager} aria-label="Pages">
          {page > 1 ? (
            <Link href={href({ page: page - 1 })} className={styles.pageLink} rel="prev">
              ← Previous
            </Link>
          ) : (
            <span className={styles.pageDisabled}>← Previous</span>
          )}

          <ol className={styles.pageNumbers}>
            {pageNumbers.map((number, index) => (
              <li key={number}>
                {/* A gap where pages were skipped, so 1 … 47 48 49 … 4093 reads
                    as a range rather than as a mistake. */}
                {index > 0 && number - pageNumbers[index - 1] > 1 ? (
                  <span className={styles.gap}>…</span>
                ) : null}
                {number === page ? (
                  <span className={styles.pageCurrent} aria-current="page">{number}</span>
                ) : (
                  <Link href={href({ page: number })} className={styles.pageNumber}>
                    {number}
                  </Link>
                )}
              </li>
            ))}
          </ol>

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
        {brand.timezone.replace('_', ' ')}. {PAGE_SIZE} customers per page.
      </CountingRule>
    </main>
  )
}
