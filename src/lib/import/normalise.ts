/**
 * Turning what the exports actually contain into what the database accepts.
 *
 * Every mapping here was derived by counting the distinct values in the three
 * exports, not by imagining what a CSV might hold. Where a value cannot be
 * mapped, these functions say so rather than guessing — the importer then
 * records it against the row and the line it came from, so the marketer can
 * see what did not arrive and why.
 *
 * Pure functions with no I/O, so they are unit-tested directly against the
 * real values found in the files. See tests/normalise.test.ts.
 */

export type Note = {
  reasonCode: string
  reason: string
  field?: string
  value?: string | null
}

/**
 * The result of normalising one field.
 *
 * `ok: false` means the row cannot be stored. `ok: true` with a `note` means
 * it can, but something was dropped or assumed and the marketer should be
 * told. Keeping those two apart is the whole point: a report that files 1,470
 * unusable addresses under the same heading as 10,151 blank consent fields
 * tells nobody anything.
 */
export type Outcome<T> = { ok: true; value: T; note?: Note } | { ok: false; note: Note }

const ok = <T>(value: T, note?: Note): Outcome<T> => (note ? { ok: true, value, note } : { ok: true, value })
const rejected = (note: Note): Outcome<never> => ({ ok: false, note })

/** Trim, and treat the many spellings of "nothing here" as nothing. */
const blank = (raw: string | null | undefined): boolean => {
  if (raw === null || raw === undefined) return true
  const t = raw.trim()
  return t === '' || PLACEHOLDERS.has(t.toUpperCase())
}

/**
 * Values that mean "no value", collected from the exports. `\N` is what a
 * PostgreSQL COPY writes for null; `NULL`, `N/A` and `-` are what a
 * spreadsheet writes; `ZZ` is the ISO code reserved for "unknown".
 */
const PLACEHOLDERS = new Set(['NULL', 'NONE', 'N/A', 'NA', '-', '\\N', 'ZZ', 'UNKNOWN'])

// ---------------------------------------------------------------------------
// Contact status
// ---------------------------------------------------------------------------

export type ContactStatus = 'active' | 'pending' | 'unsubscribed' | 'bounced'

/**
 * Eleven spellings across the exports collapse to four states. The variants
 * are case and trailing whitespace — 'ACTIVE', 'Active', 'active ' — plus one
 * genuine synonym, 'unsubscribe' for 'unsubscribed'.
 *
 * A missing status is REJECTED rather than defaulted. Every number the portal
 * shows — who is contactable, how many unsubscribed — is a count of these
 * values, so guessing one would quietly move 24 people into a bucket they may
 * not belong in. Refusing the row and naming it in the report lets someone fix
 * the export instead.
 */
const STATUS_MAP: Record<string, ContactStatus> = {
  active: 'active',
  pending: 'pending',
  bounced: 'bounced',
  unsubscribed: 'unsubscribed',
  unsubscribe: 'unsubscribed',
}

export function normaliseStatus(raw: string | null | undefined): Outcome<ContactStatus> {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return rejected({
      reasonCode: 'status_missing',
      reason: 'The customer status is blank, and every count on the portal depends on it.',
      field: 'status',
      value: raw ?? null,
    })
  }

  const mapped = STATUS_MAP[raw.trim().toLowerCase()]
  if (mapped) return ok(mapped)

  return rejected({
    reasonCode: 'status_unknown',
    reason: `"${raw.trim()}" is not a customer status. Expected active, pending, bounced or unsubscribed.`,
    field: 'status',
    value: raw,
  })
}

// ---------------------------------------------------------------------------
// Marketing consent
// ---------------------------------------------------------------------------

const CONSENT_TRUE = new Set(['true', 't', 'yes', 'y', '1'])
const CONSENT_FALSE = new Set(['false', 'f', 'no', 'n', '0'])

