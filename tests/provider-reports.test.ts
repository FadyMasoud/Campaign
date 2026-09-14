import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Applying what the provider reports back.
 *
 * The brief promises the reports will be "deliberately messy and out of order
 * in places", and they are — worse than the provider's own documentation
 * admits. Against the live service:
 *
 *   * polling one batch repeatedly returns the same event ids every time;
 *   * timestamps within a page are not ordered;
 *   * and one event in a real Marrakech batch claimed brand_code "KAROO"
 *     while naming a contact that belongs to KILELE. Its event id was
 *     literally "evt-batch_50-forged".
 *
 * These tests drive public.apply_provider_reports directly with the awkward
 * cases, so each property is proved on its own rather than inferred from a
 * successful sync.
 */

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const RUN = Math.random().toString(36).slice(2, 10)

let kileleId: string
let karooId: string
let campaignId: string
let sendId: string
let contactId: string
let foreignExternalId: string
const createdContacts: string[] = []

type ApplyResult = {
  engagement_inserted: number
  recipients_touched: number
  unmatched: number
}

/** Applies a page of reports exactly as the sync loop does. */
async function apply(
  events: Array<{ id: string; ref: string; type: string; at: string }>,
): Promise<ApplyResult> {
  const { data, error } = await admin.rpc('apply_provider_reports', {
    target_brand_id: kileleId,
    target_send_id: sendId,
    target_campaign_id: campaignId,
    send_channel: 'email',
    event_ids: events.map((e) => e.id),
    recipient_refs: events.map((e) => e.ref),
    event_types: events.map((e) => e.type),
    occurred_ats: events.map((e) => e.at),
  })

  expect(error).toBeNull()
  return (data as ApplyResult[])[0]
}

const recipientStatus = async () => {
  const { data } = await admin
    .from('send_recipients')
    .select('status, last_event_at')
    .eq('send_id', sendId)
    .eq('contact_id', contactId)
    .single()
  return data as { status: string; last_event_at: string | null }
}

const contactFlags = async () => {
  const { data } = await admin
    .from('contacts')
    .select('opted_out_at, bounced_at')
    .eq('id', contactId)
    .single()
  return data as { opted_out_at: string | null; bounced_at: string | null }
}

beforeAll(async () => {
  const { data: brands } = await admin.from('brands').select('id, code')
  kileleId = brands!.find((b) => b.code === 'KILELE')!.id
  karooId = brands!.find((b) => b.code === 'KAROO')!.id

  const { data: campaign } = await admin
    .from('campaigns')
    .select('id')
    .eq('brand_id', kileleId)
    .limit(1)
    .single()
  campaignId = campaign!.id

  // The recipient of our fixture send.
  const { data: contact, error: contactError } = await admin
    .from('contacts')
    .insert({
      brand_id: kileleId,
      external_id: `REPORTS-${RUN}`,
      full_name: 'Reports Fixture',
      email: `reports.${RUN}@vg-eval.test`,
      status: 'active',
      consent_marketing: true,
      source_file: 'tests/provider-reports.test.ts',
    })
    .select('id')
    .single()
  if (contactError) throw new Error(contactError.message)
  contactId = contact.id
  createdContacts.push(contact.id)

  // A contact in ANOTHER brand, to stand in for the forged event.
  foreignExternalId = `REPORTS-FOREIGN-${RUN}`
  const { data: foreign, error: foreignError } = await admin
    .from('contacts')
    .insert({
      brand_id: karooId,
      external_id: foreignExternalId,
      full_name: 'Another Brand Customer',
      email: `foreign.${RUN}@vg-eval.test`,
      status: 'active',
      consent_marketing: true,
      source_file: 'tests/provider-reports.test.ts',
    })
    .select('id')
    .single()
  if (foreignError) throw new Error(foreignError.message)
  createdContacts.push(foreign.id)

  const { data: send, error: sendError } = await admin
    .from('campaign_sends')
    .insert({
      brand_id: kileleId,
      campaign_id: campaignId,
      requested_email: 'fixture@vg-eval.test',
      approved_count: 1,
      status: 'sent',
      provider_batch_id: `batch_fixture_${RUN}`,
    })
    .select('id')
    .single()
  if (sendError) throw new Error(sendError.message)
  sendId = send.id

  await admin.from('send_recipients').insert({
    brand_id: kileleId,
    send_id: sendId,
    contact_id: contactId,
    channel: 'email',
    destination: `reports.${RUN}@vg-eval.test`,
    status: 'accepted',
  })
})

afterAll(async () => {
  await admin.from('campaign_sends').delete().eq('id', sendId)
  for (const id of createdContacts) await admin.from('contacts').delete().eq('id', id)
})

describe('the same report twice changes nothing', () => {
  it('applies a delivery once, however many times it is reported', async () => {
    const event = { id: `evt-${RUN}-deliver`, ref: `REPORTS-${RUN}`, type: 'delivered', at: '2026-09-14T10:00:00Z' }

    const first = await apply([event])
    expect(first.recipients_touched).toBe(1)
    expect((await recipientStatus()).status).toBe('delivered')

    // The provider re-serves events it has already given out, so this is the
    // normal case rather than an edge case.
    const second = await apply([event])
    expect(second.engagement_inserted).toBe(0)
    expect(second.recipients_touched).toBe(0)
    expect((await recipientStatus()).status).toBe('delivered')
  })

  it('records an engagement event once, however many times it is reported', async () => {
    const event = { id: `evt-${RUN}-open`, ref: `REPORTS-${RUN}`, type: 'opened', at: '2026-09-14T10:05:00Z' }

    const first = await apply([event])
    expect(first.engagement_inserted).toBe(1)

    const second = await apply([event])
    expect(second.engagement_inserted).toBe(0)

    const { count } = await admin
      .from('contact_events')
      .select('*', { count: 'exact', head: true })
      .eq('external_id', event.id)
    expect(count).toBe(1)
  })
})

