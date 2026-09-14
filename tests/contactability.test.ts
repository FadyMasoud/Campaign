import { createClient } from '@supabase/supabase-js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * "Who is contactable" has to stay correct when the provider talks back late,
 * out of order, twice, or while nothing is watching.
 *
 * Contactability is stored on the contact and maintained by a trigger on the
 * event log, so these tests drive the trigger directly with deliberately
 * awkward sequences. Each builds and destroys its own contact, so the
 * assertions are about the mechanism rather than about whichever rows the
 * seed import happened to produce.
 *
 * The properties being proved are the ones the send phase depends on:
 * an opt-out, once recorded, is never undone by anything arriving afterwards.
 */

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false, autoRefreshToken: false } },
)

const RUN = Math.random().toString(36).slice(2, 10)
let brandId: string
const createdContacts: string[] = []

async function makeContact(suffix: string): Promise<string> {
  const { data, error } = await admin
    .from('contacts')
    .insert({
      brand_id: brandId,
      external_id: `CONTACTABILITY-${RUN}-${suffix}`,
      full_name: 'Contactability Fixture',
      email: `contactability.${RUN}.${suffix}@vg-eval.test`,
      status: 'active',
      consent_marketing: true,
      source_file: 'tests/contactability.test.ts',
    })
    .select('id')
    .single()

  if (error) throw new Error(`could not create contact: ${error.message}`)
  createdContacts.push(data.id)
  return data.id
}

async function recordEvent(
  contactId: string,
  eventType: 'unsubscribe' | 'complaint' | 'bounce' | 'open',
  occurredAt: string,
  reference: string,
) {
  return admin.from('contact_events').insert({
    brand_id: brandId,
    external_id: `EV-${RUN}-${reference}`,
    contact_id: contactId,
    event_type: eventType,
    channel: 'email',
    occurred_at: occurredAt,
  })
}

const readFlags = async (contactId: string) => {
  const { data, error } = await admin
    .from('contacts')
    .select('opted_out_at, bounced_at')
    .eq('id', contactId)
    .single()
  expect(error).toBeNull()
  return data as { opted_out_at: string | null; bounced_at: string | null }
}

beforeAll(async () => {
  const { data, error } = await admin.from('brands').select('id').eq('code', 'KILELE').single()
  if (error) throw new Error(`brand lookup failed: ${error.message}`)
  brandId = data.id
})

afterAll(async () => {
  // Events cascade from the contact, so removing the contact removes them.
  for (const id of createdContacts) await admin.from('contacts').delete().eq('id', id)
})

describe('an opt-out is recorded the moment it is reported', () => {
  it('marks the contact as opted out', async () => {
    const contactId = await makeContact('basic')
    expect((await readFlags(contactId)).opted_out_at).toBeNull()

    const { error } = await recordEvent(contactId, 'unsubscribe', '2026-06-01T10:00:00Z', 'basic-1')
    expect(error).toBeNull()

    const flags = await readFlags(contactId)
    expect(flags.opted_out_at).not.toBeNull()
    expect(new Date(flags.opted_out_at!).toISOString()).toBe('2026-06-01T10:00:00.000Z')
  })

  it('treats a complaint the same way as an unsubscribe', async () => {
    const contactId = await makeContact('complaint')
    await recordEvent(contactId, 'complaint', '2026-06-01T10:00:00Z', 'complaint-1')

    expect((await readFlags(contactId)).opted_out_at).not.toBeNull()
  })

  it('records a bounce separately from an opt-out', async () => {
    const contactId = await makeContact('bounce')
    await recordEvent(contactId, 'bounce', '2026-06-01T10:00:00Z', 'bounce-1')

    const flags = await readFlags(contactId)
    expect(flags.bounced_at).not.toBeNull()
    expect(flags.opted_out_at).toBeNull()
  })

  it('ignores events that say nothing about reachability', async () => {
    const contactId = await makeContact('open')
    await recordEvent(contactId, 'open', '2026-06-01T10:00:00Z', 'open-1')

    const flags = await readFlags(contactId)
    expect(flags.opted_out_at).toBeNull()
    expect(flags.bounced_at).toBeNull()
  })
})

