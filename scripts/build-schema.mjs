// Concatenates the numbered migrations into a single schema.sql.
//
// The migrations are the source of truth — they are what has actually been run
// against the database, in order. schema.sql is a generated read-only view of
// them, because the submission asks for one file and reviewers should not have
// to open a directory to read the schema. Never edit schema.sql by hand; edit a
// migration and run `npm run schema:build`.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS = join(import.meta.dirname, '..', 'supabase', 'migrations')
const OUTPUT = join(import.meta.dirname, '..', 'schema.sql')

const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .sort()

if (files.length === 0) {
  console.error('No migrations found in supabase/migrations.')
  process.exit(1)
}

const banner = [
  '-- GENERATED FILE — DO NOT EDIT.',
  '--',
  '-- Built from supabase/migrations by `npm run schema:build`.',
  '-- The migrations are the source of truth; this is a single-file view of',
  '-- them for reading. Edit a migration, then regenerate.',
  '--',
  `-- Migrations included (${files.length}):`,
  ...files.map((name) => `--   ${name}`),
  '',
].join('\n')

const body = files
  .map((name) => `${readFileSync(join(MIGRATIONS, name), 'utf8').trimEnd()}\n`)
  .join('\n')

writeFileSync(OUTPUT, `${banner}\n${body}`, 'utf8')
console.log(`schema.sql written from ${files.length} migration(s).`)
