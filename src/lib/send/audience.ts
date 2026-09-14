import 'server-only'

import { cache } from 'react'
import { createServerSupabaseClient } from '@/lib/supabase/server'

/**
 * Who a campaign goes to.
 *
 * One definition, used by the preview, by the count on the confirmation
 * screen, and by the list that is actually frozen at approval. If the preview
 * and the send used different rules, the number the marketer approved would
 * not be the number of people who received it — which is the specific failure
 * the brief calls out.
 */

export type AudienceMember = {
  contact_id: string
  external_id: string
  full_name: string | null
  destination: string
}

/**
 * The rule, in words, so the screen can state it rather than imply it.
 */
export const AUDIENCE_RULE = [
  'has given marketing consent',
  'has not been removed from the list',
  'is not currently suppressed',
  'has no unsubscribe, complaint or bounce in the event log',
  'has an address for this campaign’s channel',
] as const

/**
 * Applies the contactability rule plus the channel requirement.
 *
 * The channel clause is the part people forget: an email campaign cannot go to
 * someone with only a phone number, however contactable they are. Counting
 * them would inflate the approved number and then quietly send to fewer
 * people — a half-send that looks like a success.
 */
function contactableQuery(
  supabase: Awaited<ReturnType<typeof createServerSupabaseClient>>,
  channel: 'email' | 'sms',
  columns: string,
) {
  const destinationColumn = channel === 'email' ? 'email' : 'phone_e164'

  return supabase
    .from('contacts')
    .select(columns, { count: 'exact' })
    .is('deleted_at', null)
    .eq('consent_marketing', true)
    .not('status', 'in', '("unsubscribed","bounced")')
    .is('opted_out_at', null)
    .is('bounced_at', null)
    .or(`suppressed_until.is.null,suppressed_until.lte.${new Date().toISOString()}`)
    .not(destinationColumn, 'is', null)
}

/**
 * How many people this campaign would reach, right now.
 *
 * Deliberately a count rather than a list: the preview screen shows a number
 * and a sample, and reading 36,185 rows to display one number would make the
 * biggest brand the slowest to confirm.
 */
export const countAudience = cache(async (channel: 'email' | 'sms'): Promise<number> => {
  const supabase = await createServerSupabaseClient()
  const { count, error } = await contactableQuery(supabase, channel, 'id').limit(0)

  if (error) throw new Error(`audience count: ${error.message}`)
  return count ?? 0
})

/** A handful of real recipients, so the marketer can see who this is. */
export const sampleAudience = cache(
  async (channel: 'email' | 'sms', size = 5): Promise<AudienceMember[]> => {
    const supabase = await createServerSupabaseClient()
    const destinationColumn = channel === 'email' ? 'email' : 'phone_e164'

    const { data, error } = await contactableQuery(
      supabase,
      channel,
      `id, external_id, full_name, ${destinationColumn}`,
    )
      .order('external_id', { ascending: true })
      .limit(size)

    if (error) throw new Error(`audience sample: ${error.message}`)

    return (data ?? []).map((row) => {
      const record = row as unknown as Record<string, string | null>
      return {
        contact_id: record.id!,
        external_id: record.external_id!,
        full_name: record.full_name,
        destination: record[destinationColumn] ?? '',
      }
    })
  },
)