describe('reports arriving out of order do not undo worse news', () => {
  it('a bounce overrides an earlier delivery', async () => {
    await apply([
      { id: `evt-${RUN}-bounce`, ref: `REPORTS-${RUN}`, type: 'bounced', at: '2026-09-14T10:10:00Z' },
    ])
    expect((await recipientStatus()).status).toBe('bounced')
  })

  it('a delivery arriving AFTER a bounce does not resurrect the address', async () => {
    /*
     * The failure this guards against: a stale 'delivered' turning up late and
     * marking a dead address reachable again. Status is ranked rather than
     * overwritten, so the worse news wins whatever order it arrives in.
     */
    const late = await apply([
      { id: `evt-${RUN}-late-deliver`, ref: `REPORTS-${RUN}`, type: 'delivered', at: '2026-09-14T09:00:00Z' },
    ])

    expect(late.recipients_touched).toBe(0)
    expect((await recipientStatus()).status).toBe('bounced')
  })

  it('applies a whole page regardless of the order within it', async () => {
    // A page containing both, newest first — which is how the live service
    // actually returns them.
    const page = [
      { id: `evt-${RUN}-mixed-a`, ref: `REPORTS-${RUN}`, type: 'delivered', at: '2026-09-14T11:00:00Z' },
      { id: `evt-${RUN}-mixed-b`, ref: `REPORTS-${RUN}`, type: 'bounced', at: '2026-09-14T10:59:00Z' },
    ]
    await apply(page)
    expect((await recipientStatus()).status).toBe('bounced')
  })
})

describe('contactability follows what actually happened', () => {
  it('an unsubscribe report makes the customer uncontactable', async () => {
    expect((await contactFlags()).opted_out_at).toBeNull()

    await apply([
      { id: `evt-${RUN}-unsub`, ref: `REPORTS-${RUN}`, type: 'unsubscribed', at: '2026-09-14T12:00:00Z' },
    ])

    const flags = await contactFlags()
    expect(flags.opted_out_at).not.toBeNull()
  })

  it('an older unsubscribe report does not move the opt-out later', async () => {
    await apply([
      { id: `evt-${RUN}-unsub-older`, ref: `REPORTS-${RUN}`, type: 'unsubscribed', at: '2026-01-01T00:00:00Z' },
    ])

    const flags = await contactFlags()
    expect(new Date(flags.opted_out_at!).toISOString()).toBe('2026-01-01T00:00:00.000Z')
  })

  it('a bounce report is recorded against the customer too', async () => {
    const flags = await contactFlags()
    expect(flags.bounced_at).not.toBeNull()
  })
})

describe('a report naming another brand customer is discarded', () => {
  it('ignores an event whose recipient belongs to a different brand', async () => {
    /*
     * The forged event, reproduced. In the real Marrakech batch it arrived as:
     *
     *   {"event_id":"evt-batch_50-forged","recipient_id":"CT-033857",
     *    "brand_code":"KAROO","type":"delivered"}
     *
     * — a Kilele contact, labelled Karoo, inside a Marrakech send. The
     * recipient reference is resolved against the brand of the SEND, so it
     * matches nothing and is counted as unmatched rather than written
     * anywhere.
     */
    const before = await admin
      .from('contact_events')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', karooId)

    const result = await apply([
      { id: `evt-${RUN}-forged`, ref: foreignExternalId, type: 'delivered', at: '2026-09-14T12:02:28Z' },
    ])

    expect(result.unmatched).toBe(1)
    expect(result.engagement_inserted).toBe(0)
    expect(result.recipients_touched).toBe(0)

    const after = await admin
      .from('contact_events')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', karooId)

    // Nothing was written into the other brand either.
    expect(after.count).toBe(before.count)
  })

  it('writes nothing at all for an entirely unknown recipient', async () => {
    const result = await apply([
      { id: `evt-${RUN}-ghost`, ref: 'CT-DOES-NOT-EXIST', type: 'opened', at: '2026-09-14T12:00:00Z' },
    ])

    expect(result.unmatched).toBe(1)
    expect(result.engagement_inserted).toBe(0)

    const { count } = await admin
      .from('contact_events')
      .select('*', { count: 'exact', head: true })
      .eq('external_id', `evt-${RUN}-ghost`)
    expect(count).toBe(0)
  })

  it('still applies the good events in a page that contains a bad one', async () => {
    // A poisoned page must not cost the legitimate reports in it.
    const result = await apply([
      { id: `evt-${RUN}-mixed-good`, ref: `REPORTS-${RUN}`, type: 'opened', at: '2026-09-14T13:00:00Z' },
      { id: `evt-${RUN}-mixed-bad`, ref: foreignExternalId, type: 'opened', at: '2026-09-14T13:00:00Z' },
    ])

    expect(result.engagement_inserted).toBe(1)
    expect(result.unmatched).toBe(1)
  })
})