/**
 * Eleven spellings of a boolean, and 10,151 rows where it is simply blank.
 *
 * Blank becomes FALSE, deliberately and asymmetrically. This is the one place
 * a default is safer than a rejection: consent is permission to contact
 * someone, so the absence of a recorded yes has to read as no. Defaulting the
 * other way would add ten thousand people to a send that nobody agreed to.
 * The assumption is reported as a warning rather than applied silently.
 */
export function normaliseConsent(raw: string | null | undefined): Outcome<boolean> {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return ok(false, {
      reasonCode: 'consent_absent',
      reason: 'No marketing consent was recorded, so it is treated as "no".',
      field: 'consent_marketing',
      value: raw ?? null,
    })
  }

  const value = raw.trim().toLowerCase()
  if (CONSENT_TRUE.has(value)) return ok(true)
  if (CONSENT_FALSE.has(value)) return ok(false)

  return rejected({
    reasonCode: 'consent_unreadable',
    reason: `"${raw.trim()}" is not a yes or a no, and consent is not something to guess at.`,
    field: 'consent_marketing',
    value: raw,
  })
}

// ---------------------------------------------------------------------------
// Country
// ---------------------------------------------------------------------------

/**
 * The exports mix ISO-2 codes with ISO-3, full names, and — in 510 rows — the
 * international dialling prefix in the country column.
 */
const COUNTRY_ALIASES: Record<string, string> = {
  KEN: 'KE', KENYA: 'KE', '254': 'KE',
  ZAF: 'ZA', 'SOUTH AFRICA': 'ZA', '27': 'ZA',
  MAR: 'MA', MOROCCO: 'MA', '212': 'MA',
  UGA: 'UG', TZA: 'TZ', RWA: 'RW', ETH: 'ET', SSD: 'SS',
}

/**
 * Returns null for anything unrecognisable rather than refusing the row: a
 * customer with an unreadable country is still a customer, and the country is
 * used for presentation, not for deciding who gets contacted.
 */
