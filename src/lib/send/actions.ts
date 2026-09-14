'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOwner } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { countAudience } from '@/lib/send/audience'
import { freezeAudienceAndDispatch } from '@/lib/send/dispatch'

/**
 * Approving and dispatching a send.
 *
 * The order of operations is the whole design, so it is worth reading as a
 * sequence rather than as five functions:
 *
 *   1. Re-check the role on the server. The button being visible proves
 *      nothing about who pressed it.
 *   2. Re-count the audience and compare it to the number the marketer was
 *      shown. If it moved, stop — do not send to a different set of people
 *      than the one that was approved.
 *   3. Insert the approval AS THE USER, so the database's owner check runs.
 *      A unique index allows exactly one live send per campaign, so two
 *      sessions confirming at once produce one send and one refusal.
 *   4. Freeze the audience into send_recipients.
 *   5. Hand it to the provider, keyed on the send's own id so a retry
 *      re-attaches rather than sends twice.
 *
 * A failure at any point after step 3 leaves a durable record of what was
 * approved, which is what makes the send resumable rather than lost.
 */

export type SendState = { error: string | null; sendId?: string }

export async function approveAndSend(
  _previous: SendState,
  formData: FormData,
): Promise<SendState> {
  const campaignId = formData.get('campaignId')?.toString()
  const approvedCount = Number.parseInt(formData.get('approvedCount')?.toString() ?? '', 10)

  if (!campaignId || Number.isNaN(approvedCount)) {
    return { error: 'That confirmation was incomplete. Open the campaign and try again.' }
  }

  // 1. The role check the database will also make.
  const brand = await requireOwner()
  const supabase = await createServerSupabaseClient()

  const { data: campaign, error: campaignError } = await supabase
    .from('campaigns')
    .select('id, external_id, name, channel')
    .eq('id', campaignId)
    .maybeSingle<{ id: string; external_id: string; name: string; channel: 'email' | 'sms' }>()

  // A campaign from another brand is simply not visible, so this is the same
  // answer as one that does not exist.
  if (campaignError || !campaign) {
    return { error: 'That campaign could not be found.' }
  }

  /*
   * 2. The count on the confirmation screen is what is being approved.
   *
   * Between rendering the preview and pressing confirm, someone may have
   * unsubscribed. Sending anyway would mean the marketer approved one number
   * and a different number went out. Refusing and showing the new figure is
   * the honest response, and it costs one extra click.
   */
  const currentCount = await countAudience(campaign.channel)
  if (currentCount !== approvedCount) {
    return {
      error:
        `The audience changed while you were reading: it is now ` +
        `${currentCount.toLocaleString('en')}, not ${approvedCount.toLocaleString('en')}. ` +
        `Nothing was sent. Review the new figure and confirm again.`,
    }
  }

  if (currentCount === 0) {
    return { error: 'There is nobody to send to. Nothing was sent.' }
  }

  /*
   * 3. The approval, written as the signed-in user so the owner policy runs.
   *
   * Deliberately NOT the admin client. Using the service role here would
   * bypass the very check the brief asks to be enforced, and the database
   * would happily record an analyst's approval.
   */
  const { data: send, error: insertError } = await supabase
    .from('campaign_sends')
    .insert({
      brand_id: brand.brandId,
      campaign_id: campaign.id,
      requested_by: brand.userId,
      requested_email: brand.email,
      approved_count: currentCount,
      status: 'approved',
    })
    .select('id')
    .single()

  if (insertError) {
    // 23505 is a unique violation: the one-live-send-per-campaign index. Two
    // sessions raced and this one lost, which is exactly the intended outcome.
    if (insertError.code === '23505') {
      return {
        error:
          'This campaign has already been sent. Nothing was sent a second time — ' +
          'open the campaign to see the existing send.',
      }
    }
    // 42501 is insufficient privilege: an analyst reached this far.
    if (insertError.code === '42501') {
      return { error: 'Only an owner can send a campaign. Nothing was sent.' }
    }
    return { error: `The send could not be approved: ${insertError.message}` }
  }

  await freezeAudienceAndDispatch({
    sendId: send.id,
    brandId: brand.brandId,
    brandCode: brand.brandCode,
    campaignId: campaign.id,
    campaignRef: campaign.external_id,
    channel: campaign.channel,
  })

  revalidatePath(`/portal/campaigns/${campaign.id}`)
  redirect(`/portal/sends/${send.id}`)
}
