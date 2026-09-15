import 'server-only'

import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { readEvents } from '@/lib/provider/dispatcher'

/**
 * Reading the provider's delivery reports and applying them.
 *
 * The provider offers no webhook, so this is a poll: the app asks what has
 * happened since it last looked. That is the shape the brief describes —
 * reports arrive "while your app isn't looking", and are collected whenever it
 * next looks, rather than being pushed.
 *
 * Nothing here assumes a report arrives once, or in order. Both assumptions
 * were tested against the live service and both are false, whatever /v1/docs
 * claims. Every page is applied through a function that keys on the provider's
 * own event id and ranks delivery status rather than overwriting it, so
 * applying the same page twice, or an older page after a newer one, changes
 * nothing.
 */

export type SyncResult = {
  sendId: string
  pages: number
  eventsSeen: number
  engagementInserted: number
  recipientsTouched: number
  unmatched: number
  complete: boolean
  error?: string
}

/** A page is at most 1,000 events; these are stops, not expectations. */
const MAX_PAGES_PER_BATCH = 40

/**
 * Across every batch of one send. A 36,185-person send is 73 batches, so the
 * per-batch stop alone would allow nearly three thousand requests in one go.
 */
const MAX_PAGES_PER_SYNC = 400

type SendRow = {
  id: string
  brand_id: string
  campaign_id: string
  provider_batch_id: string | null
  events_cursor: string | null
  events_applied: number
  campaigns: { channel: 'email' | 'sms' } | { channel: 'email' | 'sms' }[] | null
}

/**
 * Pulls every outstanding report for one send.
 *
 * Runs under the service role: it writes to the engagement log and to
 * recipients, which no signed-in user may touch. Every statement it issues
 * names the brand explicitly, because the database's own protection is
 * switched off for this client.
 */
