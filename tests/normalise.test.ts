import { describe, expect, it } from 'vitest'
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
} from '@/lib/import/normalise'

/**
 * Requirement 10: bad input is rejected, not stored.
 *
 * Every input below was taken from the three real exports by counting distinct
 * values, so these are not invented edge cases — they are the file. The counts
 * in the comments are how many rows held that spelling.
 *
 * These are the only tests in the suite that need no database, so they run in
 * milliseconds and are where the fiddly decisions get pinned down.
 */

describe('customer status — 11 spellings, 4 states', () => {
  it.each([
    ['active', 'active'],
    ['ACTIVE', 'active'],
    ['Active', 'active'],
    ['active ', 'active'],
    ['unsubscribed', 'unsubscribed'],
    ['unsubscribe', 'unsubscribed'],
    ['bounced', 'bounced'],
    ['pending', 'pending'],
  ])('reads %o as %o', (input, expected) => {
    const result = normaliseStatus(input)
    expect(result.ok && result.value).toBe(expected)
  })

  it('refuses a value that is not a status at all', () => {
    // 46 rows hold "City" here, because their columns are shifted by one.
    const result = normaliseStatus('City')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.note.reasonCode).toBe('status_unknown')
  })

  it('refuses a blank status rather than guessing one', () => {
    // Every count on the portal is a count of these values. Defaulting would
    // move people into a bucket they may not belong in.
    for (const blank of ['', '   ', null, undefined]) {
      const result = normaliseStatus(blank)
      expect(result.ok).toBe(false)
    }
  })
})

describe('marketing consent — blank means no', () => {
  it.each(['true', 'TRUE', 't', 'yes', 'Y', '1'])('reads %o as consent given', (input) => {
    const result = normaliseConsent(input)
    expect(result.ok && result.value).toBe(true)
  })

  it.each(['false', 'FALSE', 'f', 'no', '0'])('reads %o as consent withheld', (input) => {
    const result = normaliseConsent(input)
    expect(result.ok && result.value).toBe(false)
  })

  it('treats a blank as no, and says so', () => {
    // 10,151 rows. This is the one default in the importer, and it is
    // deliberately the cautious direction: the absence of a recorded yes
    // cannot become permission to contact someone.
    const result = normaliseConsent('')
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toBe(false)
    expect(result.ok && result.note?.reasonCode).toBe('consent_absent')
  })

  it('refuses something that is neither', () => {
    expect(normaliseConsent('maybe').ok).toBe(false)
  })
})

describe('country — codes, names and a dialling prefix', () => {
  it.each([
    ['KE', 'KE'],
    ['ke ', 'KE'],
    ['KEN', 'KE'],
    ['kenya', 'KE'],
    ['Kenya', 'KE'],
    ['254', 'KE'],
    ['ZA', 'ZA'],
    ['MA', 'MA'],
    ['SS', 'SS'],
  ])('reads %o as %o', (input, expected) => {
    const result = normaliseCountry(input)
    expect(result.ok && result.value).toBe(expected)
  })

  it.each(['', '   ', 'NULL', 'null', 'none', '\\N', '-', 'N/A', 'ZZ'])(
    'treats %o as no country rather than a country',
    (input) => {
      const result = normaliseCountry(input)
      expect(result.ok).toBe(true)
      expect(result.ok && result.value).toBeNull()
    },
  )

  it('keeps the customer when the country is unreadable', () => {
    // Country is presentation, not permission. Losing a customer over it
    // would be a worse outcome than an empty field.
    const result = normaliseCountry('Wakanda')
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toBeNull()
    expect(result.ok && result.note?.reasonCode).toBe('country_unreadable')
  })
})

describe('email — normalise, never repair', () => {
  it('lowercases and trims, because that is the same address', () => {
    const result = normaliseEmail('  Sarah.Wanjiru@VG-EVAL.TEST ')
    expect(result.ok && result.value).toBe('sarah.wanjiru@vg-eval.test')
  })

  it.each([
    'john doe@vg-eval.test',
    'missing-at-sign.test',
    'bad@ vg-eval.test',
    'no-tld@vg-eval',
    'double@@vg-eval.test',
    'BAD@ VG-EVAL.TEST',
  ])('drops %o rather than guessing what was meant', (input) => {
    // Deleting the space from "john doe@vg-eval.test" would be a guess about
    // who this person is. Mail to a guessed address is worse than no mail.
    const result = normaliseEmail(input)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toBeNull()
    expect(result.ok && result.note?.reasonCode).toBe('email_invalid')
  })

  it('says nothing about a genuinely empty address', () => {
    const result = normaliseEmail('')
    expect(result.ok && result.value).toBeNull()
    expect(result.ok && result.note).toBeUndefined()
  })
})