export function normaliseCountry(raw: string | null | undefined): Outcome<string | null> {
  if (blank(raw)) {
    return ok(null)
  }

  const value = raw!.trim().toUpperCase()

  if (/^[A-Z]{2}$/.test(value)) return ok(value)

  const alias = COUNTRY_ALIASES[value]
  if (alias) return ok(alias)

  return ok(null, {
    reasonCode: 'country_unreadable',
    reason: `"${raw!.trim()}" is not a country code; the country was left empty.`,
    field: 'country',
    value: raw ?? null,
  })
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/*
 * Deliberately strict rather than clever. It rejects the four shapes the
 * exports actually contain — an internal space, a missing @, a doubled @, a
 * missing top-level domain — without trying to repair any of them.
 *
 * Repair was considered and refused. Lowercasing and trimming are
 * normalisation: the same address written differently. Deleting a space from
 * "john doe@vg-eval.test" is a guess about who that person is, and sending
 * mail to a guessed address is worse than sending none.
 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

export function normaliseEmail(raw: string | null | undefined): Outcome<string | null> {
  if (blank(raw)) return ok(null)

  const value = raw!.trim().toLowerCase()
  if (EMAIL_PATTERN.test(value)) return ok(value)

  return ok(null, {
    reasonCode: 'email_invalid',
    reason: `"${raw!.trim()}" is not a usable email address, so it was not stored.`,
    field: 'email',
    value: raw ?? null,
  })
}

// ---------------------------------------------------------------------------
// Phone
// ---------------------------------------------------------------------------

/**
 * The numbering plan for each market this portal serves.
 *
 * `nationalDigits` is what makes this safe. Kenya, South Africa and Morocco
 * all use nine significant digits after the country code, so a candidate that
 * does not come to exactly nine is not a number that was written oddly — it is
 * a number that is wrong, and no amount of prefixing will fix it.
 */
const NUMBER_PLAN: Record<string, { code: string; nationalDigits: number }> = {
  KE: { code: '254', nationalDigits: 9 },
  ZA: { code: '27', nationalDigits: 9 },
  MA: { code: '212', nationalDigits: 9 },
}

/**
 * National formats into E.164.
 *
 * The exports hold three shapes: already international (+254 701 821 961),
 * national with a trunk zero (0704279001), and bare digits already carrying
 * the country code (254-731-694774). All three reduce to the same nine
 * significant digits, which is the only thing this function trusts.
 *
 * Anything that does not reduce cleanly is dropped and reported rather than
 * half-converted. `025701347763` is the case that matters: strip the leading
 * zero and prefix the country code and you get a confident-looking
 * +25425701347763, which is not anybody's number. A wrong number is not an
 * improvement on a missing one — it is a message to a stranger.
 */
export function normalisePhone(
  raw: string | null | undefined,
  brandCountry: string,
): Outcome<string | null> {
  if (blank(raw)) return ok(null)

  const trimmed = raw!.trim()
  const unreadable: Outcome<string | null> = ok(null, {
    reasonCode: 'phone_unreadable',
    reason: `"${trimmed}" could not be read as a phone number, so no number was stored.`,
    field: 'phone',
    value: raw ?? null,
  })

  let digits = trimmed.replace(/[\s\-().]/g, '')
  let statedInternational = false

  if (digits.startsWith('+')) {
    digits = digits.slice(1)
    statedInternational = true
  } else if (digits.startsWith('00')) {
    digits = digits.slice(2)
    statedInternational = true
  }

  if (!/^\d+$/.test(digits)) return unreadable

  const plans = Object.values(NUMBER_PLAN)

  /*
   * A number that already carries a country code is unambiguous, so it is
   * accepted whichever brand's export it turned up in. This is not a
   * hypothetical tidiness: 6,493 contacts in the South African export carry
   * well-formed Kenyan +254 numbers. Insisting they match the brand's own
   * country would throw away thousands of perfectly good numbers — the market
   * a brand sells in does not constrain where its customers hold a phone.
   */
  const international = plans.find(
    (plan) => digits.startsWith(plan.code) && digits.length === plan.code.length + plan.nationalDigits,
  )
  if (international) return ok(`+${digits}`)

  if (!statedInternational && digits.startsWith('0')) {
    const withoutTrunk = digits.slice(1)

    // A trunk zero in front of a full international number: 0 254 7xx xxx xxx.
    const trunked = plans.find(
      (plan) =>
        withoutTrunk.startsWith(plan.code) &&
        withoutTrunk.length === plan.code.length + plan.nationalDigits,
    )
    if (trunked) return ok(`+${withoutTrunk}`)

    // Otherwise it is a national number, and the brand's market says whose.
    const local = NUMBER_PLAN[brandCountry]
    if (local && withoutTrunk.length === local.nationalDigits) {
      return ok(`+${local.code}${withoutTrunk}`)
    }

    /*
     * Everything else here is damaged rather than merely written oddly.
     * 21,974 rows hold twelve digits behind a single zero — 025710676604 —
     * which leaves eleven significant digits where every market in this portal
     * uses nine. The shape suggests a country code with a digit missing, and a
     * phone number with a digit missing cannot be repaired: any fix is a guess
     * at somebody else's number.
     */
    return unreadable
  }

  const local = NUMBER_PLAN[brandCountry]
  if (local && digits.length === local.nationalDigits) return ok(`+${local.code}${digits}`)

  return unreadable
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/
const SLASHED = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2}))?$/

/**
 * Three formats appear in the exports: full ISO instants (most rows), bare
 * dates, and a few thousand written as `20/02/2026 09:17`.
 *
 * The slashed form is read day-first, which is the convention in all three
 * markets. Where the first number is 12 or less the date is genuinely
 * ambiguous — 05/03 is either March or May — and the row is still imported,
 * with a warning naming the assumption. That is requirement 4 applied to a
 * single field: when two careful people could read it differently, say which
 * way it was read rather than picking silently.
 *
 * A bare date becomes midnight UTC, not midnight local. It is recorded as read
 * rather than shifted into a timezone the file never mentioned.
 */
