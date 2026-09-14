import type { CsvRow } from '@/lib/import/dialect'
import {
  normaliseChannel,
  normaliseConsent,
  normaliseCountry,
  normaliseEmail,
  normaliseEventType,
  normalisePhone,
  normaliseStatus,
  parseDecimal,
  parseInteger,
  parseTimestamp,
  type Channel,
  type ContactStatus,
  type EventType,
  type Note,
  type Outcome,
} from '@/lib/import/normalise'

/**
 * One CSV row in, one database row out — or a refusal with a reason.
 *
 * Kept apart from both the file reading and the database writing so the rules
 * can be tested as pure functions against real rows.
 */

export type BrandInfo = { id: string; code: string; countryCode: string }

export type Mapped<T> =
  | { ok: true; record: T; notes: Note[] }
  | { ok: false; note: Note; notes: Note[] }

/** Collects warnings while short-circuiting on the first genuine refusal. */
class Collector {
  readonly notes: Note[] = []

  /** Unwraps an outcome, recording any warning; returns undefined if refused. */
  take<T>(outcome: Outcome<T>): T | undefined {
    if (outcome.ok) {
      if (outcome.note) this.notes.push(outcome.note)
      return outcome.value
    }
    this.notes.push(outcome.note)
    return undefined
  }
}

const text = (value: string | undefined): string | null => {
  const trimmed = (value ?? '').trim()
  return trimmed === '' ? null : trimmed
}

/**
 * A header line repeated in the middle of the file.
 *
 * The Kilele export contains one. Without this check it becomes a customer
 * called "full_name" whose status is "status", which then fails four separate
 * validations and produces four confusing report lines instead of one clear
 * one.
 */
function isRepeatedHeader(row: CsvRow, idField: string): boolean {
  return row.values[idField]?.trim().toLowerCase() === idField
}

/**
 * A NUL byte anywhere in the row.
 *
 * PostgreSQL cannot store `0x00` in a text column at all — it is not a
 * character, it is a string terminator that has escaped into the data — so
 * without this check the whole import dies part-way through with
 * "invalid byte sequence for encoding UTF8", which says nothing about which
 * row or which file.
 *
 * The row is refused rather than cleaned. Three contacts in the Kilele export
 * carry one, inside the name field; stripping the byte would quietly rewrite
 * somebody's name to something nobody chose, and a name is not ours to edit.
 */
const NUL = String.fromCharCode(0)

function hasNulByte(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) === 0) return true
  }
  return false
}

function findNulByte(values: Record<string, string>): { field: string; value: string } | null {
  for (const [field, value] of Object.entries(values)) {
    if (typeof value === 'string' && hasNulByte(value)) return { field, value }
  }
  return null
}

