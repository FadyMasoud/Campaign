import 'server-only'

import { requireServerEnv } from '@/lib/env/server'

/**
 * The messaging provider, as it actually behaves.
 *
 * `server-only` is doing real work here: this module holds the key that sends
 * messages to real inboxes and spends real money. If a Client Component ever
 * imports it, the build fails rather than shipping that key to a browser.
 *
 * IMPORTANT — the published docs and the observed behaviour disagree.
 *
 * /v1/docs states: "The report stream is clean and complete: every event is
 * delivered exactly once and in order." Neither half is true. Polling the same
 * batch three times returned the same two event ids three times, and within a
 * single page the event ids ran ahead of the timestamps:
 *
 *   evt-batch_2c-00000  delivered  2026-09-14T11:46:35Z
 *   evt-batch_2c-00001  delivered  2026-09-14T11:46:18Z
 *
 * So the reports repeat, and they arrive out of order. Everything downstream
 * is built for that: events are keyed on the provider's own event_id so
 * re-reading a page changes nothing, and the state they produce is derived
 * order-independently rather than by last-write-wins.
 */

export type DispatchRecipient = {
  /** Our own reference for the person, which the provider echoes back. */
  id: string
  email?: string
  phone?: string
}

export type DispatchResult = {
  batchId: string
  accepted: string[]
  rejected: string[]
}

export type ProviderEvent = {
  event_id: string
  recipient_id: string
  type: 'delivered' | 'bounced' | 'opened' | 'unsubscribed'
  occurred_at: string
  /**
   * The provider's own brand label. Observed to come back as "account"
   * regardless of what was sent, so it is never used to decide which brand an
   * event belongs to — that comes from the send we created and already know
   * the brand of. Trusting this field would let the provider assign our rows
   * to the wrong tenant.
   */
  brand_code?: string
}

export type EventPage = {
  events: ProviderEvent[]
  nextCursor: string | null
  hasMore: boolean
}

function baseUrl(): string {
  return requireServerEnv('DISPATCHER_BASE_URL').replace(/\/+$/, '')
}

function authHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireServerEnv('DISPATCHER_API_KEY')}`,
    'Content-Type': 'application/json',
  }
}

/**
 * Hands a batch of recipients to the provider.
 *
 * `idempotencyKey` is the send's own id, and it is what makes a retry safe:
 * the provider returns the original batch rather than creating a second one.
 * Verified against the live service — posting the same key twice returned the
 * same batch_id, while omitting it produced a new batch.
 *
 * That matters more than it looks. If this call times out after the provider
 * has already accepted the batch, retrying with the same key re-attaches to
 * the send that is already in flight instead of sending to everyone twice.
 */
export async function dispatchBatch(options: {
  idempotencyKey: string
  campaign: string
  brand: string
  recipients: DispatchRecipient[]
  signal?: AbortSignal
}): Promise<DispatchResult> {
  const response = await fetch(`${baseUrl()}/v1/messages`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Idempotency-Key': options.idempotencyKey },
    body: JSON.stringify({
      campaign: options.campaign,
      brand: options.brand,
      recipients: options.recipients,
    }),
    signal: options.signal,
    cache: 'no-store',
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `The messaging provider refused the send (HTTP ${response.status}). ${body.slice(0, 300)}`,
    )
  }

  const data = (await response.json()) as {
    batch_id?: string
    accepted?: string[]
    rejected?: string[]
  }

  if (!data.batch_id) {
    throw new Error('The messaging provider accepted the request but returned no batch reference.')
  }

  return {
    batchId: data.batch_id,
    accepted: data.accepted ?? [],
    rejected: data.rejected ?? [],
  }
}

/**
 * Reads one page of delivery reports for a batch.
 *
 * `since` is the cursor the provider hands back. It is an optimisation, not a
 * correctness mechanism: the caller must still treat every event as something
 * it may already have seen, because the provider re-serves events it has
 * already given out.
 */
export async function readEvents(options: {
  batchId: string
  since?: string | null
  signal?: AbortSignal
}): Promise<EventPage> {
  const url = new URL(`${baseUrl()}/v1/messages/${options.batchId}/events`)
  if (options.since) url.searchParams.set('since', options.since)

  const response = await fetch(url, {
    headers: authHeaders(),
    signal: options.signal,
    cache: 'no-store',
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(
      `Could not read delivery reports (HTTP ${response.status}). ${body.slice(0, 300)}`,
    )
  }

  const data = (await response.json()) as {
    events?: ProviderEvent[]
    next_cursor?: string | null
    has_more?: boolean
  }

  return {
    events: data.events ?? [],
    nextCursor: data.next_cursor ?? null,
    hasMore: Boolean(data.has_more),
  }
}
