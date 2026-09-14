import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { beforeAll, describe, expect, it } from 'vitest'
import accountsFile from '../supabase/seed/portal-accounts.json'

/**
 * The numbers, and the guarantees around them.
 *
 * Five things are checked here, each of which would be invisible in a screen
 * that merely rendered without error:
 *
 *   1. The provider's figures and the event log's figures disagree, and the
 *      portal reports both rather than quietly reconciling them.
 *   2. A campaign with no event log is distinguishable from one where nobody
 *      engaged. Zero and "we do not know" are different answers.
 *   3. Analytics obey brand isolation — including the aggregate functions,
 *      which is where a SECURITY DEFINER slip would open a hole straight
 *      through the whole project.
 *   4. Every event is attributed to the right campaign and the right brand,
 *      and the contactability buckets account for every single contact.
 *   5. The big brand is not dramatically slower than the small one.
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

type Contactability = {
  brand_id: string
  total: number
  removed: number
  no_consent: number
  status_unsubscribed: number
  status_bounced: number
  suppressed: number
  opted_out_in_log: number
  bounced_in_log: number
  contactable: number
  future_dated_signups: number
  latest_signup_at: string | null
}

type Performance = {
  campaign_id: string
  brand_id: string
  external_id: string
  reported_sent: number | null
  reported_opens: number | null
  reported_delivered: number | null
  log_opens: number
  log_clicks: number
  log_total: number
  has_events: boolean
}

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

const perf = async (client: SupabaseClient): Promise<Performance[]> => {
  const { data, error } = await client.rpc('campaign_performance')
  expect(error).toBeNull()
  return (data ?? []) as Performance[]
}

const contactability = async (client: SupabaseClient): Promise<Contactability> => {
  const { data, error } = await client.rpc('contactability_breakdown')
  expect(error).toBeNull()
  return (data as Contactability[])[0]
}

// ---------------------------------------------------------------------------

describe('the provider and the event log disagree, and both are reported', () => {
  it('keeps the two counts separate for the same campaign', async () => {
    const rows = await perf(sessions.get('KAROO')!)
    const campaign = rows.find((row) => row.external_id === 'KAR-0001')!

    expect(campaign).toBeTruthy()
    // Provider reports 2,732 opens; the log holds 704. If these were ever
    // reconciled into one figure, this is the test that would notice.
    expect(campaign.reported_opens).toBeGreaterThan(campaign.log_opens)
    expect(campaign.log_opens).toBeGreaterThan(0)
  })

  it('at least one campaign disagrees, so the distinction is not theoretical', async () => {
    const disagreeing: string[] = []

    for (const [, client] of sessions) {
      for (const row of await perf(client)) {
        if (row.has_events && row.reported_opens !== null && row.reported_opens !== row.log_opens) {
          disagreeing.push(row.external_id)
        }
      }
    }

    expect(disagreeing.length).toBeGreaterThan(0)
  })

  it('does not "correct" a provider figure that looks impossible', async () => {
    // KIL-0016 reports 12,679 opens against 10,640 sent. That is not an error
    // — one recipient opening twice is two opens — and the portal stores what
    // the provider said rather than clamping it to something tidier.
    const rows = await perf(sessions.get('KILELE')!)
    const campaign = rows.find((row) => row.external_id === 'KIL-0016')!

    expect(campaign.reported_opens).toBeGreaterThan(campaign.reported_sent!)
  })

  it('never reports more people than events', async () => {
    // A person cannot open a campaign fewer times than once, so distinct
    // people can never exceed total opens. If it ever did, the two counts
    // would have been taken from different populations.
    const client = sessions.get('KILELE')!
    const rows = (await perf(client)).filter((row) => row.has_events).slice(0, 5)

    for (const row of rows) {
      const { data, error } = await client.rpc('campaign_engagement_detail', {
        target_campaign_id: row.campaign_id,
      })
      expect(error).toBeNull()
      const detail = (data as Array<{ people_opened: number }>)[0]
      expect(detail.people_opened).toBeLessThanOrEqual(row.log_opens)
    }
  })
})

describe('a campaign with no event log is not a campaign with zero engagement', () => {
  it('flags campaigns that have no events at all', async () => {
    const rows = await perf(sessions.get('KAROO')!)
    const cmp014 = rows.find((row) => row.external_id === 'CMP-014')!

    expect(cmp014).toBeTruthy()
    expect(cmp014.has_events).toBe(false)
    expect(cmp014.log_total).toBe(0)
    // The provider still claims a substantial send, which is exactly why the
    // zeros must not be presented as measured engagement.
    expect(cmp014.reported_sent).toBeGreaterThan(0)
    expect(cmp014.reported_opens).toBeGreaterThan(0)
  })

  it('returns zeros, not nulls, when asked for its engagement detail', async () => {
    const client = sessions.get('KAROO')!
    const rows = await perf(client)
    const cmp014 = rows.find((row) => row.external_id === 'CMP-014')!

    const { data, error } = await client.rpc('campaign_engagement_detail', {
      target_campaign_id: cmp014.campaign_id,
    })
    expect(error).toBeNull()

    const detail = (data as Array<{ people_opened: number; first_event_at: string | null }>)[0]
    expect(detail.people_opened).toBe(0)
    expect(detail.first_event_at).toBeNull()
  })

  it('still has campaigns that do hold events, so the flag discriminates', async () => {
    const rows = await perf(sessions.get('KAROO')!)
    expect(rows.some((row) => row.has_events)).toBe(true)
    expect(rows.some((row) => !row.has_events)).toBe(true)
  })
})

describe('analytics obey brand isolation', () => {
  it('contactability returns one row, for the caller brand only', async () => {
    for (const [code, client] of sessions) {
      const { data, error } = await client.rpc('contactability_breakdown')
      expect(error).toBeNull()
      const rows = data as Contactability[]
      expect(rows).toHaveLength(1)
      expect(rows[0].brand_id).toBe(brandIds.get(code))
    }
  })

  it('campaign performance returns only the caller brand campaigns', async () => {
    for (const [code, client] of sessions) {
      const rows = await perf(client)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((row) => row.brand_id === brandIds.get(code))).toBe(true)
    }
  })

  it('signups per day returns only the caller brand', async () => {
    for (const [code, client] of sessions) {
      const { data, error } = await client.rpc('signups_per_day', { window_days: 30 })
      expect(error).toBeNull()
      const rows = (data ?? []) as Array<{ brand_id: string }>
      expect(rows.every((row) => row.brand_id === brandIds.get(code))).toBe(true)
      // 30 days, zero-filled, for exactly one brand.
      expect(rows).toHaveLength(30)
    }
  })

  it('asking for another brand campaign detail by id returns nothing', async () => {
    /*
     * The direct attack on the aggregate functions. These are SECURITY
     * INVOKER, so the policy on contact_events applies to the caller and a
     * foreign campaign id matches no rows. Had any of them been written
     * SECURITY DEFINER — as the phase 1 predicate deliberately is — this call
     * would hand Marrakech a Kilele campaign's engagement.
     */
    const kilele = await perf(sessions.get('KILELE')!)
    const foreign = kilele.find((row) => row.has_events)!

    const { data, error } = await sessions
      .get('MARRAKECH')!
      .rpc('campaign_engagement_detail', { target_campaign_id: foreign.campaign_id })

    expect(error).toBeNull()
    const detail = (data as Array<{ people_engaged: number }>)[0]
    expect(detail.people_engaged).toBe(0)
  })

  it('the aggregate totals match what the brand can actually read', async () => {
    for (const [, client] of sessions) {
      const breakdown = await contactability(client)
      const { count } = await client.from('contacts').select('*', { count: 'exact', head: true })
      expect(breakdown.total).toBe(count)
    }
  })
})