export function parseTimestamp(raw: string | null | undefined): Outcome<Date | null> {
  if (blank(raw)) return ok(null)

  const value = raw!.trim()

  if (ISO_INSTANT.test(value)) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime())) return ok(date)
  }

  const dateOnly = DATE_ONLY.exec(value)
  if (dateOnly) {
    const date = new Date(`${value}T00:00:00Z`)
    if (!Number.isNaN(date.getTime())) {
      return ok(date, {
        reasonCode: 'date_without_time',
        reason: `"${value}" has no time, so it was read as midnight UTC.`,
        value: raw ?? null,
      })
    }
  }

  const slashed = SLASHED.exec(value)
  if (slashed) {
    const [, first, second, year, hour = '00', minute = '00'] = slashed
    const day = Number(first)
    const month = Number(second)

    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${hour.padStart(2, '0')}:${minute}:00Z`
      const date = new Date(iso)

      if (!Number.isNaN(date.getTime())) {
        return ok(
          date,
          day <= 12
            ? {
                reasonCode: 'date_ambiguous',
                reason: `"${value}" could be day-first or month-first; it was read day-first, as ${iso}.`,
                value: raw ?? null,
              }
            : undefined,
        )
      }
    }
  }

  return rejected({
    reasonCode: 'date_unreadable',
    reason: `"${value}" is not a date this importer recognises.`,
    value: raw ?? null,
  })
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

/**
 * The Moroccan export writes money the French way — `221,09` rather than
 * `221.09`. Reading that with parseFloat gives 221, losing the centimes
 * silently, which is exactly the class of bug that makes a spend figure wrong
 * by a little rather than obviously.
 */
export function parseDecimal(raw: string | null | undefined): Outcome<number | null> {
  if (blank(raw)) return ok(null)

  const value = raw!.trim()

  if (/^-?\d+(\.\d+)?$/.test(value)) return ok(Number(value))
  if (/^-?\d+,\d{1,2}$/.test(value)) return ok(Number(value.replace(',', '.')))

  return rejected({
    reasonCode: 'number_unreadable',
    reason: `"${value}" is not a number.`,
    value: raw ?? null,
  })
}

export function parseInteger(raw: string | null | undefined): Outcome<number | null> {
  if (blank(raw)) return ok(null)

  const value = raw!.trim()
  if (/^-?\d+$/.test(value)) return ok(Number(value))

  return rejected({
    reasonCode: 'number_unreadable',
    reason: `"${value}" is not a whole number.`,
    value: raw ?? null,
  })
}

// ---------------------------------------------------------------------------
// Small vocabularies
// ---------------------------------------------------------------------------

export type Channel = 'email' | 'sms'
export type EventType = 'open' | 'click' | 'bounce' | 'complaint' | 'unsubscribe'

const CHANNELS = new Set<Channel>(['email', 'sms'])
const EVENT_TYPES = new Set<EventType>(['open', 'click', 'bounce', 'complaint', 'unsubscribe'])

export function normaliseChannel(raw: string | null | undefined): Outcome<Channel> {
  const value = (raw ?? '').trim().toLowerCase()
  if (CHANNELS.has(value as Channel)) return ok(value as Channel)

  return rejected({
    reasonCode: 'channel_unknown',
    reason: `"${raw ?? ''}" is not a channel. Expected email or sms.`,
    field: 'channel',
    value: raw ?? null,
  })
}

export function normaliseEventType(raw: string | null | undefined): Outcome<EventType> {
  const value = (raw ?? '').trim().toLowerCase()
  if (EVENT_TYPES.has(value as EventType)) return ok(value as EventType)

  return rejected({
    reasonCode: 'event_type_unknown',
    reason: `"${raw ?? ''}" is not a result type this portal records.`,
    field: 'event_type',
    value: raw ?? null,
  })
}
