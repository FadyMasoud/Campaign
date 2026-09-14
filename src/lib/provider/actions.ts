'use server'

import { revalidatePath } from 'next/cache'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { syncSend } from '@/lib/provider/ingest'

/**
 * Fetching the provider's latest reports for one send.
 *
 * Reading reports is not sending, so an analyst may do it: it changes what the
 * portal knows, not what anybody receives. The brand check still matters — the
 * send id is user input, and without it anyone could make the server pull
 * another tenant's reports.
 *
 * That check is made by reading the send through the USER's client first. If
 * the send belongs to another brand it is simply not visible, so the request
 * stops before the service role is ever used.
 */

export type SyncState = { message: string | null; error: string | null }

export async function fetchProviderReports(
  _previous: SyncState,
  formData: FormData,
): Promise<SyncState> {
  const sendId = formData.get('sendId')?.toString()
  if (!sendId) return { message: null, error: 'No send was named.' }

  const brand = await requireBrand()
  const supabase = await createServerSupabaseClient()

  const { data: send } = await supabase
    .from('campaign_sends')
    .select('id, campaign_id')
    .eq('id', sendId)
    .maybeSingle<{ id: string; campaign_id: string }>()

  if (!send) {
    // Another brand's send is invisible, so this is the same answer as one
    // that does not exist.
    return { message: null, error: 'That send could not be found.' }
  }

  const result = await syncSend(send.id)

  if (result.error) {
    return { message: null, error: `The provider could not be read: ${result.error}` }
  }

  revalidatePath(`/portal/sends/${send.id}`)
  revalidatePath(`/portal/campaigns/${send.campaign_id}`)

  const parts = [
    `Read ${result.eventsSeen.toLocaleString('en')} report${result.eventsSeen === 1 ? '' : 's'}`,
    `${result.engagementInserted.toLocaleString('en')} new`,
    `${result.recipientsTouched.toLocaleString('en')} recipient${result.recipientsTouched === 1 ? '' : 's'} updated`,
  ]

  if (result.unmatched > 0) {
    parts.push(`${result.unmatched.toLocaleString('en')} for unknown recipients, ignored`)
  }
  if (!result.complete) {
    parts.push('more still to come')
  }

  // Saying how many were NEW, not just how many were read, is the honest
  // report: the provider re-serves events it has already given us, so "read
  // 50" on a second run with "0 new" is the idempotency working, not a failure.
  return { message: `${parts.join(' · ')}.${brand.role === 'analyst' ? '' : ''}`, error: null }
}
