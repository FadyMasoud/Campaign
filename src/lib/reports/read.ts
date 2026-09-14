import 'server-only'

import { cache } from 'react'
import { createAdminSupabaseClient } from '@/lib/supabase/admin'

/**
 * Reading one shared report, under the service role.
 *
 * The admin client is used because the reader has no account — but that means
 * Row Level Security is switched off for this query, so everything below is
 * scoped by hand and scoped narrowly. The token identifies exactly one report,
 * which identifies exactly one campaign, and nothing here takes a campaign or
 * brand id from anywhere else. There is no parameter a reader could change to
 * see something different.
 *
 * What comes back is aggregates only. No customer rows, no addresses, no other
 * campaign, no brand-wide totals — because the promise is that this link is
 * safe to send to a stranger, and a stranger should learn one campaign's
 * results and nothing about the business behind it.
 */

export type PublicReport = {
  brandName: string
  timezone: string
  campaignName: string
  campaignRef: string
  channel: 'email' | 'sms'
  sentAt: string | null
  reportedSent: number | null
  reportedDelivered: number | null
  reportedBounced: number | null
  reportedOpens: number | null
  reportedClicks: number | null
  logOpens: number
  logClicks: number
  logUnsubscribes: number
  peopleOpened: number
  peopleClicked: number
  hasEvents: boolean
  publishedAt: string
}

export const readSharedReport = cache(async (token: string): Promise<PublicReport | null> => {
  const admin = createAdminSupabaseClient()

  const { data: report } = await admin
    .from('shared_reports')
    .select('brand_id, campaign_id, created_at')
    .eq('token', token)
    .is('revoked_at', null) // a withdrawn link is as good as one that never existed
    .maybeSingle<{ brand_id: string; campaign_id: string; created_at: string }>()

  if (!report) return null

  const [{ data: campaign }, { data: brand }, { data: detail }] = await Promise.all([
    admin
      .from('campaigns')
      .select(
        'external_id, name, channel, sent_at, reported_sent, reported_delivered, reported_bounced, reported_opens, reported_clicks',
      )
      .eq('id', report.campaign_id)
      .eq('brand_id', report.brand_id)
      .maybeSingle(),
    admin.from('brands').select('name, timezone').eq('id', report.brand_id).maybeSingle(),
    admin.rpc('campaign_engagement_detail', { target_campaign_id: report.campaign_id }),
  ])

  if (!campaign || !brand) return null

  // Counted here rather than through campaign_performance(), which returns
  // every campaign in the brand — far more than this page is allowed to know.
  const eventCount = async (type: string) => {
    const { count } = await admin
      .from('contact_events')
      .select('*', { count: 'exact', head: true })
      .eq('brand_id', report.brand_id)
      .eq('campaign_id', report.campaign_id)
      .eq('event_type', type)
    return count ?? 0
  }

  const [logOpens, logClicks, logUnsubscribes] = await Promise.all([
    eventCount('open'),
    eventCount('click'),
    eventCount('unsubscribe'),
  ])

  const engagement = (detail as Array<{ people_opened: number; people_clicked: number }>)?.[0]

  return {
    brandName: brand.name as string,
    timezone: brand.timezone as string,
    campaignName: campaign.name as string,
    campaignRef: campaign.external_id as string,
    channel: campaign.channel as 'email' | 'sms',
    sentAt: campaign.sent_at as string | null,
    reportedSent: campaign.reported_sent as number | null,
    reportedDelivered: campaign.reported_delivered as number | null,
    reportedBounced: campaign.reported_bounced as number | null,
    reportedOpens: campaign.reported_opens as number | null,
    reportedClicks: campaign.reported_clicks as number | null,
    logOpens,
    logClicks,
    logUnsubscribes,
    peopleOpened: engagement?.people_opened ?? 0,
    peopleClicked: engagement?.people_clicked ?? 0,
    hasEvents: logOpens + logClicks + logUnsubscribes > 0,
    publishedAt: report.created_at,
  }
})