export async function syncSend(sendId: string): Promise<SyncResult> {
  const admin = createAdminSupabaseClient()

  const { data: send, error } = await admin
    .from('campaign_sends')
    .select('id, brand_id, campaign_id, provider_batch_id, events_cursor, events_applied, campaigns(channel)')
    .eq('id', sendId)
    .maybeSingle<SendRow>()

  const empty: SyncResult = {
    sendId,
    pages: 0,
    eventsSeen: 0,
    engagementInserted: 0,
    recipientsTouched: 0,
    unmatched: 0,
    complete: false,
  }

  if (error || !send) return { ...empty, error: error?.message ?? 'send not found' }
  if (!send.provider_batch_id) {
    return { ...empty, error: 'This send was never handed to the provider, so there is nothing to read.' }
  }

  const campaign = Array.isArray(send.campaigns) ? send.campaigns[0] : send.campaigns
  const channel = campaign?.channel ?? 'email'

  /*
   * Which report streams belong to this send.
   *
   * A send is fanned out into one provider call per 500 recipients, and each
   * call has its own batch reference and its own cursor. Reading only the
   * first would report on the first 500 people and silently ignore the rest.
   *
   * Sends made before fan-out existed have no rows in send_batches, so the
   * single reference on campaign_sends stands in for one batch. That keeps
   * every send already on record readable.
   */
  const { data: batchRows, error: batchError } = await admin
    .from('send_batches')
    .select('id, sequence, provider_batch_id, events_cursor, events_applied')
    .eq('send_id', send.id)
    .eq('brand_id', send.brand_id)
    .order('sequence', { ascending: true })

  if (batchError) return { ...empty, error: batchError.message }

  type Batch = {
    rowId: number | null
    batchId: string
    cursor: string | null
    applied: number
  }

  const batches: Batch[] =
    (batchRows ?? []).length > 0
      ? (batchRows as Array<{
          id: number
          provider_batch_id: string
          events_cursor: string | null
          events_applied: number
        }>).map((row) => ({
          rowId: row.id,
          batchId: row.provider_batch_id,
          cursor: row.events_cursor,
          applied: row.events_applied,
        }))
      : [
          {
            rowId: null,
            batchId: send.provider_batch_id,
            cursor: send.events_cursor,
            applied: send.events_applied,
          },
        ]

  let pages = 0
  let eventsSeen = 0
  let engagementInserted = 0
  let recipientsTouched = 0
  let unmatched = 0
  let complete = true

  try {
    for (const batch of batches) {
      let cursor = batch.cursor
      let appliedHere = 0
      let batchPages = 0
      let batchComplete = false

      while (batchPages < MAX_PAGES_PER_BATCH && pages < MAX_PAGES_PER_SYNC) {
        const page = await readEvents({ batchId: batch.batchId, since: cursor })
        pages += 1
        batchPages += 1
        eventsSeen += page.events.length

        if (page.events.length > 0) {
          const { data: applied, error: applyError } = await admin.rpc('apply_provider_reports', {
            target_brand_id: send.brand_id,
            target_send_id: send.id,
            target_campaign_id: send.campaign_id,
            send_channel: channel,
            event_ids: page.events.map((event) => event.event_id),
            recipient_refs: page.events.map((event) => event.recipient_id),
            event_types: page.events.map((event) => event.type),
            occurred_ats: page.events.map((event) => event.occurred_at),
          })

          if (applyError) throw new Error(applyError.message)

          const result = (applied as Array<{
            engagement_inserted: number
            recipients_touched: number
            unmatched: number
          }>)?.[0]

          engagementInserted += result?.engagement_inserted ?? 0
          appliedHere += result?.engagement_inserted ?? 0
          recipientsTouched += result?.recipients_touched ?? 0
          unmatched += result?.unmatched ?? 0
        }

        /*
         * The cursor is saved after the page is applied, never before. If the
         * process dies between the two, the same page is read again next time —
         * which is harmless, because applying it twice does nothing — whereas
         * saving first would skip a page that was never applied.
         */
        cursor = page.nextCursor ?? cursor

        if (batch.rowId === null) {
          await admin
            .from('campaign_sends')
            .update({
              events_cursor: cursor,
              events_applied: send.events_applied + engagementInserted,
              last_synced_at: new Date().toISOString(),
            })
            .eq('id', send.id)
            .eq('brand_id', send.brand_id)
        } else {
          await admin
            .from('send_batches')
            .update({
              events_cursor: cursor,
              events_applied: batch.applied + appliedHere,
              last_synced_at: new Date().toISOString(),
            })
            .eq('id', batch.rowId)
            .eq('brand_id', send.brand_id)
        }

        if (!page.hasMore) {
          batchComplete = true
          break
        }

        // A provider that keeps saying "more" while returning nothing would
        // otherwise spin until the page cap.
        if (page.events.length === 0) break
      }

      // The send is only finished when every one of its batches is.
      if (!batchComplete) complete = false
    }

    // Roll the send's own tally up from its batches, so the send page can show
    // one figure without reading every batch row.
    if (batches.some((batch) => batch.rowId !== null)) {
      await admin
        .from('campaign_sends')
        .update({
          events_applied: send.events_applied + engagementInserted,
          last_synced_at: new Date().toISOString(),
        })
        .eq('id', send.id)
        .eq('brand_id', send.brand_id)
    }
  } catch (syncError) {
    return {
      sendId,
      pages,
      eventsSeen,
      engagementInserted,
      recipientsTouched,
      unmatched,
      complete: false,
      error: syncError instanceof Error ? syncError.message : String(syncError),
    }
  }

  return { sendId, pages, eventsSeen, engagementInserted, recipientsTouched, unmatched, complete }
}

/**
 * Syncs every send of one brand that has been handed to the provider.
 *
 * Scoped to a brand because it is called on behalf of a signed-in person, and
 * nobody should be able to make the server do work against another tenant's
 * data — even work that only reads.
 */
export async function syncBrand(brandId: string): Promise<SyncResult[]> {
  const admin = createAdminSupabaseClient()

  const { data: sends } = await admin
    .from('campaign_sends')
    .select('id')
    .eq('brand_id', brandId)
    .not('provider_batch_id', 'is', null)
    .order('approved_at', { ascending: false })
    .limit(25)

  const results: SyncResult[] = []
  for (const send of sends ?? []) {
    results.push(await syncSend(send.id))
  }
  return results
}
