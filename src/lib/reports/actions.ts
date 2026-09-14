'use server'

import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireOwner } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'
import { grantCookieName, issueGrant, newReportToken } from '@/lib/reports/session'

/**
 * Publishing a campaign's results, and opening one.
 */

export type PublishState = {
  error: string | null
  token?: string
  password?: string
}

export type UnlockState = { error: string | null }

/*
 * Long enough to be worth having, short enough to read down a phone. The
 * password is the second factor behind an already-unguessable token, so its
 * job is to stop someone who has been forwarded the link, not to withstand an
 * offline attack — which bcrypt handles anyway.
 */
const passwordSchema = z
  .string()
  .min(8, 'Use at least 8 characters.')
  .max(128, 'That is longer than anyone will type.')

export async function publishReport(
  _previous: PublishState,
  formData: FormData,
): Promise<PublishState> {
  const campaignId = formData.get('campaignId')?.toString()
  const parsed = passwordSchema.safeParse(formData.get('password')?.toString() ?? '')

  if (!campaignId) return { error: 'No campaign was named.' }
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Choose a password.' }

  const brand = await requireOwner()
  const supabase = await createServerSupabaseClient()

  // Invisible if it belongs to another brand, so this is the same answer as a
  // campaign that does not exist.
  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id')
    .eq('id', campaignId)
    .maybeSingle<{ id: string }>()

  if (!campaign) return { error: 'That campaign could not be found.' }

  // Hashed in the database, so the plain password never reaches a column and
  // never leaves this request.
  const { data: hash, error: hashError } = await supabase.rpc('hash_report_password', {
    plain: parsed.data,
  })

  if (hashError || !hash) return { error: 'The password could not be set.' }

  const token = newReportToken()

  /*
   * Inserted as the USER, not as admin, so the owner policy runs. An analyst
   * reaching this line is refused by the database rather than by this code.
   */
  const { error: insertError } = await supabase.from('shared_reports').insert({
    brand_id: brand.brandId,
    campaign_id: campaign.id,
    token,
    password_hash: hash as string,
    created_by: brand.userId,
    created_email: brand.email,
  })

  if (insertError) {
    if (insertError.code === '42501') {
      return { error: 'Only an owner can publish results. Nothing was published.' }
    }
    return { error: `The link could not be created: ${insertError.message}` }
  }

  revalidatePath(`/portal/campaigns/${campaign.id}`)

  /*
   * The password is returned once, here, and never again. It is not stored in
   * a readable form, so this is the only moment it can be shown — which is
   * stated on screen rather than left for someone to discover.
   */
  return { error: null, token, password: parsed.data }
}

export async function revokeReport(formData: FormData): Promise<void> {
  const reportId = formData.get('reportId')?.toString()
  const campaignId = formData.get('campaignId')?.toString()
  if (!reportId) return

  const brand = await requireOwner()

  /*
   * Revoking is an update, and users are granted insert and select only —
   * deliberately, so a published report cannot be quietly edited. The
   * withdrawal therefore runs under the service role, after the ownership
   * check above, and names both the report and the brand so it cannot reach
   * another tenant's row.
   */
  const admin = createAdminSupabaseClient()
  await admin
    .from('shared_reports')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', reportId)
    .eq('brand_id', brand.brandId)

  if (campaignId) revalidatePath(`/portal/campaigns/${campaignId}`)
}

/**
 * The password form on the public page.
 *
 * The token comes from the URL and the password from the form; both are
 * handed to the database, which answers only whether the door opened. Nothing
 * about the report is read here, so a wrong answer reveals nothing — including
 * whether the token exists at all.
 */
export async function unlockReport(
  _previous: UnlockState,
  formData: FormData,
): Promise<UnlockState> {
  const token = formData.get('token')?.toString() ?? ''
  const attempt = formData.get('password')?.toString() ?? ''

  if (!token || !attempt) return { error: 'Enter the password you were given.' }

  const admin = createAdminSupabaseClient()
  const { data, error } = await admin.rpc('unlock_shared_report', {
    report_token: token,
    attempt,
  })

  if (error) return { error: 'That could not be checked. Try again shortly.' }

  if (data === 'locked') {
    return {
      error: 'Too many attempts. This report is locked for fifteen minutes.',
    }
  }

  if (data !== 'ok') {
    // Deliberately the same message whether the token is unknown, withdrawn,
    // or simply has a different password.
    return { error: 'That password is not right for this report.' }
  }

  const grant = issueGrant(token)
  const store = await cookies()

  store.set(grantCookieName(token), grant.value, {
    httpOnly: true, // the page's own JavaScript must not be able to read it
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: `/r/${token}`, // scoped to this report and no other
    maxAge: grant.maxAge,
  })

  return { error: null }
}
