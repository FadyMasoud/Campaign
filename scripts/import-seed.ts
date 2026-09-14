/**
 * Loads the seed exports into the database.
 *
 *   npm run import:seed              load everything
 *   npm run import:seed -- --dry-run parse and report, write nothing
 *   npm run import:seed -- --only kilele-contacts.csv
 *
 * Safe to run repeatedly. Customers and campaigns are matched on
 * (brand_id, external_id) and updated in place, and results are matched on the
 * provider's own reference and ignored if already present — so running this
 * twice leaves one set of customers, not two.
 *
 * Connects with the database URL rather than through the REST API: this moves
 * roughly 400,000 rows, and doing that a request at a time would take hours
 * and leave a half-loaded database if it failed in the middle.
 */

import { join } from 'node:path'
import { config } from 'dotenv'
import pg from 'pg'
import { readCsvFile } from '../src/lib/import/dialect'
import {
  mapCampaign,
  mapContact,
  mapEvent,
  type BrandInfo,
  type CampaignRecord,
  type ContactRecord,
  type EventRecord,
} from '../src/lib/import/rows'
import type { Note } from '../src/lib/import/normalise'

config({ path: '.env.local' })

const SEED_DIR = 'supabase/seed'
const CHUNK = 2000

/*
 * Order matters. Campaigns and customers must exist before the results that
 * reference them, and the September delta must be applied after the export it
 * corrects — it carries 2,500 updates to customers already in the main file
 * and 1,680 new ones.
 */
const MANIFEST = [
  { file: 'kilele-campaigns.csv', brand: 'KILELE', entity: 'campaigns' },
  { file: 'karoo-campaigns.csv', brand: 'KAROO', entity: 'campaigns' },
  { file: 'marrakech-campaigns.csv', brand: 'MARRAKECH', entity: 'campaigns' },
  { file: 'kilele-contacts.csv', brand: 'KILELE', entity: 'contacts' },
  { file: 'kilele-contacts-delta-2026-09-01.csv', brand: 'KILELE', entity: 'contacts' },
  { file: 'karoo-contacts.csv', brand: 'KAROO', entity: 'contacts' },
  { file: 'marrakech-contacts.csv', brand: 'MARRAKECH', entity: 'contacts' },
  { file: 'kilele-events.csv', brand: 'KILELE', entity: 'events' },
  { file: 'karoo-events.csv', brand: 'KAROO', entity: 'events' },
  { file: 'marrakech-events.csv', brand: 'MARRAKECH', entity: 'events' },
] as const

type Issue = Note & { severity: 'rejected' | 'warning'; sourceLine: number; externalId: string | null }

const args = process.argv.slice(2)
const DRY_RUN = args.includes('--dry-run')
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const column = <T, K extends keyof T>(rows: T[], key: K): Array<T[K]> => rows.map((row) => row[key])

/** PostgreSQL text cannot hold a NUL byte; nothing we quote back may contain one. */
const NUL = String.fromCharCode(0)
const stripNul = (value: string): string => value.split(NUL).join('<NUL>')

async function main() {
  const connectionString = process.env.SUPABASE_DB_URL
  if (!connectionString) {
    console.error('SUPABASE_DB_URL is not set in .env.local.')
    process.exit(1)
  }

  const client = new pg.Client({ connectionString, ssl: { rejectUnauthorized: false } })
  await client.connect()

  try {
    const { rows: brandRows } = await client.query<{ id: string; code: string; country_code: string }>(
      'select id, code, country_code from public.brands',
    )
    const brands = new Map<string, BrandInfo>(
      brandRows.map((b) => [b.code, { id: b.id, code: b.code, countryCode: b.country_code }]),
    )

    for (const item of MANIFEST) {
      if (ONLY && item.file !== ONLY) continue

      const brand = brands.get(item.brand)
      if (!brand) throw new Error(`brand ${item.brand} is not in the database`)

      await importFile(client, brand, item.file, item.entity)
    }
  } finally {
    await client.end()
  }
}

