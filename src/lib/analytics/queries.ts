import 'server-only'

import { cache } from 'react'
import { createServerSupabaseClient } from '@/lib/supabase/server'

/**
 * Every number the portal shows, and where it came from.
 *
 * The three bases are kept apart all the way from SQL to screen, because the
 * one thing this project must not do is present two different measurements as
 * though they were the same measurement. For campaign KAR-0001 the provider
 * reports 2,732 opens and the event log holds 704. Averaging those, or
 * silently preferring one, produces a number nobody can defend.
 */
export type Basis = 'provider' | 'log' | 'derived'

export const BASIS_LABEL: Record<Basis, string> = {
  provider: 'Provider-reported',
  log: 'Counted from the event log',
  derived: 'Derived by this portal',
}

export const BASIS_EXPLANATION: Record<Basis, string> = {
  provider:
    'Taken from the campaign export exactly as the messaging provider stated it. Never recalculated here.',
  log: 'Counted from the raw engagement log — one row per open, click, bounce, complaint or unsubscribe.',
  derived:
    'Worked out by this portal from customer records, using the rule shown beside the number.',
}

export type Contactability = {
  brand_id: string
  total: number
  removed: number
  no_consent: number
  status_unsubscribed: number
  status_bounced: number
  suppressed: number
  opted_out_in_log: number
  bounced_in_log: number
  contactable: number
  future_dated_signups: number
  latest_signup_at: string | null
}

export type SignupDay = { brand_id: string; day: string; signups: number }

export type CampaignPerformance = {
  campaign_id: string
  brand_id: string
  external_id: string
  name: string
  channel: 'email' | 'sms'
  sent_at: string | null
  send_local_time: string | null
  spend: number | null
  parent_external_id: string | null
  reported_sent: number | null
  reported_delivered: number | null
  reported_bounced: number | null
  reported_opens: number | null
  reported_clicks: number | null
  log_opens: number
  log_clicks: number
  log_bounces: number
  log_complaints: number
  log_unsubscribes: number
  log_total: number
  has_events: boolean
}

export type EngagementDetail = {
  people_opened: number
  people_clicked: number
  people_bounced: number
  people_unsubscribed: number
  people_complained: number
  people_engaged: number
  first_event_at: string | null
  last_event_at: string | null
}

/*
 * Each of these calls a SECURITY INVOKER function, so the policies on
 * contacts, campaigns and contact_events apply to the caller. None of them
 * passes a brand id: there is nothing to pass, because the database already
 * knows which brand is asking. A brand filter here would be a filter that
 * could be forgotten.
 */

export const getContactability = cache(async (): Promise<Contactability | null> => {
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.rpc('contactability_breakdown')
  if (error) throw new Error(`contactability_breakdown: ${error.message}`)
  return (data as Contactability[])?.[0] ?? null
})

export const getSignupsPerDay = cache(async (windowDays = 30): Promise<SignupDay[]> => {
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.rpc('signups_per_day', { window_days: windowDays })
  if (error) throw new Error(`signups_per_day: ${error.message}`)
  return (data as SignupDay[]) ?? []
})

export const getCampaignPerformance = cache(async (): Promise<CampaignPerformance[]> => {
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.rpc('campaign_performance')
  if (error) throw new Error(`campaign_performance: ${error.message}`)

  const rows = (data as CampaignPerformance[]) ?? []
  return rows.sort((a, b) => (b.sent_at ?? '').localeCompare(a.sent_at ?? ''))
})

export const getEngagementDetail = cache(async (campaignId: string): Promise<EngagementDetail | null> => {
  const supabase = await createServerSupabaseClient()
  const { data, error } = await supabase.rpc('campaign_engagement_detail', {
    target_campaign_id: campaignId,
  })
  if (error) throw new Error(`campaign_engagement_detail: ${error.message}`)
  return (data as EngagementDetail[])?.[0] ?? null
})

/**
 * A rate, or null when the denominator makes it meaningless.
 *
 * Returning null rather than 0 matters: a campaign with nothing delivered has
 * no open rate, and printing "0%" would state a fact that was never measured.
 */
export function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null
  return numerator / denominator
}

export function formatPercent(value: number | null): string {
  if (value === null) return '—'
  return `${(value * 100).toFixed(1)}%`
}

export function formatCount(value: number | null): string {
  if (value === null) return '—'
  return value.toLocaleString('en')
}
