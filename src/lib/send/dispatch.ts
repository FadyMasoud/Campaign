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

/**
 * PostgREST refuses to return more than `db.max_rows` rows — 1,000 on this
 * project — and it does it silently. `.limit(50000)` and `.range(0, 49999)`
 * both come back with exactly 1,000 rows and no error, which is how an
 * earlier version of this file froze 1,000 people for a send of 23,969 and
 * reported the larger number on screen. Everything below pages deliberately.
 */
const ROWS_PER_READ = 1_000

/** How many rows to put in one insert. Bounded by payload size, not by reads. */
const ROWS_PER_INSERT = 1_000

/**
 * How many recipients to hand the provider in one call.
 *
 * Its documentation says "Up to 100,000 recipients per call" and that the
 * rejected array is "normally empty". Neither is true: three sends of 1,000
 * came back accepted 500 / rejected 500, and a send of 240 came back 240 / 0.
 * The observed ceiling is 500, so that is what we send, and anything the
 * provider still refuses is recorded as refused rather than assumed sent.
 */
const RECIPIENTS_PER_BATCH = 500

/** A stop, so a runaway page loop cannot spin forever. */
const MAX_READ_PAGES = 200

export type Recipient = { contact_id: string; external_id: string; destination: string }

/**
 * Every contactable person for one brand and channel, with nothing missing.
 *
 * Exported so the paging can be tested on its own. The bug this replaces was
 * invisible from the outside — the query returned a plausible 1,000 rows and
 * no error — so the regression test asserts the count directly rather than
 * inferring it from a send.
 *
 * The caller passes the admin client, which has RLS switched off; brand_id is
 * filtered here explicitly, and that filter is the only thing keeping one
 * brand's send from picking up another brand's customers.
 */
