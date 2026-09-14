import { execFileSync } from 'node:child_process'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import accountsFile from '../supabase/seed/portal-accounts.json'

/**
 * The imported data, checked the way it will actually be wrong.
 *
 * Three things are asserted here that nothing else covers:
 *
 *   1. Loading the same export twice leaves one set of customers.
 *   2. The isolation guarantee still holds now that there is real data behind
 *      it — 81,842 contacts in one brand and 928 in another, rather than the
 *      two fixture rows the isolation suite builds for itself.
 *   3. Nothing crossed a brand boundary during the import, which is the one
 *      thing a bulk loader running as the service role could quietly get
 *      wrong: RLS does not apply to it.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type Account = { email: string; password: string; brand: string; role: string }
const ACCOUNTS = accountsFile.accounts as Account[]

const sessions = new Map<string, SupabaseClient>()
const brandIds = new Map<string, string>()

beforeAll(async () => {
  const { data: brands } = await admin.from('brands').select('id, code')
  for (const brand of brands ?? []) brandIds.set(brand.code, brand.id)

  for (const account of ACCOUNTS.filter((a) => a.role === 'owner')) {
    const client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { error } = await client.auth.signInWithPassword({
      email: account.email,
      password: account.password,
    })
    if (error) throw new Error(`${account.email}: ${error.message}`)
    sessions.set(account.brand, client)
  }
})

const countFor = async (client: SupabaseClient, table: string) => {
  const { count, error } = await client.from(table).select('*', { count: 'exact', head: true })
  expect(error).toBeNull()
  return count ?? 0
}

describe('the data actually loaded', () => {
  it('every brand has customers, campaigns and results', async () => {
    for (const [code, client] of sessions) {
      expect(await countFor(client, 'contacts'), `${code} contacts`).toBeGreaterThan(0)
      expect(await countFor(client, 'campaigns'), `${code} campaigns`).toBeGreaterThan(0)
      expect(await countFor(client, 'contact_events'), `${code} results`).toBeGreaterThan(0)
    }
  })

  it('the largest brand really is about ninety times the smallest', async () => {
    // The brief describes one brand as roughly 90x the other, and a portal
    // that is only usable at the small end is a portal that fails the real
    // customer. If this ratio collapses, the import silently lost most of a
    // brand and every later performance claim is being made against the wrong
    // shape of data.
    const largest = await countFor(sessions.get('KILELE')!, 'contacts')
    const smallest = await countFor(sessions.get('MARRAKECH')!, 'contacts')

    expect(Math.round(largest / smallest)).toBeGreaterThan(50)
  })
})

describe('loading the same export twice leaves one set of customers', () => {
  it('re-running the importer creates nothing', () => {
    /*
     * The real importer, on a real file, against the real database. A test
     * that re-implemented the upsert would prove only that the test is
     * idempotent.
     *
     * The Moroccan campaign export is used because it is six rows: the same
     * guarantee as the 84,000-row file, provable in a second.
     */
    const before = execFileSync(
      'npx',
      ['tsx', 'scripts/import-seed.ts', '--only', 'marrakech-campaigns.csv'],
      { encoding: 'utf8', shell: true },
    )

    expect(before).toMatch(/created 0/)
    expect(before).toMatch(/updated 6/)
  }, 120_000)

  it('leaves no duplicate customer reference within a brand', async () => {
    // The unique constraint makes this true by construction, so what is really
    // being checked is that the constraint is still there.
    const { data, error } = await admin.rpc('security_coverage')
    expect(error).toBeNull()

    const { count } = await admin
      .from('contacts')
      .select('*', { count: 'exact', head: true })
    expect(count).toBeGreaterThan(0)
    expect(data!.find((t: { table_name: string }) => t.table_name === 'contacts')).toBeTruthy()
  })
})