describe('results are attributed to the right campaign and the right brand', () => {
  it('the contactability buckets account for every contact exactly once', async () => {
    for (const [code, client] of sessions) {
      const b = await contactability(client)
      const sum =
        b.removed +
        b.no_consent +
        b.status_unsubscribed +
        b.status_bounced +
        b.suppressed +
        b.opted_out_in_log +
        b.bounced_in_log +
        b.contactable

      expect(sum, `${code} buckets must sum to the total`).toBe(b.total)
    }
  })

  it('per-campaign event counts plus unattributed events equal the brand total', async () => {
    for (const [code, client] of sessions) {
      const rows = await perf(client)
      const attributed = rows.reduce((sum, row) => sum + row.log_total, 0)

      const { count: total } = await client
        .from('contact_events')
        .select('*', { count: 'exact', head: true })
      const { count: orphaned } = await client
        .from('contact_events')
        .select('*', { count: 'exact', head: true })
        .is('campaign_id', null)

      // Nothing is double-counted and nothing is lost: every event either
      // belongs to one of this brand's campaigns or to none at all.
      expect(attributed + (orphaned ?? 0), `${code} attribution`).toBe(total)
    }
  })

  it('Marrakech keeps the 633 results whose campaign is missing', async () => {
    // Dropping these would leave the portal believing people were contactable
    // who had asked not to be, so they are kept without a campaign.
    const { count } = await sessions
      .get('MARRAKECH')!
      .from('contact_events')
      .select('*', { count: 'exact', head: true })
      .is('campaign_id', null)

    expect(count).toBe(633)
  })

  it('the contactable figure matches a direct count using the same rule', async () => {
    for (const [code, client] of sessions) {
      const b = await contactability(client)

      const { count } = await client
        .from('contacts')
        .select('*', { count: 'exact', head: true })
        .is('deleted_at', null)
        .eq('consent_marketing', true)
        .not('status', 'in', '("unsubscribed","bounced")')
        .is('opted_out_at', null)
        .is('bounced_at', null)
        .or(`suppressed_until.is.null,suppressed_until.lte.${new Date().toISOString()}`)

      expect(count, `${code} contactable`).toBe(b.contactable)
    }
  })

  it('every future-dated signup is counted as a customer but left out of the trend', async () => {
    const kilele = sessions.get('KILELE')!
    const b = await contactability(kilele)

    // 88 Kilele contacts carry signup dates up to June 2027.
    expect(b.future_dated_signups).toBeGreaterThan(0)

    const { data } = await kilele.rpc('signups_per_day', { window_days: 30 })
    const rows = (data ?? []) as Array<{ day: string; signups: number }>
    const today = new Date().toISOString().slice(0, 10)

    // No bucket may sit past today, which is what excluding them guarantees.
    expect(rows.every((row) => row.day <= today)).toBe(true)
  })
})

