import { randomBytes } from 'node:crypto'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import accountsFile from '../supabase/seed/portal-accounts.json'

/**
 * The shared link, attacked the way the brief says it will be:
 *
 *   "We'll come at your shared link the way a stranger would."
 *   "It shows one campaign's results and nothing else, and nothing a stranger
 *    could reach by guessing the address or getting past the password."
 *
 * Everything here uses the PUBLISHABLE key with no session — the position a
 * stranger is actually in. The page itself reads under the service role, which
 * is not reachable from a browser, so what is tested here is what the outside
 * world can actually touch.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Exactly what a stranger has: the publishable key, no session. */
const stranger = createClient(SUPABASE_URL, ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type Account = { email: string; password: string; brand: string; role: 'owner' | 'analyst' }
const ACCOUNTS = accountsFile.accounts as Account[]

const sessions = new Map<string, SupabaseClient>()
const brandIds = new Map<string, string>()
const userIds = new Map<string, string>()
const createdReports: string[] = []

const PASSWORD = 'correct-horse-battery'
let token: string
let campaignId: string

async function publishAs(email: string, brandCode: string, campaign: string, plain: string) {
  const client = sessions.get(email)!
  const { data: hash } = await client.rpc('hash_report_password', { plain })

  const reportToken = randomBytes(32).toString('base64url')
  const result = await client
    .from('shared_reports')
    .insert({
      brand_id: brandIds.get(brandCode)!,
      campaign_id: campaign,
      token: reportToken,
      password_hash: hash as string,
      created_by: userIds.get(email)!,
      created_email: email,
    })
    .select('id')
    .maybeSingle<{ id: string }>()

  if (result.data?.id) createdReports.push(result.data.id)
  return { ...result, token: reportToken }
}

beforeAll(async () => {
  const { data: brands } = await admin.from('brands').select('id, code')
  for (const brand of brands ?? []) brandIds.set(brand.code, brand.id)

  for (const account of ACCOUNTS) {
    const client = createClient(SUPABASE_URL, ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const { data, error } = await client.auth.signInWithPassword({
      email: account.email,
      password: account.password,
    })
    if (error) throw new Error(`${account.email}: ${error.message}`)
    sessions.set(account.email, client)
    userIds.set(account.email, data.user!.id)
  }

  const { data: campaign } = await admin
    .from('campaigns')
    .select('id')
    .eq('brand_id', brandIds.get('MARRAKECH')!)
    .limit(1)
    .single()
  campaignId = campaign!.id

  const published = await publishAs(
    'owner@marrakech.vg-eval.test',
    'MARRAKECH',
    campaignId,
    PASSWORD,
  )
  if (published.error) throw new Error(`could not publish: ${published.error.message}`)
  token = published.token
})

afterAll(async () => {
  for (const id of createdReports) await admin.from('shared_reports').delete().eq('id', id)
})

describe('only an owner can publish results', () => {
  it('lets an owner publish', async () => {
    const { error } = await publishAs(
      'owner@marrakech.vg-eval.test',
      'MARRAKECH',
      campaignId,
      PASSWORD,
    )
    expect(error).toBeNull()
  })

  it('refuses an analyst at the database', async () => {
    const { data: karooCampaign } = await admin
      .from('campaigns')
      .select('id')
      .eq('brand_id', brandIds.get('KAROO')!)
      .limit(1)
      .single()

    const { error } = await publishAs(
      'analyst@karoo.vg-eval.test',
      'KAROO',
      karooCampaign!.id,
      PASSWORD,
    )
    expect(error, 'an analyst must not be able to publish').not.toBeNull()
  })

  it('refuses an owner publishing another brand campaign', async () => {
    const { error } = await publishAs(
      'owner@kilele.vg-eval.test',
      'MARRAKECH',
      campaignId,
      PASSWORD,
    )
    expect(error).not.toBeNull()
  })
})

describe('a stranger with the publishable key', () => {
  it('cannot read the shared_reports table at all', async () => {
    // If this were readable, every token and every campaign link would be
    // listable — the password would be the only thing left, and the URL would
    // not need guessing.
    const { data, error } = await stranger.from('shared_reports').select('token')

    expect(data ?? []).toHaveLength(0)
    if (error) expect(error.message).toMatch(/permission denied|not find|schema cache/i)
  })

  it('cannot read the campaign the report is about', async () => {
    const { data } = await stranger.from('campaigns').select('id').eq('id', campaignId)
    expect(data ?? []).toHaveLength(0)
  })

  it('cannot reach customers, events or sends', async () => {
    for (const table of ['contacts', 'contact_events', 'campaign_sends', 'send_recipients']) {
      const { data } = await stranger.from(table).select('*').limit(1)
      expect(data ?? [], `${table} must be unreachable`).toHaveLength(0)
    }
  })
})

describe('guessing the address gets nowhere', () => {
  it('answers a made-up token exactly as a wrong password', async () => {
    /*
     * The two must be indistinguishable. If an unknown token answered
     * differently from a known one, the endpoint would confirm which tokens
     * exist — and a stranger could enumerate reports without ever knowing a
     * password.
     */
    const unknown = await stranger.rpc('unlock_shared_report', {
      report_token: randomBytes(32).toString('base64url'),
      attempt: PASSWORD,
    })
    const wrongPassword = await stranger.rpc('unlock_shared_report', {
      report_token: token,
      attempt: 'not-the-password',
    })

    expect(unknown.data).toBe('denied')
    expect(wrongPassword.data).toBe('denied')
    expect(unknown.data).toBe(wrongPassword.data)
  })

  it('accepts the right password for the right token', async () => {
    const { data, error } = await stranger.rpc('unlock_shared_report', {
      report_token: token,
      attempt: PASSWORD,
    })

    expect(error).toBeNull()
    expect(data).toBe('ok')
  })

  it('never returns the report itself, only whether the door opened', async () => {
    // The function is anon-callable, so it must not be usable as a data
    // endpoint. It answers with an outcome and nothing else; the figures are
    // read separately, under the service role.
    const { data } = await stranger.rpc('unlock_shared_report', {
      report_token: token,
      attempt: PASSWORD,
    })

    expect(typeof data).toBe('string')
    expect(['ok', 'denied', 'locked']).toContain(data)
  })

  it('locks the report after repeated wrong passwords', async () => {
    const victim = await publishAs(
      'owner@marrakech.vg-eval.test',
      'MARRAKECH',
      campaignId,
      PASSWORD,
    )

    let outcome: string | null = null
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const { data } = await stranger.rpc('unlock_shared_report', {
        report_token: victim.token,
        attempt: `guess-${attempt}`,
      })
      outcome = data as string
    }

    expect(outcome, 'brute force must become pointless').toBe('locked')

    // And the correct password is refused while locked, so the lock is not
    // merely cosmetic.
    const { data: whileLocked } = await stranger.rpc('unlock_shared_report', {
      report_token: victim.token,
      attempt: PASSWORD,
    })
    expect(whileLocked).toBe('locked')
  })
})

describe('a withdrawn link stops working', () => {
  it('answers a revoked token as if it never existed', async () => {
    const doomed = await publishAs(
      'owner@marrakech.vg-eval.test',
      'MARRAKECH',
      campaignId,
      PASSWORD,
    )

    const before = await stranger.rpc('unlock_shared_report', {
      report_token: doomed.token,
      attempt: PASSWORD,
    })
    expect(before.data).toBe('ok')

    await admin
      .from('shared_reports')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', doomed.data!.id)

    const after = await stranger.rpc('unlock_shared_report', {
      report_token: doomed.token,
      attempt: PASSWORD,
    })
    expect(after.data, 'a withdrawn link is as good as one that never existed').toBe('denied')
  })
})

describe('the password is never stored in a readable form', () => {
  it('stores a bcrypt hash, not the password', async () => {
    const { data } = await admin
      .from('shared_reports')
      .select('password_hash')
      .eq('token', token)
      .single()

    const hash = (data as { password_hash: string }).password_hash
    expect(hash).not.toContain(PASSWORD)
    // bcrypt, work factor 12.
    expect(hash).toMatch(/^\$2[aby]\$12\$/)
  })
})

describe('publishing is isolated like everything else', () => {
  it('another brand cannot see the report row', async () => {
    const kilele = sessions.get('owner@kilele.vg-eval.test')!
    const { data } = await kilele.from('shared_reports').select('id').eq('token', token)
    expect(data ?? []).toHaveLength(0)
  })

  it('the publishing brand can see its own', async () => {
    const marrakech = sessions.get('owner@marrakech.vg-eval.test')!
    const { data } = await marrakech.from('shared_reports').select('id').eq('token', token)
    expect(data ?? []).toHaveLength(1)
  })
})