async function importFile(
  client: pg.Client,
  brand: BrandInfo,
  file: string,
  entity: 'contacts' | 'campaigns' | 'events',
) {
  const started = Date.now()
  const csv = readCsvFile(join(SEED_DIR, file))
  const issues: Issue[] = []

  process.stdout.write(
    `\n${file}  (${brand.code}, ${entity}, ${csv.rows.length.toLocaleString('en')} rows, ` +
      `delimiter "${csv.delimiter}"${csv.hadByteOrderMark ? ', BOM' : ''})\n`,
  )

  const runId = DRY_RUN ? null : await startRun(client, brand.id, file, entity)

  const reject = (line: number, externalId: string | null, note: Note) =>
    issues.push({ ...note, severity: 'rejected', sourceLine: line, externalId })
  const warn = (line: number, externalId: string | null, note: Note) =>
    issues.push({ ...note, severity: 'warning', sourceLine: line, externalId })

  let created = 0
  let updated = 0
  let duplicates = 0

  try {
    if (entity === 'contacts') {
      const { records, duplicateCount } = collectContacts(csv, brand, file, reject, warn)
      duplicates = duplicateCount
      if (!DRY_RUN) ({ created, updated } = await upsertContacts(client, brand.id, records))
      else created = records.length
    } else if (entity === 'campaigns') {
      const { records, duplicateCount } = collectCampaigns(csv, reject, warn)
      duplicates = duplicateCount
      if (!DRY_RUN) {
        ;({ created, updated } = await upsertCampaigns(client, brand.id, records))
        await resolveParents(client, brand, records, warn)
      } else created = records.length
    } else {
      const { records, duplicateCount } = collectEvents(csv, reject)
      duplicates = duplicateCount
      if (!DRY_RUN) created = await insertEvents(client, brand, records, reject, warn)
      else created = records.length
    }

    const rejected = issues.filter((i) => i.severity === 'rejected').length

    if (!DRY_RUN && runId) {
      await writeIssues(client, brand.id, runId, issues)
      await finishRun(client, runId, {
        rowsRead: csv.rows.length,
        rowsCreated: created,
        rowsUpdated: updated,
        rowsRejected: rejected,
        rowsDuplicate: duplicates,
      })
    }

    report(csv.rows.length, created, updated, rejected, duplicates, issues, Date.now() - started)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!DRY_RUN && runId) await failRun(client, runId, message)
    throw error
  }
}

// ---------------------------------------------------------------------------
// Collecting rows, and collapsing the ones that repeat
// ---------------------------------------------------------------------------

/**
 * The exports list the same customer more than once — 2,778 times in the
 * Kilele file alone. Most repeats are byte-identical and harmless; 368 differ,
 * always in the email address.
 *
 * The last one in the file wins, which is the same rule the database applies
 * when the file is loaded twice, so a repeat within a file and a repeat across
 * two runs behave identically. A repeat that changes something is reported;
 * an identical repeat is only counted, because a marketer does not need 2,410
 * report lines saying a row was listed twice with no difference.
 */
function dedupe<T extends { external_id: string }>(
  entries: Array<{ record: T; line: number }>,
  onConflict: (line: number, externalId: string, previous: T, next: T) => void,
): { records: T[]; duplicateCount: number } {
  const byId = new Map<string, T>()
  let duplicateCount = 0

  for (const { record, line } of entries) {
    const previous = byId.get(record.external_id)
    if (previous) {
      duplicateCount += 1
      if (JSON.stringify(previous) !== JSON.stringify(record)) {
        onConflict(line, record.external_id, previous, record)
      }
    }
    byId.set(record.external_id, record)
  }

  return { records: [...byId.values()], duplicateCount }
}

type Reporter = (line: number, externalId: string | null, note: Note) => void

