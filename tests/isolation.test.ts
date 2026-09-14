import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * THE TEST THAT MUST FAIL IF BRAND ISOLATION IS REMOVED.
 *
 * It does not test the web app. It connects to the hosted database the same
 * way a grader would — with the publishable key and a real signed-in session —
 * and tries to read another brand's rows. If someone drops the policies, or
 * loosens the predicate in
 * supabase/migrations/20260913160000_brands_and_isolation.sql, these
 * assertions go red. Nothing in the user interface can make them pass again.
 *
 * The fixtures are built and torn down here rather than relying on seeded
 * data, so the test proves the *mechanism* works, not that today's rows happen
 * to be arranged correctly.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
  throw new Error(
    'Isolation tests need NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY ' +
      'and SUPABASE_SERVICE_ROLE_KEY in .env.local.',
  )
}

/** Unique per run, so a crashed run never collides with the next one. */
const RUN = Math.random().toString(36).slice(2, 10)
const PASSWORD = `test-${RUN}-Aa1!`

/** Set-up and assertions about the schema itself run with RLS bypassed. */
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** A client that behaves exactly like the browser: publishable key, no session. */
function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

async function signIn(email: string): Promise<SupabaseClient> {
  const client = anonClient()
  const { error } = await client.auth.signInWithPassword({ email, password: PASSWORD })
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`)
  return client
}

type Fixture = {
  brandId: string
  contactId: string
  userId: string
  email: string
}

const created: { userIds: string[]; contactIds: string[] } = { userIds: [], contactIds: [] }

/** Attaches a fresh user to an existing brand and gives that brand a contact. */
async function makeFixture(brandCode: string, role: 'owner' | 'analyst'): Promise<Fixture> {
  const { data: brand, error: brandError } = await admin
    .from('brands')
    .select('id')
    .eq('code', brandCode)
    .single()
  if (brandError) throw new Error(`brand ${brandCode} missing — run the migration: ${brandError.message}`)

  const email = `isolation.${brandCode.toLowerCase()}.${RUN}@vg-eval.test`
  const { data: user, error: userError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (userError) throw new Error(`could not create ${email}: ${userError.message}`)
  created.userIds.push(user.user.id)

  const { error: memberError } = await admin
    .from('brand_members')
    .insert({ user_id: user.user.id, brand_id: brand.id, role })
  if (memberError) throw new Error(`could not add membership: ${memberError.message}`)

  const { data: contact, error: contactError } = await admin
    .from('contacts')
    .insert({
      brand_id: brand.id,
      external_id: `ISO-${RUN}`,
      full_name: `Isolation Fixture ${brandCode}`,
      email: `fixture.${brandCode.toLowerCase()}.${RUN}@vg-eval.test`,
      status: 'active',
      consent_marketing: true,
      source_file: 'tests/isolation.test.ts',
    })
    .select('id')
    .single()
  if (contactError) throw new Error(`could not create contact: ${contactError.message}`)
  created.contactIds.push(contact.id)

  return { brandId: brand.id, contactId: contact.id, userId: user.user.id, email }
}

let kilele: Fixture
let karoo: Fixture
let outsider: { email: string; userId: string }
let asKilele: SupabaseClient
let asKaroo: SupabaseClient
let asOutsider: SupabaseClient

beforeAll(async () => {
  kilele = await makeFixture('KILELE', 'owner')
  karoo = await makeFixture('KAROO', 'analyst')

  // Someone with a valid login and no brand at all.
  const email = `isolation.outsider.${RUN}@vg-eval.test`
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  })
  if (error) throw new Error(`could not create outsider: ${error.message}`)
  created.userIds.push(data.user.id)
  outsider = { email, userId: data.user.id }

  asKilele = await signIn(kilele.email)
  asKaroo = await signIn(karoo.email)
  asOutsider = await signIn(outsider.email)
})

afterAll(async () => {
  for (const id of created.contactIds) await admin.from('contacts').delete().eq('id', id)
  for (const id of created.userIds) await admin.auth.admin.deleteUser(id)
})

describe('a signed-in user reads only their own brand', () => {
  it('sees their own contact', async () => {
    const { data, error } = await asKilele.from('contacts').select('id').eq('id', kilele.contactId)
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
  })

  it('cannot read another brand contact, even asked for by id', async () => {
    // The direct attack: the id is known and named explicitly. RLS filters the
    // row out rather than raising, so "denied" looks like "does not exist".
    const { data, error } = await asKilele.from('contacts').select('id').eq('id', karoo.contactId)
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('does not see another brand contact in an unfiltered listing', async () => {
    const { data, error } = await asKilele.from('contacts').select('id, brand_id')
    expect(error).toBeNull()
    expect(data!.every((row) => row.brand_id === kilele.brandId)).toBe(true)
    expect(data!.map((row) => row.id)).not.toContain(karoo.contactId)
  })

  it('sees only its own brand in the brands table', async () => {
    const { data, error } = await asKilele.from('brands').select('id, code')
    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].id).toBe(kilele.brandId)
  })

  it('is symmetric — the other brand cannot see the first either', async () => {
    const { data, error } = await asKaroo.from('contacts').select('id').eq('id', kilele.contactId)
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('cannot count another brand rows', async () => {
    // count with head:true returns no rows, so only the number leaks. It must
    // be zero: an isolation hole that leaked sizes would still be a hole.
    const { count, error } = await asKilele
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', karoo.brandId)
    expect(error).toBeNull()
    expect(count).toBe(0)
  })
})

describe('reading is all a signed-in user may do', () => {
  it('cannot insert a row into another brand', async () => {
    const { error } = await asKilele.from('contacts').insert({
      brand_id: karoo.brandId,
      external_id: `ISO-ATTACK-${RUN}`,
      email: `attack.${RUN}@vg-eval.test`,
      status: 'active',
      consent_marketing: true,
    })
    expect(error).not.toBeNull()
  })

  it('cannot insert a row even into its own brand', async () => {
    // Writes belong to server-side code running under the service role, which
    // filters by brand explicitly. No user-facing write path exists yet.
    const { error } = await asKilele.from('contacts').insert({
      brand_id: kilele.brandId,
      external_id: `ISO-OWN-${RUN}`,
      email: `own.${RUN}@vg-eval.test`,
      status: 'active',
      consent_marketing: true,
    })
    expect(error).not.toBeNull()
  })

  it('cannot update another brand row', async () => {
    const { error } = await asKilele
      .from('contacts')
      .update({ full_name: 'overwritten' })
      .eq('id', karoo.contactId)
    expect(error).not.toBeNull()

    // And the row is untouched, whatever the API replied.
    const { data } = await admin.from('contacts').select('full_name').eq('id', karoo.contactId).single()
    expect(data!.full_name).toBe('Isolation Fixture KAROO')
  })

  it('cannot delete another brand row', async () => {
    const { error } = await asKilele.from('contacts').delete().eq('id', karoo.contactId)
    expect(error).not.toBeNull()

    const { count } = await admin
      .from('contacts')
      .select('*', { count: 'exact', head: true })
      .eq('id', karoo.contactId)
    expect(count).toBe(1)
  })
})

describe('anyone without a brand gets nothing', () => {
  it('a signed-in user belonging to no brand sees no contacts', async () => {
    const { data, error } = await asOutsider.from('contacts').select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('a signed-in user belonging to no brand sees no brands', async () => {
    const { data, error } = await asOutsider.from('brands').select('id')
    expect(error).toBeNull()
    expect(data).toHaveLength(0)
  })

  it('the publishable key alone, with no session, reads nothing', async () => {
    // This is the key that ships in the JavaScript bundle. Anyone can read it
    // out of the browser. On its own it must be worth nothing.
    const stranger = anonClient()
    const { data, error } = await stranger.from('contacts').select('id')
    expect(data ?? []).toHaveLength(0)
    if (error) expect(error.message).toMatch(/permission denied|not find|schema cache/i)
  })
})

describe('the guarantee covers tables that do not exist yet', () => {
  /**
   * Requirement 2 says "every route into the data, including ones added
   * later". A list of table names written out by hand here would not survive
   * the phases still to come, so this asks the database what tables exist and
   * holds each of them to the same standard. A table added in a later phase
   * without RLS fails this test without anyone editing it.
   */
  it('every table in public has RLS on, at least one policy, and no anon access', async () => {
    const { data, error } = await admin.rpc('security_coverage')
    expect(error).toBeNull()
    expect(data!.length).toBeGreaterThan(0)

    const failures = data!.filter(
      (t: { rls_enabled: boolean; policy_count: number; anon_can_select: boolean }) =>
        !t.rls_enabled || t.policy_count === 0 || t.anon_can_select,
    )
    expect(failures, `tables without isolation: ${JSON.stringify(failures, null, 2)}`).toHaveLength(0)
  })

  it('only the two owner-gated tables are writable by a signed-in user', async () => {
    const { data, error } = await admin.rpc('security_coverage')
    expect(error).toBeNull()

    /*
     * Two tables in the project accept a write from a signed-in user, and both
     * are things a PERSON does rather than things a script does on their
     * behalf: approving a send, and publishing a campaign's results. Both
     * insert policies require app.is_brand_owner, asserted directly in
     * tests/sending.test.ts and tests/shared-report.test.ts.
     *
     * Neither grants update or delete, which is what keeps an approval and a
     * published report immutable.
     *
     * This list is deliberately hard to extend by accident. Anything else
     * becoming writable turns this red, which is the point — it caught
     * campaign_sends when phase 5 added it and shared_reports when phase 7
     * did.
     */
    const ALLOWED_WRITABLE = ['campaign_sends', 'shared_reports']
    const writable = data!
      .filter((t: { authenticated_can_write: boolean }) => t.authenticated_can_write)
      .map((t: { table_name: string }) => t.table_name)
      .filter((name: string) => !ALLOWED_WRITABLE.includes(name))

    expect(writable, `unexpectedly writable: ${writable.join(', ')}`).toHaveLength(0)
  })
})