describe('reports arriving out of order cannot undo an opt-out', () => {
  it('keeps the earliest opt-out when an older report turns up later', async () => {
    const contactId = await makeContact('out-of-order')

    // June is reported first...
    await recordEvent(contactId, 'unsubscribe', '2026-06-01T10:00:00Z', 'ooo-june')
    // ...then a January report for the same person arrives afterwards.
    await recordEvent(contactId, 'unsubscribe', '2026-01-15T08:00:00Z', 'ooo-january')

    const flags = await readFlags(contactId)
    // The person opted out in January; learning that later does not change
    // when it happened, and it certainly does not make them contactable again.
    expect(new Date(flags.opted_out_at!).toISOString()).toBe('2026-01-15T08:00:00.000Z')
  })

  it('does not let a later report push the opt-out forward', async () => {
    const contactId = await makeContact('later')

    await recordEvent(contactId, 'unsubscribe', '2026-01-15T08:00:00Z', 'later-january')
    await recordEvent(contactId, 'unsubscribe', '2026-09-01T08:00:00Z', 'later-september')

    const flags = await readFlags(contactId)
    expect(new Date(flags.opted_out_at!).toISOString()).toBe('2026-01-15T08:00:00.000Z')
  })

  it('applies the same rule to bounces', async () => {
    const contactId = await makeContact('bounce-order')

    await recordEvent(contactId, 'bounce', '2026-06-01T10:00:00Z', 'bo-june')
    await recordEvent(contactId, 'bounce', '2026-02-01T10:00:00Z', 'bo-february')

    const flags = await readFlags(contactId)
    expect(new Date(flags.bounced_at!).toISOString()).toBe('2026-02-01T10:00:00.000Z')
  })
})

describe('the same report twice changes nothing', () => {
  it('refuses a duplicate event reference', async () => {
    const contactId = await makeContact('idempotent')

    const first = await recordEvent(contactId, 'unsubscribe', '2026-04-01T12:00:00Z', 'idem-1')
    expect(first.error).toBeNull()

    const before = await readFlags(contactId)

    // The provider sends the same report again — same reference, same person.
    const second = await recordEvent(contactId, 'unsubscribe', '2026-04-01T12:00:00Z', 'idem-1')
    expect(second.error, 'a repeated event reference must be refused').not.toBeNull()

    const after = await readFlags(contactId)
    expect(after.opted_out_at).toBe(before.opted_out_at)
  })

  it('is unchanged by a second, differently-referenced report of the same fact', async () => {
    const contactId = await makeContact('repeat')

    await recordEvent(contactId, 'unsubscribe', '2026-04-01T12:00:00Z', 'repeat-1')
    const before = await readFlags(contactId)

    await recordEvent(contactId, 'unsubscribe', '2026-04-01T12:00:00Z', 'repeat-2')
    const after = await readFlags(contactId)

    expect(after.opted_out_at).toBe(before.opted_out_at)
  })
})

describe('an opted-out contact stops being contactable', () => {
  it('drops out of the contactable count and into the right bucket', async () => {
    const contactId = await makeContact('counted')

    const before = await admin.rpc('contactability_breakdown')
    const beforeRow = (before.data as Array<{ brand_id: string; contactable: number; opted_out_in_log: number }>)
      .find((row) => row.brand_id === brandId)!

    await recordEvent(contactId, 'unsubscribe', '2026-05-01T09:00:00Z', 'counted-1')

    const after = await admin.rpc('contactability_breakdown')
    const afterRow = (after.data as Array<{ brand_id: string; contactable: number; opted_out_in_log: number }>)
      .find((row) => row.brand_id === brandId)!

    expect(afterRow.contactable).toBe(beforeRow.contactable - 1)
    expect(afterRow.opted_out_in_log).toBe(beforeRow.opted_out_in_log + 1)
  })
})
