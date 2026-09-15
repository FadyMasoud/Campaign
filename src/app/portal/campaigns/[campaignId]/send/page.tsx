import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireBrand } from '@/lib/auth/dal'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import { AUDIENCE_RULE, countAudience, sampleAudience } from '@/lib/send/audience'
import { SendConfirmation } from './confirm'
import styles from './send.module.css'

export const metadata: Metadata = { title: 'Send campaign · Campaign Portal' }
export const dynamic = 'force-dynamic'

/**
 * The confirmation screen, laid out as the three things a person needs to
 * decide: who it goes to, how many that is, and whether to proceed.
 *
 * The number shown here is the number that will be approved, and the server
 * re-checks it at the moment of confirming — if the audience has moved,
 * nothing is sent and the new figure is shown.
 */
export default async function SendPage({
  params,
}: {
  params: Promise<{ campaignId: string }>
}) {
  const brand = await requireBrand()
  const { campaignId } = await params
  const supabase = await createServerSupabaseClient()

  const { data: campaign } = await supabase
    .from('campaigns')
    .select('id, external_id, name, channel')
    .eq('id', campaignId)
    .maybeSingle<{ id: string; external_id: string; name: string; channel: 'email' | 'sms' }>()

  if (!campaign) notFound()

  // An analyst who types the URL gets a plain answer. The database refuses the
  // write as well; this is only the courteous version of the same refusal.
  if (brand.role !== 'owner') {
    return (
      <main className={styles.page}>
        <p className={styles.breadcrumb}>
          <Link href={`/portal/campaigns/${campaign.id}`} className={styles.link}>
            ← {campaign.name}
          </Link>
        </p>
        <div className={styles.refusal}>
          <h1 className={styles.refusalTitle}>Only an owner can send</h1>
          <p className={styles.refusalBody}>
            This account is an analyst, which is read-only. Nothing has been
            sent. The database refuses the write too, so this is not something a
            different route could get around.
          </p>
          <Link href={`/portal/campaigns/${campaign.id}`} className={styles.backButton}>
            Back to the campaign
          </Link>
        </div>
      </main>
    )
  }

  // Already sent? Show the record instead of offering a second confirmation.
  const { data: existing } = await supabase
    .from('campaign_sends')
    .select('id')
    .eq('campaign_id', campaign.id)
    .neq('status', 'failed')
    .maybeSingle<{ id: string }>()

  if (existing) redirect(`/portal/sends/${existing.id}`)

  const [audienceCount, sample] = await Promise.all([
    countAudience(campaign.channel),
    sampleAudience(campaign.channel, 5),
  ])

  return (
    <main className={styles.page}>
      <p className={styles.breadcrumb}>
        <Link href={`/portal/campaigns/${campaign.id}`} className={styles.link}>
          ← {campaign.name}
        </Link>
      </p>

      <h1 className={styles.title}>Send this campaign</h1>
      <p className={styles.lede}>
        {campaign.name} ({campaign.external_id}) will go out by{' '}
        <strong>{campaign.channel === 'email' ? 'email' : 'SMS'}</strong>.
        Nothing is sent until you confirm.
      </p>

      {/* --- 1 · how many ------------------------------------------------- */}
      <section className={styles.step} aria-labelledby="count">
        <div className={styles.stepHead}>
          <span className={styles.stepNumber}>1</span>
          <h2 id="count" className={styles.stepTitle}>How many people</h2>
        </div>

        <p className={styles.count}>{audienceCount.toLocaleString('en')}</p>
        <p className={styles.countNote}>
          This is the number you are approving. It is checked again the moment
          you confirm — if it has changed, nothing is sent and you are shown the
          new figure.
        </p>
      </section>

      {/* --- 2 · who --------------------------------------------------------- */}
      <section className={styles.step} aria-labelledby="who">
        <div className={styles.stepHead}>
          <span className={styles.stepNumber}>2</span>
          <h2 id="who" className={styles.stepTitle}>Who they are</h2>
        </div>

        <p className={styles.ruleIntro}>Everyone in {brand.brandName} who:</p>
        <ul className={styles.rule}>
          {AUDIENCE_RULE.map((clause) => (
            <li key={clause} className={styles.ruleItem}>{clause}</li>
          ))}
        </ul>

        {sample.length > 0 ? (
          <>
            <p className={styles.sampleIntro}>
              The first {sample.length}, so you can see this is real:
            </p>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Customer</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Goes to</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((person) => (
                  <tr key={person.contact_id}>
                    <td>{person.full_name ?? 'Unnamed'}</td>
                    <td className={styles.mono}>{person.external_id}</td>
                    <td className={styles.mono}>{person.destination}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : null}
      </section>

      {/* --- 3 · confirm ----------------------------------------------------- */}
      {audienceCount === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>There is nobody to send to</p>
          <p className={styles.emptyBody}>
            No customer in {brand.brandName} both consents to marketing and has
            an {campaign.channel === 'email' ? 'email address' : 'SMS number'} on
            record. Nothing can be sent.
          </p>
        </div>
      ) : (
        <section className={styles.stepFinal} aria-labelledby="confirm">
          <div className={styles.stepHead}>
            <span className={styles.stepNumberFinal}>3</span>
            <h2 id="confirm" className={styles.stepTitle}>Confirm</h2>
          </div>

          <SendConfirmation
            campaignId={campaign.id}
            campaignName={campaign.name}
            approvedCount={audienceCount}
          />
        </section>
      )}
    </main>
  )
}