function nulByteNote(found: { field: string; value: string }): Note {
  return {
    reasonCode: 'nul_byte',
    reason: `The "${found.field}" field contains a NUL byte, which is not text and cannot be stored. The row was left out rather than silently altered.`,
    field: found.field,
    value: found.value.split(NUL).join('<NUL>'),
  }
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export type ContactRecord = {
  external_id: string
  full_name: string | null
  email: string | null
  phone_raw: string | null
  phone_e164: string | null
  country_code: string | null
  city: string | null
  signup_at: Date | null
  status: ContactStatus
  consent_marketing: boolean
  deleted_at: Date | null
  suppressed_until: Date | null
  notes: string | null
  source_file: string
}

export function mapContact(row: CsvRow, brand: BrandInfo, sourceFile: string): Mapped<ContactRecord> {
  const collector = new Collector()
  const values = row.values

  const refuse = (note: Note): Mapped<ContactRecord> => ({ ok: false, note, notes: collector.notes })

  if (isRepeatedHeader(row, 'external_id')) {
    return refuse({
      reasonCode: 'repeated_header_row',
      reason: 'The column headings appear again part-way through the file; this line is not a customer.',
      value: null,
    })
  }

  const nul = findNulByte(values)
  if (nul) return refuse(nulByteNote(nul))

  const externalId = text(values.external_id)
  if (!externalId) {
    return refuse({
      reasonCode: 'external_id_missing',
      reason: 'The row has no customer reference, so it cannot be matched or updated later.',
      field: 'external_id',
      value: values.external_id ?? null,
    })
  }

  /*
   * The brand column, not the filename, decides which brand a row belongs to —
   * and a row claiming a different brand is refused rather than re-routed.
   *
   * This is not hypothetical: 312 rows in the Kilele export say KAROO, and 88
   * rows in the Karoo export say KILELE. Importing them where the filename
   * says would put one brand's customers inside another, which is the exact
   * thing the whole project guarantees against. Quietly moving them to the
   * brand they name would be kinder but no safer — an export for one brand has
   * no business creating rows in another, and a marketer who sees the count
   * can go and ask why their export is contaminated.
   */
  const declaredBrand = text(values.brand_code)
  if (declaredBrand && declaredBrand.toUpperCase() !== brand.code) {
    return refuse({
      reasonCode: 'wrong_brand',
      reason: `This row says it belongs to ${declaredBrand.toUpperCase()}, but it is in the ${brand.code} export. It was not imported into either brand.`,
      field: 'brand_code',
      value: declaredBrand,
    })
  }

  const status = collector.take(normaliseStatus(values.status))
  if (status === undefined) {
    return refuse(collector.notes[collector.notes.length - 1])
  }

  const consent = collector.take(normaliseConsent(values.consent_marketing))
  if (consent === undefined) {
    return refuse(collector.notes[collector.notes.length - 1])
  }

  const signupAt = collector.take(parseTimestamp(values.signup_at))
  if (signupAt === undefined) {
    return refuse(collector.notes[collector.notes.length - 1])
  }

  const deletedAt = collector.take(parseTimestamp(values.deleted_at))
  if (deletedAt === undefined) {
    return refuse(collector.notes[collector.notes.length - 1])
  }

  const suppressedUntil = collector.take(parseTimestamp(values.suppressed_until))
  if (suppressedUntil === undefined) {
    return refuse(collector.notes[collector.notes.length - 1])
  }

  const email = collector.take(normaliseEmail(values.email)) ?? null
  const phoneE164 = collector.take(normalisePhone(values.phone, brand.countryCode)) ?? null
  const country = collector.take(normaliseCountry(values.country)) ?? null

  /*
   * Neither a usable address nor a usable number means there is no way to
   * reach this person on any channel. The database refuses such a row too
   * (contacts_reachable_check), so this is the importer explaining in advance
   * what the constraint would otherwise say in Latin.
   */
  if (!email && !phoneE164) {
    return refuse({
      reasonCode: 'unreachable',
      reason: 'Neither a usable email address nor a usable phone number, so this customer cannot be contacted on any channel.',
      value: `${values.email ?? ''} / ${values.phone ?? ''}`,
    })
  }

  return {
    ok: true,
    notes: collector.notes,
    record: {
      external_id: externalId,
      full_name: text(values.full_name),
      email,
      phone_raw: text(values.phone),
      phone_e164: phoneE164,
      country_code: country,
      city: text(values.city),
      signup_at: signupAt,
      status,
      consent_marketing: consent,
      deleted_at: deletedAt,
      suppressed_until: suppressedUntil,
      notes: text(values.notes),
      source_file: sourceFile,
    },
  }
}

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

export type CampaignRecord = {
  external_id: string
  name: string
  channel: Channel
  target_country_code: string | null
  reported_sent: number | null
  reported_delivered: number | null
  reported_bounced: number | null
  reported_opens: number | null
  reported_clicks: number | null
  spend: number | null
  sent_at: Date | null
  send_local_time: string | null
  parent_external_id: string | null
}

export function mapCampaign(row: CsvRow): Mapped<CampaignRecord> {
  const collector = new Collector()
  const values = row.values
  const refuse = (note: Note): Mapped<CampaignRecord> => ({ ok: false, note, notes: collector.notes })

  if (isRepeatedHeader(row, 'external_id')) {
    return refuse({
      reasonCode: 'repeated_header_row',
      reason: 'The column headings appear again part-way through the file; this line is not a campaign.',
      value: null,
    })
  }

  const nul = findNulByte(values)
  if (nul) return refuse(nulByteNote(nul))

  const externalId = text(values.external_id)
  if (!externalId) {
    return refuse({
      reasonCode: 'external_id_missing',
      reason: 'The row has no campaign reference.',
      field: 'external_id',
      value: values.external_id ?? null,
    })
  }

  const channel = collector.take(normaliseChannel(values.channel))
  if (channel === undefined) return refuse(collector.notes[collector.notes.length - 1])

  const sentAt = collector.take(parseTimestamp(values.sent_at))
  if (sentAt === undefined) return refuse(collector.notes[collector.notes.length - 1])

  const counts: Record<string, number | null> = {}
  for (const field of ['reported_sent', 'reported_delivered', 'reported_bounced', 'reported_opens', 'reported_clicks']) {
    const parsed = collector.take(parseInteger(values[field]))
    if (parsed === undefined) return refuse(collector.notes[collector.notes.length - 1])
    counts[field] = parsed
  }

  const spend = collector.take(parseDecimal(values.spend))
  if (spend === undefined) return refuse(collector.notes[collector.notes.length - 1])

  const targetCountry = collector.take(normaliseCountry(values.target_country_code)) ?? null

  return {
    ok: true,
    notes: collector.notes,
    record: {
      external_id: externalId,
      name: text(values.name) ?? externalId,
      channel,
      target_country_code: targetCountry,
      reported_sent: counts.reported_sent,
      reported_delivered: counts.reported_delivered,
      reported_bounced: counts.reported_bounced,
      reported_opens: counts.reported_opens,
      reported_clicks: counts.reported_clicks,
      spend,
      sent_at: sentAt,
      send_local_time: text(values.send_local_time),
      parent_external_id: text(values.parent_campaign_id),
    },
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventRecord = {
  external_id: string
  contact_external_id: string
  campaign_external_id: string | null
  event_type: EventType
  channel: Channel
  occurred_at: Date
}

export function mapEvent(row: CsvRow): Mapped<EventRecord> {
  const collector = new Collector()
  const values = row.values
  const refuse = (note: Note): Mapped<EventRecord> => ({ ok: false, note, notes: collector.notes })

  if (isRepeatedHeader(row, 'event_id')) {
    return refuse({
      reasonCode: 'repeated_header_row',
      reason: 'The column headings appear again part-way through the file; this line is not a result.',
      value: null,
    })
  }

  const nul = findNulByte(values)
  if (nul) return refuse(nulByteNote(nul))

  const externalId = text(values.event_id)
  if (!externalId) {
    return refuse({
      reasonCode: 'external_id_missing',
      reason: 'The result has no reference of its own, so a repeat of this file could not be recognised as the same result.',
      field: 'event_id',
      value: values.event_id ?? null,
    })
  }

  const contactExternalId = text(values.external_contact_id)
  if (!contactExternalId) {
    return refuse({
      reasonCode: 'contact_reference_missing',
      reason: 'The result does not say which customer it belongs to.',
      field: 'external_contact_id',
      value: values.external_contact_id ?? null,
    })
  }

  const eventType = collector.take(normaliseEventType(values.event_type))
  if (eventType === undefined) return refuse(collector.notes[collector.notes.length - 1])

  const channel = collector.take(normaliseChannel(values.channel))
  if (channel === undefined) return refuse(collector.notes[collector.notes.length - 1])

  const occurredAt = collector.take(parseTimestamp(values.occurred_at))
  if (occurredAt === undefined) return refuse(collector.notes[collector.notes.length - 1])

  if (occurredAt === null) {
    return refuse({
      reasonCode: 'occurred_at_missing',
      reason: 'The result has no date, and a result that cannot be placed in time cannot be applied in the right order.',
      field: 'occurred_at',
      value: values.occurred_at ?? null,
    })
  }

  return {
    ok: true,
    notes: collector.notes,
    record: {
      external_id: externalId,
      contact_external_id: contactExternalId,
      campaign_external_id: text(values.campaign_external_id),
      event_type: eventType,
      channel,
      occurred_at: occurredAt,
    },
  }
}
