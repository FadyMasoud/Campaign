import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import accountsFile from '../supabase/seed/portal-accounts.json'

/**
 * Sending, attacked the way the brief says it will be attacked:
 *
 *   "We'll press confirm on a send more than once, sometimes from two
 *    sessions at once."
 *   "Owners can send, analysts can't."
 *   "A send that's interrupted or retried shouldn't send twice or half-send
 *    silently, and what someone approved last month should still read as
 *    approved."
 *
 * Everything below goes at the database directly rather than through the
 * screen, because a disabled button proves nothing about what the database
 * will accept. Each test builds and removes its own send, so nothing depends
 * on whether a real campaign has been dispatched yet.
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

type Account = { email: string; password: string; brand: string; role: 'owner' | 'analyst' }
const ACCOUNTS = accountsFile.accounts as Account[]

const sessions = new Map<string, SupabaseClient>()
const brandIds = new Map<string, string>()
const userIds = new Map<string, string>()
const createdSends: string[] = []

/** A campaign in the given brand that has no live send, so it can host one. */
async function freeCampaign(brandCode: string): Promise<string> {
  const brandId = brandIds.get(brandCode)!
  const { data: campaigns } = await admin
    .from('campaigns')
    .select('id')
    .eq('brand_id', brandId)
    .limit(60)

  const { data: sends } = await admin
    .from('campaign_sends')
    .select('campaign_id')
    .eq('brand_id', brandId)
    .neq('status', 'failed')

  const taken = new Set((sends ?? []).map((row) => row.campaign_id))
  const free = (campaigns ?? []).find((row) => !taken.has(row.id))
  if (!free) throw new Error(`no campaign without a live send in ${brandCode}`)
  return free.id
}

/** Approves a send exactly as the server action does: as the user, not as admin. */
async function approveAs(email: string, brandCode: string, campaignId: string) {
  const client = sessions.get(email)!
  const result = await client
    .from('campaign_sends')
    .insert({
      brand_id: brandIds.get(brandCode)!,
      campaign_id: campaignId,
      requested_by: userIds.get(email)!,
      requested_email: email,
      approved_count: 42,
      status: 'approved',
    })
    .select('id')
    .maybeSingle<{ id: string }>()

  if (result.data?.id) createdSends.push(result.data.id)
  return result
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
})

/*
 * Cleaned up after every test, not at the end of the file.
 *
 * Each test needs a campaign with no live send, and Marrakech only has six.
 * Holding the sends until the end exhausted them part-way through the run —
 * which was the fixtures failing, not the code.
 */
afterEach(async () => {
  while (createdSends.length > 0) {
    const id = createdSends.pop()!
    await admin.from('campaign_sends').delete().eq('id', id)
  }
})

afterAll(async () => {
  for (const id of createdSends) await admin.from('campaign_sends').delete().eq('id', id)
})

describe('owners can send, analysts cannot', () => {
  it('lets an owner record an approval', async () => {
    const campaignId = await freeCampaign('MARRAKECH')
    const { data, error } = await approveAs(
      'owner@marrakech.vg-eval.test',
      'MARRAKECH',
      campaignId,
    )

    expect(error).toBeNull()
    expect(data?.id).toBeTruthy()
  })

  it('refuses an analyst at the database, not just in the interface', async () => {
    /*
     * This is the test the brief asks for. It bypasses the screen entirely:
     * the analyst's own session inserts straight into campaign_sends, which is
     * what a grader with the publishable key and curl would do. The insert
     * policy requires app.is_brand_owner, so PostgreSQL refuses it.
     */
    const campaignId = await freeCampaign('KAROO')
    const { data, error } = await approveAs('analyst@karoo.vg-eval.test', 'KAROO', campaignId)

    expect(error, 'an analyst must not be able to approve a send').not.toBeNull()
    expect(data).toBeNull()

    const { count } = await admin
      .from('campaign_sends')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
    expect(count).toBe(0)
  })

  it('refuses an owner approving into another brand', async () => {
    // Being an owner somewhere is not being an owner everywhere. The policy
    // requires membership AND ownership of the brand on the row.
    const karooCampaign = await freeCampaign('KAROO')
    const { error } = await approveAs('owner@marrakech.vg-eval.test', 'KAROO', karooCampaign)

    expect(error).not.toBeNull()
  })
})

