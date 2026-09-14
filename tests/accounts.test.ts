import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import accountsFile from '../supabase/seed/portal-accounts.json'

/**
 * The six logins, exercised the way a grader will: sign in as each one
 * directly against Supabase, with the publishable key, and check what comes
 * back.
 *
 * This is deliberately not a test of the web app. The brief says the graders
 * will "sign in as each user directly against Supabase, not just through the
 * app", so filtering done in a React component proves nothing. Everything
 * asserted here is enforced by the database.
 *
 * The credentials are read from the same JSON the seeding script uses, so a
 * password changed in one place cannot silently diverge from the other.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error('Account tests need NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY.')
}

type Account = {
  email: string
  password: string
  brand: string
  role: 'owner' | 'analyst'
}

const ACCOUNTS: Account[] = accountsFile.accounts as Account[]

/** One signed-in client per account, built once and reused. */
const sessions = new Map<string, SupabaseClient>()

beforeAll(async () => {
  for (const account of ACCOUNTS) {
    const client = createClient(SUPABASE_URL!, ANON_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { error } = await client.auth.signInWithPassword({
      email: account.email,
      password: account.password,
    })

    if (error) {
      throw new Error(
        `${account.email} could not sign in: ${error.message}. ` +
          `Run "npm run seed:users" to create the six accounts.`,
      )
    }

    sessions.set(account.email, client)
  }
})

describe('all six logins work', () => {
  it('has exactly six accounts defined', () => {
    expect(ACCOUNTS).toHaveLength(6)
  })

  it('covers three brands with an owner and an analyst each', () => {
    const byBrand = new Map<string, string[]>()
    for (const account of ACCOUNTS) {
      byBrand.set(account.brand, [...(byBrand.get(account.brand) ?? []), account.role])
    }

    expect([...byBrand.keys()].sort()).toEqual(['KAROO', 'KILELE', 'MARRAKECH'])
    for (const roles of byBrand.values()) {
      expect(roles.sort()).toEqual(['analyst', 'owner'])
    }
  })
})

describe.each(ACCOUNTS)('$email', (account) => {
  it('lands in exactly one brand, and it is the right one', async () => {
    const client = sessions.get(account.email)!

    // No .eq('code', …) filter. Asking for every brand and receiving exactly
    // one is the isolation guarantee answering — this is the query that would
    // return three rows if the policy were dropped.
    const { data, error } = await client.from('brands').select('code, name, timezone')

    expect(error).toBeNull()
    expect(data).toHaveLength(1)
    expect(data![0].code).toBe(account.brand)
  })

  it('holds the role it was given', async () => {
    const client = sessions.get(account.email)!
    const {
      data: { user },
    } = await client.auth.getUser()

    /*
     * The .eq('user_id') is required, not tidiness. The policy on
     * brand_members shows you every member of a brand you belong to, so this
     * query without the filter returns two rows — the account and its
     * colleague — and .single() fails. That is the behaviour asserted
     * directly in the next test, and it is why src/lib/auth/dal.ts carries
     * the same filter.
     */
    const { data, error } = await client
      .from('brand_members')
      .select('role')
      .eq('user_id', user!.id)
      .single()

    expect(error).toBeNull()
    expect(data!.role).toBe(account.role)
  })

  it('sees both colleagues in its own brand and nobody from another', async () => {
    const client = sessions.get(account.email)!

    const { data, error } = await client.from('brand_members').select('user_id, role')

    expect(error).toBeNull()
    // Its own brand has exactly two members: one owner, one analyst. The other
    // four accounts across the other two brands are invisible.
    expect(data).toHaveLength(2)
    expect(data!.map((row) => row.role).sort()).toEqual(['analyst', 'owner'])
  })

  it('sees no other brand rows on any data table', async () => {
    const client = sessions.get(account.email)!

    const { data: brand } = await client.from('brands').select('id').single()

    for (const table of ['contacts', 'campaigns', 'contact_events'] as const) {
      const { data, error } = await client.from(table).select('brand_id')
      expect(error, `${table} should be readable`).toBeNull()
      expect(
        data!.every((row) => row.brand_id === brand!.id),
        `${table} leaked a row from another brand`,
      ).toBe(true)
    }
  })
})

describe('the two accounts of one brand agree, and differ from another brand', () => {
  it('the Kilele owner and the Kilele analyst see the same brand', async () => {
    const owner = sessions.get('owner@kilele.vg-eval.test')!
    const analyst = sessions.get('analyst@kilele.vg-eval.test')!

    const { data: ownerBrand } = await owner.from('brands').select('id').single()
    const { data: analystBrand } = await analyst.from('brands').select('id').single()

    expect(ownerBrand!.id).toBe(analystBrand!.id)
  })

  it('the three brands are genuinely different rows', async () => {
    const ids = await Promise.all(
      ['owner@kilele.vg-eval.test', 'owner@karoo.vg-eval.test', 'owner@marrakech.vg-eval.test'].map(
        async (email) => {
          const { data } = await sessions.get(email)!.from('brands').select('id').single()
          return data!.id as string
        },
      ),
    )

    expect(new Set(ids).size).toBe(3)
  })
})

describe('an analyst cannot act, only read', () => {
  /*
   * Phase 5 adds the send table and the owner-gated write policy. Until then
   * the meaningful assertion is that no data table accepts a write from
   * anybody, analyst or owner — writes run server-side under the service role.
   * When sending arrives, this is where "analysts cannot send" gets its test.
   */
  it('no signed-in account can write to a data table, whatever its role', async () => {
    for (const account of ACCOUNTS) {
      const client = sessions.get(account.email)!
      const { data: brand } = await client.from('brands').select('id').single()

      const { error } = await client.from('contacts').insert({
        brand_id: brand!.id,
        external_id: `ROLE-PROBE-${Date.now()}`,
        email: 'probe@vg-eval.test',
        status: 'active',
        consent_marketing: true,
      })

      expect(error, `${account.email} (${account.role}) was allowed to write`).not.toBeNull()
    }
  })
})