function collectContacts(
  csv: ReturnType<typeof readCsvFile>,
  brand: BrandInfo,
  file: string,
  reject: Reporter,
  warn: Reporter,
) {
  const entries: Array<{ record: ContactRecord; line: number }> = []

  for (const row of csv.rows) {
    const mapped = mapContact(row, brand, file)
    const id = row.values.external_id?.trim() || null

    if (!mapped.ok) {
      reject(row.line, id, mapped.note)
      continue
    }
    for (const note of mapped.notes) warn(row.line, id, note)
    entries.push({ record: mapped.record, line: row.line })
  }

  return dedupe(entries, (line, externalId, previous, next) => {
    const changed = (Object.keys(next) as Array<keyof ContactRecord>).filter(
      (key) => String(previous[key]) !== String(next[key]),
    )
    warn(line, externalId, {
      reasonCode: 'duplicate_conflicting',
      reason: `This customer is listed more than once with different details (${changed.join(', ')}). The last version in the file was kept.`,
      value: changed.join(', '),
    })
  })
}

function collectCampaigns(csv: ReturnType<typeof readCsvFile>, reject: Reporter, warn: Reporter) {
  const entries: Array<{ record: CampaignRecord; line: number }> = []

  for (const row of csv.rows) {
    const mapped = mapCampaign(row)
    const id = row.values.external_id?.trim() || null

    if (!mapped.ok) {
      reject(row.line, id, mapped.note)
      continue
    }
    for (const note of mapped.notes) warn(row.line, id, note)
    entries.push({ record: mapped.record, line: row.line })
  }

  return dedupe(entries, (line, externalId) => {
    warn(line, externalId, {
      reasonCode: 'duplicate_conflicting',
      reason: 'This campaign is listed more than once with different details. The last version in the file was kept.',
      value: externalId,
    })
  })
}