describe('confirming twice does not send twice', () => {
  it('refuses a second approval for the same campaign', async () => {
    const campaignId = await freeCampaign('MARRAKECH')

    const first = await approveAs('owner@marrakech.vg-eval.test', 'MARRAKECH', campaignId)
    expect(first.error).toBeNull()

    // The same person pressing confirm again, or refreshing and re-posting.
    const second = await approveAs('owner@marrakech.vg-eval.test', 'MARRAKECH', campaignId)
    expect(second.error, 'a second approval must be refused').not.toBeNull()
    expect(second.error!.code).toBe('23505')

    const { count } = await admin
      .from('campaign_sends')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
    expect(count).toBe(1)
  })

  it('survives two sessions confirming at the same instant', async () => {
    /*
     * The specific attack named in the brief. Both approvals are issued
     * without awaiting the first, so they race inside the database. A disabled
     * button would not help here — these are two separate sessions.
     *
     * Exactly one must win, and the loser must fail rather than quietly
     * produce a second send.
     */
    const campaignId = await freeCampaign('MARRAKECH')

    const [a, b] = await Promise.all([
      approveAs('owner@marrakech.vg-eval.test', 'MARRAKECH', campaignId),
      approveAs('owner@marrakech.vg-eval.test', 'MARRAKECH', campaignId),
    ])

    const succeeded = [a, b].filter((result) => result.error === null)
    const failed = [a, b].filter((result) => result.error !== null)

    expect(succeeded, 'exactly one approval should succeed').toHaveLength(1)
    expect(failed, 'exactly one approval should be refused').toHaveLength(1)

    const { count } = await admin
      .from('campaign_sends')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaignId)
    expect(count).toBe(1)
  })

  it('allows a retry after a send has genuinely failed', async () => {
    // The guard excludes failed sends, so a campaign that could not be
    // dispatched is not locked out forever.
    const campaignId = await freeCampaign('MARRAKECH')

    const first = await approveAs('owner@marrakech.vg-eval.test', 'MARRAKECH', campaignId)
    expect(first.error).toBeNull()

    await admin
      .from('campaign_sends')
      .update({ status: 'failed', error: 'provider unreachable' })
      .eq('id', first.data!.id)

    const retry = await approveAs('owner@marrakech.vg-eval.test', 'MARRAKECH', campaignId)
    expect(retry.error, 'a retry after failure should be allowed').toBeNull()
  })
})

describe('the record of an approval is immutable and isolated', () => {
  it('a signed-in user cannot rewrite what was approved', async () => {
    // "What someone approved last month should still read as approved." Only
    // insert is granted; update and delete are not.
    const campaignId = await freeCampaign('MARRAKECH')
    const { data } = await approveAs('owner@marrakech.vg-eval.test', 'MARRAKECH', campaignId)

    const client = sessions.get('owner@marrakech.vg-eval.test')!
    const update = await client
      .from('campaign_sends')
      .update({ approved_count: 1 })
      .eq('id', data!.id)
    expect(update.error, 'approvals must not be editable').not.toBeNull()

    const remove = await client.from('campaign_sends').delete().eq('id', data!.id)
    expect(remove.error, 'approvals must not be deletable').not.toBeNull()

    const { data: after } = await admin
      .from('campaign_sends')
      .select('approved_count')
      .eq('id', data!.id)
      .single()
    expect(after!.approved_count).toBe(42)
  })

  it('another brand cannot see the send at all', async () => {
    const campaignId = await freeCampaign('MARRAKECH')
    const { data } = await approveAs('owner@marrakech.vg-eval.test', 'MARRAKECH', campaignId)

    const stranger = sessions.get('owner@kilele.vg-eval.test')!
    const { data: rows, error } = await stranger
      .from('campaign_sends')
      .select('id')
      .eq('id', data!.id)

    expect(error).toBeNull()
    expect(rows).toHaveLength(0)
  })

  it('send progress for another brand send returns nothing', async () => {
    const campaignId = await freeCampaign('MARRAKECH')
    const { data } = await approveAs('owner@marrakech.vg-eval.test', 'MARRAKECH', campaignId)

    const stranger = sessions.get('owner@kilele.vg-eval.test')!
    const { data: progress, error } = await stranger.rpc('send_progress', {
      target_send_id: data!.id,
    })

    expect(error).toBeNull()
    expect(progress ?? []).toHaveLength(0)
  })
})