describe('phone — national formats into E.164', () => {
  it.each([
    ['0704279001', 'KE', '+254704279001'],
    ['254-731-694774', 'KE', '+254731694774'],
    ['+254 701 821 961', 'KE', '+254701821961'],
    ['+212 653959127', 'MA', '+212653959127'],
    ['0712000000', 'ZA', '+27712000000'],
  ])('reads %o for %s as %s', (input, country, expected) => {
    const result = normalisePhone(input, country)
    expect(result.ok && result.value).toBe(expected)
  })

  it('drops a number that is too long to be real', () => {
    // 025701347763 is twelve digits; a Kenyan number is nine after the code.
    // Stripping the zero and prefixing 254 yields a confident-looking
    // +25425701347763, which is nobody's number. This is the case that made
    // the length check a numbering plan rather than a range.
    const result = normalisePhone('025701347763', 'KE')
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toBeNull()
    expect(result.ok && result.note?.reasonCode).toBe('phone_unreadable')
  })

  it('reads a trunk zero in front of the country code', () => {
    expect(normalisePhone('0254701821961', 'KE')).toMatchObject({
      ok: true,
      value: '+254701821961',
    })
  })

  it('keeps a valid foreign number found in another brand export', () => {
    // 6,493 contacts in the South African export carry Kenyan +254 numbers.
    // A number that already states its country code is unambiguous, and the
    // market a brand sells in does not constrain where its customers hold a
    // phone. Rejecting these threw away thousands of usable numbers.
    expect(normalisePhone('254-731-694774', 'ZA')).toMatchObject({
      ok: true,
      value: '+254731694774',
    })
    expect(normalisePhone('+254 729 123 430', 'ZA')).toMatchObject({
      ok: true,
      value: '+254729123430',
    })
  })

  it('stores nothing rather than half a number', () => {
    // A wrong number is not an improvement on a missing one — it is a message
    // to a stranger.
    const result = normalisePhone('12', 'KE')
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toBeNull()
    expect(result.ok && result.note?.reasonCode).toBe('phone_unreadable')
  })
})

describe('timestamps — three formats, one of them ambiguous', () => {
  it('reads a full ISO instant', () => {
    const result = parseTimestamp('2026-02-19T23:47:04Z')
    expect(result.ok && result.value?.toISOString()).toBe('2026-02-19T23:47:04.000Z')
  })

  it('reads the microsecond precision the event exports use', () => {
    const result = parseTimestamp('2026-03-07T10:42:18.187492Z')
    expect(result.ok).toBe(true)
  })

  it('reads a bare date as midnight UTC, and says so', () => {
    const result = parseTimestamp('2026-02-01')
    expect(result.ok && result.value?.toISOString()).toBe('2026-02-01T00:00:00.000Z')
    expect(result.ok && result.note?.reasonCode).toBe('date_without_time')
  })

  it('reads 20/02/2026 09:17 day-first', () => {
    const result = parseTimestamp('20/02/2026 09:17')
    expect(result.ok && result.value?.toISOString()).toBe('2026-02-20T09:17:00.000Z')
  })

  it('flags a slashed date that could be read either way', () => {
    // 05/03/2026 is March or May depending on who wrote it. It is imported,
    // day-first, with the assumption stated rather than hidden.
    const result = parseTimestamp('05/03/2026 08:00')
    expect(result.ok && result.value?.toISOString()).toBe('2026-03-05T08:00:00.000Z')
    expect(result.ok && result.note?.reasonCode).toBe('date_ambiguous')
  })

  it('refuses a status that has landed in a date column', () => {
    // 34 rows in the Karoo export have "active" here, because the row is
    // shifted. Rejecting is what surfaces the shift.
    const result = parseTimestamp('active')
    expect(result.ok).toBe(false)
    expect(!result.ok && result.note.reasonCode).toBe('date_unreadable')
  })

  it('treats an empty date as absent, not broken', () => {
    const result = parseTimestamp('')
    expect(result.ok && result.value).toBeNull()
  })
})

describe('numbers — including money written the French way', () => {
  it('reads a plain decimal', () => {
    expect(parseDecimal('365.56')).toMatchObject({ ok: true, value: 365.56 })
  })

  it('reads 221,09 as 221.09 rather than 221', () => {
    // The Moroccan export writes money with a comma. parseFloat would return
    // 221 and lose the centimes silently — wrong by a little, not obviously.
    expect(parseDecimal('221,09')).toMatchObject({ ok: true, value: 221.09 })
  })

  it('refuses something that is not a number', () => {
    expect(parseDecimal('lots').ok).toBe(false)
  })

  it('reads whole numbers and refuses decimals dressed as counts', () => {
    expect(parseInteger('10640')).toMatchObject({ ok: true, value: 10640 })
    expect(parseInteger('10.5').ok).toBe(false)
  })
})

describe('small vocabularies', () => {
  it('accepts the two channels and refuses anything else', () => {
    expect(normaliseChannel('email')).toMatchObject({ ok: true, value: 'email' })
    expect(normaliseChannel('SMS')).toMatchObject({ ok: true, value: 'sms' })
    expect(normaliseChannel('carrier pigeon').ok).toBe(false)
  })

  it('accepts the five result types and refuses anything else', () => {
    for (const type of ['open', 'click', 'bounce', 'complaint', 'unsubscribe']) {
      expect(normaliseEventType(type)).toMatchObject({ ok: true, value: type })
    }
    expect(normaliseEventType('delivered').ok).toBe(false)
  })
})
