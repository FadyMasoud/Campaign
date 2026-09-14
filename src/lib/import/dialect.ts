import { readFileSync } from 'node:fs'
import { parse } from 'csv-parse/sync'

/**
 * Reading three exports that agree on almost nothing.
 *
 * Between them the files differ in delimiter (`,` against `;`), in byte order
 * mark, and in how they spell every column heading — `external_id`,
 * `External Id`, and `e_mail` for the address. None of that is interesting
 * enough to deserve three importers, so it is all absorbed here and the rest
 * of the code sees one shape.
 *
 * What is NOT absorbed here: anything about the values themselves. This module
 * decides where a field is; normalise.ts decides whether it makes sense.
 */

export type CsvRow = {
  /** Canonical snake_case keys, so callers never see a dialect. */
  values: Record<string, string>
  /** Line in the original file, so a report can tell someone where to look. */
  line: number
}

export type CsvFile = {
  rows: CsvRow[]
  delimiter: string
  hadByteOrderMark: boolean
  headers: string[]
}

/**
 * Headings become snake_case, which collapses most of the difference on its
 * own: `External Id` and `external_id` both become `external_id`.
 */
function canonicalKey(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/**
 * What snake_casing cannot fix: columns that are genuinely named differently.
 * The Moroccan export is partly in French.
 */
const COLUMN_ALIASES: Record<string, string> = {
  e_mail: 'email',
  mobile: 'phone',
  pays: 'country',
  campaign_name: 'name',
  sent_at_utc: 'sent_at',
  occurred_at_utc: 'occurred_at',
  target_country: 'target_country_code',
}

/**
 * Picks the delimiter by counting candidates in the header line.
 *
 * Sniffing rather than hard-coding per file, because the thing that makes an
 * importer brittle is a table of filenames: the next export to arrive is
 * always the one that is not in it.
 */
function sniffDelimiter(headerLine: string): string {
  const semicolons = (headerLine.match(/;/g) ?? []).length
  const commas = (headerLine.match(/,/g) ?? []).length
  return semicolons > commas ? ';' : ','
}

export function readCsvFile(path: string): CsvFile {
  const buffer = readFileSync(path)

  // The Kilele exports begin with a UTF-8 byte order mark. Left in place it
  // becomes part of the first column's name, so `external_id` silently
  // becomes `﻿external_id` and every row looks like it has no id.
  const hadByteOrderMark = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  const text = buffer.toString('utf8').replace(/^﻿/, '')

  const firstBreak = text.indexOf('\n')
  const delimiter = sniffDelimiter(firstBreak === -1 ? text : text.slice(0, firstBreak))

  const parsed = parse(text, {
    columns: (headers: string[]) =>
      headers.map((header) => {
        const key = canonicalKey(header)
        return COLUMN_ALIASES[key] ?? key
      }),
    delimiter,
    skip_empty_lines: true,
    // Quoted fields carry embedded commas and newlines — about twenty rows in
    // the Kilele export span two lines. This is the reason the files are read
    // with a parser rather than split on the delimiter.
    relax_column_count: true,
    // Keeps a row whose quoting is malformed from aborting the whole file;
    // such a row still reaches the mappers and is reported like any other.
    relax_quotes: true,
    info: true,
    trim: false,
  }) as Array<{ record: Record<string, string>; info: { lines: number } }>

  return {
    rows: parsed.map((entry) => ({ values: entry.record, line: entry.info.lines })),
    delimiter,
    hadByteOrderMark,
    headers: parsed.length > 0 ? Object.keys(parsed[0].record) : [],
  }
}