describe('the big brand is not dramatically slower than the small one', () => {
  /*
   * Requirement 5 as a test. The first version of the contactability query
   * joined 95,176 contacts against 371,249 events on every dashboard load and
   * took 4.3 seconds; this is the assertion that would have caught it.
   *
   * The budgets are wall-clock against a hosted database across the network,
   * so they are deliberately loose. They are not there to measure the
   * database — they are there to fail loudly if the shape of a query goes
   * back to being quadratic.
   */
  // PromiseLike, not Promise: a Supabase query builder is a thenable that only
  // becomes a Promise when awaited, so typing this as Promise rejects every
  // call site.
  const timed = async (work: () => PromiseLike<unknown>) => {
    const started = Date.now()
    await work()
    return Date.now() - started
  }

  it('the dashboard aggregates stay quick for the 90x brand', async () => {
    const kilele = sessions.get('KILELE')!

    const contactMs = await timed(() => kilele.rpc('contactability_breakdown'))
    const campaignMs = await timed(() => kilele.rpc('campaign_performance'))
    const signupMs = await timed(() => kilele.rpc('signups_per_day', { window_days: 30 }))

    expect(contactMs, `contactability took ${contactMs}ms`).toBeLessThan(3000)
    expect(campaignMs, `campaign performance took ${campaignMs}ms`).toBeLessThan(3000)
    expect(signupMs, `signups took ${signupMs}ms`).toBeLessThan(3000)
  }, 60_000)

  it('a page of customers costs the same for 81,842 rows as for 928', async () => {
    const page = (client: SupabaseClient) =>
      client
        .from('contacts')
        .select('id, external_id, full_name, email, status', { count: 'exact' })
        .order('signup_at', { ascending: false, nullsFirst: false })
        .range(0, 49)

    const bigMs = await timed(() => page(sessions.get('KILELE')!))
    const smallMs = await timed(() => page(sessions.get('MARRAKECH')!))

    expect(bigMs, `big brand page took ${bigMs}ms`).toBeLessThan(3000)
    // Paging reads fifty rows either way, so the big brand must not be an
    // order of magnitude worse. A full-table read would show up here.
    expect(bigMs).toBeLessThan(Math.max(smallMs, 200) * 12)
  }, 60_000)

  it('searching 81,842 customers stays interactive', async () => {
    const ms = await timed(() =>
      sessions
        .get('KILELE')!
        .from('contacts')
        .select('id, full_name, email', { count: 'exact' })
        .or('full_name.ilike.%wanjiru%,email.ilike.%wanjiru%')
        .range(0, 49),
    )

    expect(ms, `search took ${ms}ms`).toBeLessThan(3000)
  }, 60_000)
})