export async function readWholeAudience(options: {
  admin: ReturnType<typeof createAdminSupabaseClient>
  brandId: string
  channel: 'email' | 'sms'
}): Promise<Recipient[]> {
  const destinationColumn = options.channel === 'email' ? 'email' : 'phone_e164'
  const recipients: Recipient[] = []
  type Row = Record<string, string | null>

  /*
   * Read a page at a time, ordered by a unique column.
   *
   * The order matters as much as the paging: without a deterministic sort,
   * Postgres may return rows in a different order for each page, so a person
   * can appear on two pages (sent twice) or on none (never sent). `id` is the
   * primary key, so the sequence is total and stable.
   */
  for (let page = 0; page < MAX_READ_PAGES; page += 1) {
    const from = page * ROWS_PER_READ

    const { data, error } = await options.admin
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
      .order('id', { ascending: true })
      .range(from, from + ROWS_PER_READ - 1)

    if (error) throw new Error(error.message)

    /*
     * The column list is built from the channel, so supabase-js infers a union
     * of two row shapes that it cannot map over. One cast at this boundary is
     * clearer than making the query generic — the shape is known, it is just
     * not knowable from a template literal.
     */
    const rows = (data ?? []) as unknown as Row[]
    for (const record of rows) {
      recipients.push({
        contact_id: record.id!,
        external_id: record.external_id!,
        destination: record[destinationColumn] ?? '',
      })
    }

    // A short page is the last page. Equally, a full page that happens to be
    // the last costs one extra empty read, which is cheaper than guessing.
    if (rows.length < ROWS_PER_READ) break
  }

  return recipients
}

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

  let recipients: Recipient[]
  try {
    recipients = await readWholeAudience({
      admin,
      brandId: options.brandId,
      channel: options.channel,
    })
  } catch (error) {
    await markFailed(
      options.sendId,
      options.brandId,
      `audience: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  if (recipients.length === 0) {
    await markFailed(options.sendId, options.brandId, 'The audience was empty at dispatch time.')
    return
  }

  /*
   * Freeze the list before anything leaves the building. If the dispatch dies
   * now, the record of who was approved survives.
   *
   * Chunked for the same reason as the read, from the other direction: one
   * insert carrying 36,185 rows is a request body large enough to be refused.
   */
  for (let from = 0; from < recipients.length; from += ROWS_PER_INSERT) {
    const { error: freezeError } = await admin.from('send_recipients').insert(
      recipients.slice(from, from + ROWS_PER_INSERT).map((person) => ({
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
  }

  await admin
    .from('campaign_sends')
    .update({ status: 'dispatching', dispatched_at: new Date().toISOString() })
    .eq('id', options.sendId)
    .eq('brand_id', options.brandId)

  /*
   * Hand the audience over in batches the provider will actually take.
   *
   * Each batch is a separate call with its own idempotency key and its own
   * batch reference, recorded before the next one starts. If the process dies
   * at batch 30 of 48, the thirty that went are on record as sent and the
   * eighteen that did not are still 'queued' — nothing is guessed either way.
   */
  const batchIds: string[] = []
  let acceptedTotal = 0
  let rejectedTotal = 0

  try {
    for (let index = 0; index * RECIPIENTS_PER_BATCH < recipients.length; index += 1) {
      const chunk = recipients.slice(
        index * RECIPIENTS_PER_BATCH,
        (index + 1) * RECIPIENTS_PER_BATCH,
      )

      const result = await dispatchBatch({
        // The send's id plus the chunk number: a retry of this exact chunk
        // re-attaches to the same provider batch rather than creating a
        // second one, and chunk 4 is never mistaken for chunk 5.
        idempotencyKey: `${options.sendId}:${index}`,
        campaign: options.campaignRef,
        brand: options.brandCode,
        recipients: chunk.map((person) => ({
          id: person.external_id,
          ...(options.channel === 'email'
            ? { email: person.destination }
            : { phone: person.destination }),
        })),
      })

      const accepted = new Set(result.accepted)
      const acceptedRefs = chunk.filter((p) => accepted.has(p.external_id)).map((p) => p.external_id)
      const rejectedRefs = chunk.filter((p) => !accepted.has(p.external_id)).map((p) => p.external_id)

      /*
       * Mark accepted and rejected separately, through a function taking
       * arrays in the request body. The previous version filtered on a list of
       * ids in the URL, which stops working somewhere around a few hundred
       * recipients — silently, as a malformed request rather than a short one.
       *
       * A recipient the provider refused is a person who did not receive the
       * message, and saying so is the difference between an honest send and a
       * silent half-send.
       */
      const { error: markError } = await admin.rpc('mark_send_recipients', {
        target_brand_id: options.brandId,
        target_send_id: options.sendId,
        accepted_refs: acceptedRefs,
        rejected_refs: rejectedRefs,
      })

      if (markError) throw new Error(`recording batch ${index + 1}: ${markError.message}`)

      const { error: batchError } = await admin.from('send_batches').insert({
        brand_id: options.brandId,
        send_id: options.sendId,
        sequence: index,
        provider_batch_id: result.batchId,
        recipient_count: chunk.length,
        accepted_count: acceptedRefs.length,
        rejected_count: rejectedRefs.length,
      })

      if (batchError) throw new Error(`recording batch ${index + 1}: ${batchError.message}`)

      batchIds.push(result.batchId)
      acceptedTotal += acceptedRefs.length
      rejectedTotal += rejectedRefs.length
    }

    await admin
      .from('campaign_sends')
      .update({
        status: 'sent',
        // The first batch, kept for the sends that predate fan-out and for
        // anything still reading a single reference. send_batches is the
        // complete record.
        provider_batch_id: batchIds[0] ?? null,
        accepted_count: acceptedTotal,
        rejected_count: rejectedTotal,
        completed_at: new Date().toISOString(),
      })
      .eq('id', options.sendId)
      .eq('brand_id', options.brandId)
  } catch (error) {
    /*
     * Record what did go out before failing. A send that placed 30 batches and
     * then lost the provider has really sent 15,000 messages, and a status of
     * 'failed' with no counts would invite somebody to send it all again.
     */
    if (batchIds.length > 0) {
      await admin
        .from('campaign_sends')
        .update({
          provider_batch_id: batchIds[0],
          accepted_count: acceptedTotal,
          rejected_count: rejectedTotal,
        })
        .eq('id', options.sendId)
        .eq('brand_id', options.brandId)
    }

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