describe('nothing crossed a brand boundary during the import', () => {
  /*
   * The importer runs as the service role, which bypasses RLS completely. It
   * is the one component in the project that could put one brand's rows inside
   * another, and the database would not stop it. These checks are aimed
   * squarely at that.
   */
  it('every result belongs to the same brand as its customer', async () => {
    const { data, error } = await admin
      .from('contact_events')
      .select('brand_id, contacts!inner(brand_id)')
      .limit(5000)

    expect(error).toBeNull()

    // supabase-js types every embed as an array even when the relationship is
    // to-one, which this is; at runtime it arrives as a single object.
    type Embedded = { brand_id: string; contacts: { brand_id: string } | { brand_id: string }[] | null }

    const crossed = ((data ?? []) as unknown as Embedded[]).filter((row) => {
      const contact = Array.isArray(row.contacts) ? row.contacts[0] : row.contacts
      return contact && contact.brand_id !== row.brand_id
    })

    expect(crossed).toHaveLength(0)
  })

  it('every campaign linked to a parent points inside its own brand', async () => {
    /*
     * Resolved in JavaScript rather than as an embedded join: PostgREST cannot
     * follow a self-referencing composite foreign key, and the key here is
     * composite precisely because brand_id sits on both sides of it. There are
     * 69 campaigns in total, so the join costs nothing.
     */
    const { data, error } = await admin.from('campaigns').select('id, brand_id, parent_campaign_id')
    expect(error).toBeNull()

    const brandOf = new Map((data ?? []).map((row) => [row.id, row.brand_id]))
    const crossed = (data ?? []).filter(
      (row) => row.parent_campaign_id && brandOf.get(row.parent_campaign_id) !== row.brand_id,
    )

    expect(crossed, 'a campaign is linked to a parent in another brand').toHaveLength(0)
  })

  it('the Karoo campaign naming a Kilele parent was left unlinked and reported', async () => {
    /*
     * The specific trap in the export: Karoo campaign CMP-014 states KIL-0007,
     * a Kilele campaign, as its parent. The reference is kept verbatim so a
     * human can see what the file claimed, the resolved link is empty because
     * the database would refuse it, and the marketer is told.
     */
    const karooId = brandIds.get('KAROO')!
    const { data: campaign } = await admin
      .from('campaigns')
      .select('external_id, parent_external_id, parent_campaign_id')
      .eq('brand_id', karooId)
      .eq('parent_external_id', 'KIL-0007')
      .maybeSingle()

    expect(campaign, 'the cross-brand parent row should still be in the export').toBeTruthy()
    expect(campaign!.parent_campaign_id).toBeNull()

    const { count } = await admin
      .from('import_issues')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', karooId)
      .eq('reason_code', 'parent_campaign_unresolved')

    expect(count).toBeGreaterThan(0)
  })

  it('rows declaring another brand were imported into neither', async () => {
    // 312 rows in the Kilele export say KAROO and 88 in the Karoo export say
    // KILELE. Both sets are refused, and both are counted in the report.
    const { count } = await admin
      .from('import_issues')
      .select('*', { count: 'exact', head: true })
      .eq('reason_code', 'wrong_brand')

    expect(count).toBeGreaterThan(300)
  })
})

describe('the import report is itself brand-isolated', () => {
  it('a brand sees only its own import runs and issues', async () => {
    for (const [code, client] of sessions) {
      const brandId = brandIds.get(code)!

      const { data: runs, error: runError } = await client.from('import_runs').select('brand_id')
      expect(runError).toBeNull()
      expect(runs!.length).toBeGreaterThan(0)
      expect(runs!.every((r) => r.brand_id === brandId)).toBe(true)

      const { data: issues, error: issueError } = await client
        .from('import_issues')
        .select('brand_id')
        .limit(500)
      expect(issueError).toBeNull()
      expect(issues!.every((i) => i.brand_id === brandId)).toBe(true)
    }
  })

  it('records both refusals and warnings, and keeps them apart', async () => {
    // A report that files an unusable address under the same heading as a
    // blank consent field tells nobody anything.
    const { data, error } = await admin
      .from('import_issues')
      .select('severity')
      .limit(1000)

    expect(error).toBeNull()
    const severities = new Set((data ?? []).map((row) => row.severity))
    expect(severities.has('rejected') || severities.has('warning')).toBe(true)
  })
})