function collectEvents(csv: ReturnType<typeof readCsvFile>, reject: Reporter) {
  const entries: Array<{ record: EventRecord & { external_id: string }; line: number }> = []

  for (const row of csv.rows) {
    const mapped = mapEvent(row)
    const id = row.values.event_id?.trim() || null

    if (!mapped.ok) {
      reject(row.line, id, mapped.note)
      continue
    }
    entries.push({ record: mapped.record, line: row.line })
  }

  // Repeated results are the provider saying the same thing twice. That is
  // expected, not an error — it is the same property that makes replaying a
  // whole file harmless.
  return dedupe(entries, () => {})
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Rows go in a few thousand at a time as parallel arrays expanded by unnest,
 * rather than one statement per row. 312,000 round trips would take about an
 * hour; this takes seconds.
 *
 * `xmax = 0` is true only for a row this statement inserted, which is how a
 * single upsert can report created and updated separately — the number a
 * marketer actually wants after loading a correction file.
 */
async function upsertContacts(client: pg.Client, brandId: string, records: ContactRecord[]) {
  let created = 0
  let updated = 0

  for (const chunk of chunks(records, CHUNK)) {
    const result = await client.query<{ inserted: boolean }>(
      `insert into public.contacts (
         brand_id, external_id, full_name, email, phone_raw, phone_e164,
         country_code, city, signup_at, status, consent_marketing,
         deleted_at, suppressed_until, notes, source_file
       )
       select $1::uuid, u.* from unnest(
         $2::text[], $3::text[], $4::text[], $5::text[], $6::text[],
         $7::text[], $8::text[], $9::timestamptz[], $10::public.contact_status[],
         $11::boolean[], $12::timestamptz[], $13::timestamptz[], $14::text[], $15::text[]
       ) as u(external_id, full_name, email, phone_raw, phone_e164, country_code,
              city, signup_at, status, consent_marketing, deleted_at,
              suppressed_until, notes, source_file)
       on conflict (brand_id, external_id) do update set
         full_name = excluded.full_name,
         email = excluded.email,
         phone_raw = excluded.phone_raw,
         phone_e164 = excluded.phone_e164,
         country_code = excluded.country_code,
         city = excluded.city,
         signup_at = excluded.signup_at,
         status = excluded.status,
         consent_marketing = excluded.consent_marketing,
         deleted_at = excluded.deleted_at,
         suppressed_until = excluded.suppressed_until,
         notes = excluded.notes,
         source_file = excluded.source_file
       returning (xmax = 0) as inserted`,
      [
        brandId,
        column(chunk, 'external_id'),
        column(chunk, 'full_name'),
        column(chunk, 'email'),
        column(chunk, 'phone_raw'),
        column(chunk, 'phone_e164'),
        column(chunk, 'country_code'),
        column(chunk, 'city'),
        column(chunk, 'signup_at'),
        column(chunk, 'status'),
        column(chunk, 'consent_marketing'),
        column(chunk, 'deleted_at'),
        column(chunk, 'suppressed_until'),
        column(chunk, 'notes'),
        column(chunk, 'source_file'),
      ],
    )

    for (const row of result.rows) {
      if (row.inserted) created += 1
      else updated += 1
    }
  }

  return { created, updated }
}

async function upsertCampaigns(client: pg.Client, brandId: string, records: CampaignRecord[]) {
  let created = 0
  let updated = 0

  for (const chunk of chunks(records, CHUNK)) {
    const result = await client.query<{ inserted: boolean }>(
      `insert into public.campaigns (
         brand_id, external_id, name, channel, target_country_code,
         reported_sent, reported_delivered, reported_bounced, reported_opens,
         reported_clicks, spend, sent_at, send_local_time, parent_external_id
       )
       select $1::uuid, u.* from unnest(
         $2::text[], $3::text[], $4::public.channel[], $5::text[],
         $6::integer[], $7::integer[], $8::integer[], $9::integer[],
         $10::integer[], $11::numeric[], $12::timestamptz[], $13::text[], $14::text[]
       ) as u(external_id, name, channel, target_country_code, reported_sent,
              reported_delivered, reported_bounced, reported_opens,
              reported_clicks, spend, sent_at, send_local_time, parent_external_id)
       on conflict (brand_id, external_id) do update set
         name = excluded.name,
         channel = excluded.channel,
         target_country_code = excluded.target_country_code,
         reported_sent = excluded.reported_sent,
         reported_delivered = excluded.reported_delivered,
         reported_bounced = excluded.reported_bounced,
         reported_opens = excluded.reported_opens,
         reported_clicks = excluded.reported_clicks,
         spend = excluded.spend,
         sent_at = excluded.sent_at,
         send_local_time = excluded.send_local_time,
         parent_external_id = excluded.parent_external_id
       returning (xmax = 0) as inserted`,
      [
        brandId,
        column(chunk, 'external_id'),
        column(chunk, 'name'),
        column(chunk, 'channel'),
        column(chunk, 'target_country_code'),
        column(chunk, 'reported_sent'),
        column(chunk, 'reported_delivered'),
        column(chunk, 'reported_bounced'),
        column(chunk, 'reported_opens'),
        column(chunk, 'reported_clicks'),
        column(chunk, 'spend'),
        column(chunk, 'sent_at'),
        column(chunk, 'send_local_time'),
        column(chunk, 'parent_external_id'),
      ],
    )

    for (const row of result.rows) {
      if (row.inserted) created += 1
      else updated += 1
    }
  }

  return { created, updated }
}

/**
 * Links a campaign to its parent, within the brand only.
 *
 * The Karoo export names KIL-0007 — a Kilele campaign — as the parent of one
 * of its own. The database would refuse that link outright, because brand_id
 * is part of both sides of the foreign key, so the importer does not attempt
 * it: the stated parent is kept verbatim in parent_external_id, the resolved
 * link is left empty, and the marketer is told which campaigns could not be
 * connected and to what.
 */
async function resolveParents(
  client: pg.Client,
  brand: BrandInfo,
  records: CampaignRecord[],
  warn: Reporter,
) {
  const withParents = records.filter((r) => r.parent_external_id)
  if (withParents.length === 0) return

  const { rows } = await client.query<{ external_id: string }>(
    `update public.campaigns child
        set parent_campaign_id = parent.id
       from public.campaigns parent
      where child.brand_id = $1
        and parent.brand_id = $1
        and child.parent_external_id = parent.external_id
        and child.external_id = any($2::text[])
      returning child.external_id`,
    [brand.id, withParents.map((r) => r.external_id)],
  )

  const linked = new Set(rows.map((r) => r.external_id))

  for (const record of withParents) {
    if (linked.has(record.external_id)) continue
    warn(0, record.external_id, {
      reasonCode: 'parent_campaign_unresolved',
      reason: `The parent campaign "${record.parent_external_id}" is not part of ${brand.code}, so the two were not linked. The stated reference was kept.`,
      field: 'parent_campaign_id',
      value: record.parent_external_id,
    })
  }
}

/**
 * Results reference customers and campaigns by the provider's reference, so
 * both have to be resolved to rows in this brand before anything is written.
 *
 * A result whose customer is unknown is refused: it describes something that
 * happened to nobody. A result whose CAMPAIGN is unknown is kept, with the
 * campaign left empty — 633 of the 940 Moroccan results name campaigns absent
 * from that export, and among them are unsubscribes and complaints. Dropping
 * those would mean the portal believed people were contactable who had asked
 * not to be, which is a worse error than an unattributed open.
 */
async function insertEvents(
  client: pg.Client,
  brand: BrandInfo,
  records: EventRecord[],
  reject: Reporter,
  warn: Reporter,
) {
  const contactIds = await loadExternalIdMap(client, 'contacts', brand.id)
  const campaignIds = await loadExternalIdMap(client, 'campaigns', brand.id)

  const resolved: Array<{
    external_id: string
    contact_id: string
    campaign_id: string | null
    event_type: string
    channel: string
    occurred_at: Date
  }> = []

  const unknownCampaigns = new Set<string>()

  for (const record of records) {
    const contactId = contactIds.get(record.contact_external_id)
    if (!contactId) {
      reject(0, record.external_id, {
        reasonCode: 'unknown_contact_reference',
        reason: `This result is attributed to customer "${record.contact_external_id}", who is not in this brand.`,
        field: 'external_contact_id',
        value: record.contact_external_id,
      })
      continue
    }

    let campaignId: string | null = null
    if (record.campaign_external_id) {
      campaignId = campaignIds.get(record.campaign_external_id) ?? null
      if (!campaignId) unknownCampaigns.add(record.campaign_external_id)
    }

    resolved.push({
      external_id: record.external_id,
      contact_id: contactId,
      campaign_id: campaignId,
      event_type: record.event_type,
      channel: record.channel,
      occurred_at: record.occurred_at,
    })
  }

  for (const campaign of unknownCampaigns) {
    warn(0, campaign, {
      reasonCode: 'unknown_campaign_reference',
      reason: `Results refer to campaign "${campaign}", which is not in this export. They were kept, without a campaign attached, because unsubscribes and complaints still count.`,
      field: 'campaign_external_id',
      value: campaign,
    })
  }

  let inserted = 0

  for (const chunk of chunks(resolved, CHUNK)) {
    const result = await client.query(
      `insert into public.contact_events (
         brand_id, external_id, contact_id, campaign_id, event_type, channel, occurred_at
       )
       select $1::uuid, u.* from unnest(
         $2::text[], $3::uuid[], $4::uuid[], $5::public.event_type[],
         $6::public.channel[], $7::timestamptz[]
       ) as u(external_id, contact_id, campaign_id, event_type, channel, occurred_at)
       on conflict (brand_id, external_id) do nothing`,
      [
        brand.id,
        column(chunk, 'external_id'),
        column(chunk, 'contact_id'),
        column(chunk, 'campaign_id'),
        column(chunk, 'event_type'),
        column(chunk, 'channel'),
        column(chunk, 'occurred_at'),
      ],
    )
    inserted += result.rowCount ?? 0
  }

  return inserted
}

async function loadExternalIdMap(client: pg.Client, table: 'contacts' | 'campaigns', brandId: string) {
  const { rows } = await client.query<{ id: string; external_id: string }>(
    `select id, external_id from public.${table} where brand_id = $1`,
    [brandId],
  )
  return new Map(rows.map((row) => [row.external_id, row.id]))
}

// ---------------------------------------------------------------------------
// The run record
// ---------------------------------------------------------------------------

async function startRun(client: pg.Client, brandId: string, file: string, entity: string) {
  const { rows } = await client.query<{ id: string }>(
    `insert into public.import_runs (brand_id, source_file, entity) values ($1, $2, $3) returning id`,
    [brandId, file, entity],
  )
  return rows[0].id
}

async function finishRun(
  client: pg.Client,
  runId: string,
  counts: { rowsRead: number; rowsCreated: number; rowsUpdated: number; rowsRejected: number; rowsDuplicate: number },
) {
  await client.query(
    `update public.import_runs
        set status = 'succeeded', finished_at = now(),
            rows_read = $2, rows_created = $3, rows_updated = $4,
            rows_rejected = $5, rows_duplicate = $6
      where id = $1`,
    [runId, counts.rowsRead, counts.rowsCreated, counts.rowsUpdated, counts.rowsRejected, counts.rowsDuplicate],
  )
}

async function failRun(client: pg.Client, runId: string, message: string) {
  await client.query(
    `update public.import_runs set status = 'failed', finished_at = now(), error = $2 where id = $1`,
    [runId, message],
  )
}

async function writeIssues(client: pg.Client, brandId: string, runId: string, issues: Issue[]) {
  for (const chunk of chunks(issues, CHUNK)) {
    await client.query(
      `insert into public.import_issues (
         brand_id, run_id, severity, reason_code, reason, source_line, external_id, field, value
       )
       select $1::uuid, $2::uuid, u.* from unnest(
         $3::public.import_severity[], $4::text[], $5::text[], $6::integer[],
         $7::text[], $8::text[], $9::text[]
       ) as u(severity, reason_code, reason, source_line, external_id, field, value)`,
      [
        brandId,
        runId,
        column(chunk, 'severity'),
        column(chunk, 'reasonCode'),
        column(chunk, 'reason'),
        chunk.map((i) => i.sourceLine || null),
        column(chunk, 'externalId'),
        chunk.map((i) => i.field ?? null),
        // Values are truncated: a report is for reading, and a runaway field
        // in a malformed row should not put 40KB into the issue log.
        //
        // They are also stripped of NUL bytes. The mappers already refuse rows
        // containing one, but the value quoted back in the report is arbitrary
        // input from a file we do not control, and PostgreSQL cannot store a
        // NUL in a text column at all. Without this the importer fails while
        // writing the very record that explains the failure.
        chunk.map((i) => (i.value == null ? null : stripNul(String(i.value)).slice(0, 200))),
      ],
    )
  }
}

// ---------------------------------------------------------------------------
// Console output
// ---------------------------------------------------------------------------

function report(
  read: number,
  created: number,
  updated: number,
  rejected: number,
  duplicates: number,
  issues: Issue[],
  ms: number,
) {
  const n = (value: number) => value.toLocaleString('en')
  process.stdout.write(
    `  read ${n(read)}  created ${n(created)}  updated ${n(updated)}  ` +
      `rejected ${n(rejected)}  repeated ${n(duplicates)}  (${(ms / 1000).toFixed(1)}s)\n`,
  )

  const byReason = new Map<string, { severity: string; count: number }>()
  for (const issue of issues) {
    const key = `${issue.severity}:${issue.reasonCode}`
    const entry = byReason.get(key) ?? { severity: issue.severity, count: 0 }
    entry.count += 1
    byReason.set(key, entry)
  }

  for (const [key, entry] of [...byReason.entries()].sort((a, b) => b[1].count - a[1].count)) {
    const mark = entry.severity === 'rejected' ? '✕' : '!'
    process.stdout.write(`    ${mark} ${key.split(':')[1].padEnd(28)} ${n(entry.count)}\n`)
  }
}

main().catch((error) => {
  console.error(`\n${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
