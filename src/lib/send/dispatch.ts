import 'server-only'

import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { dispatchBatch } from '@/lib/provider/dispatcher'

/**
 * Dispatching a send that has already been approved.
 *
 * Deliberately NOT in the 'use server' module. A file marked 'use server'
 * exposes every export as a callable endpoint, so only things a browser is
 * meant to invoke belong there. This is internal machinery — and keeping it
 * here also means a test can drive it directly rather than re-implementing it,
 * which is the only way to check the provider integration honestly.
 */

const MAX_RECIPIENTS_PER_CALL = 50_000

/**
 * Freezes the approved audience and hands it to the provider.
 *
 * Runs under the service role because it writes thousands of rows the user has
 * no direct write access to, and because the provider key is server-side. Both
 * queries filter by brand_id explicitly — the admin client switches the
 * database's safety net off, so the filter here is the only thing keeping one
 * brand's send from picking up another brand's customers.
 */
export async function freezeAudienceAndDispatch(options: {
  sendId: string
  brandId: string
  brandCode: string
  campaignId: string
  campaignRef: string
  channel: 'email' | 'sms'
}) {
  const admin = createAdminSupabaseClient()
  const destinationColumn = options.channel === 'email' ? 'email' : 'phone_e164'

  const { data: audience, error: audienceError } = await admin
    .from('contacts')
    .select(`id, external_id, ${destinationColumn}`)
    .eq('brand_id', options.brandId) // explicit: RLS is off for this client
    .is('deleted_at', null)
    .eq('consent_marketing', true)
    .not('status', 'in', '("unsubscribed","bounced")')
    .is('opted_out_at', null)
    .is('bounced_at', null)
    .or(`suppressed_until.is.null,suppressed_until.lte.${new Date().toISOString()}`)
    .not(destinationColumn, 'is', null)
    .limit(MAX_RECIPIENTS_PER_CALL)

  if (audienceError) {
    await markFailed(options.sendId, options.brandId, `audience: ${audienceError.message}`)
    return
  }

  /*
   * The column list is built from the channel, so supabase-js infers a union
   * of two row shapes that it cannot map over. One cast at this boundary is
   * clearer than making the query generic — the shape is known, it is just not
   * knowable from a template literal.
   */
  type Row = Record<string, string | null>
  type Recipient = { contact_id: string; external_id: string; destination: string }

  const recipients: Recipient[] = ((audience ?? []) as unknown as Row[]).map((record) => ({
    contact_id: record.id!,
    external_id: record.external_id!,
    destination: record[destinationColumn] ?? '',
  }))

  // Freeze the list before anything leaves the building. If the dispatch dies
  // now, the record of who was approved survives.
  const { error: freezeError } = await admin.from('send_recipients').insert(
    recipients.map((person) => ({
      brand_id: options.brandId,
      send_id: options.sendId,
      contact_id: person.contact_id,
      channel: options.channel,
      destination: person.destination,
      status: 'queued' as const,
    })),
  )

  if (freezeError) {
    await markFailed(options.sendId, options.brandId, `freezing audience: ${freezeError.message}`)
    return
  }

  await admin
    .from('campaign_sends')
    .update({ status: 'dispatching', dispatched_at: new Date().toISOString() })
    .eq('id', options.sendId)
    .eq('brand_id', options.brandId)

  try {
    const result = await dispatchBatch({
      // The send's own id: a retry of this exact send re-attaches to the same
      // provider batch rather than creating a second one.
      idempotencyKey: options.sendId,
      campaign: options.campaignRef,
      brand: options.brandCode,
      recipients: recipients.map((person) => ({
        id: person.external_id,
        ...(options.channel === 'email'
          ? { email: person.destination }
          : { phone: person.destination }),
      })),
    })

    const accepted = new Set(result.accepted)

    // Mark accepted and rejected separately. A recipient the provider refused
    // is a person who did not receive the message, and saying so is the
    // difference between an honest send and a silent half-send.
    await admin
      .from('send_recipients')
      .update({ status: 'accepted', updated_at: new Date().toISOString() })
      .eq('send_id', options.sendId)
      .in(
        'contact_id',
        recipients.filter((p) => accepted.has(p.external_id)).map((p) => p.contact_id),
      )

    const rejected = recipients.filter((p) => !accepted.has(p.external_id))
    if (rejected.length > 0) {
      await admin
        .from('send_recipients')
        .update({ status: 'rejected', updated_at: new Date().toISOString() })
        .eq('send_id', options.sendId)
        .in('contact_id', rejected.map((p) => p.contact_id))
    }

    await admin
      .from('campaign_sends')
      .update({
        status: 'sent',
        provider_batch_id: result.batchId,
        accepted_count: result.accepted.length,
        rejected_count: rejected.length,
        completed_at: new Date().toISOString(),
      })
      .eq('id', options.sendId)
      .eq('brand_id', options.brandId)
  } catch (error) {
    await markFailed(
      options.sendId,
      options.brandId,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Records a failure against the send rather than throwing it away.
 *
 * The row keeps its approved_count and its frozen recipients, so what was
 * approved still reads as approved, and the failure is visible on the screen
 * instead of only in a server log the marketer cannot see.
 */
async function markFailed(sendId: string, brandId: string, message: string) {
  const admin = createAdminSupabaseClient()
  await admin
    .from('campaign_sends')
    .update({ status: 'failed', error: message, completed_at: new Date().toISOString() })
    .eq('id', sendId)
    .eq('brand_id', brandId)
}
