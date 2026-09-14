/**
 * Creates the six portal logins and attaches each to exactly one brand.
 *
 * Run with: npm run seed:users
 *
 * Idempotent by design. Re-running updates the password and the membership of
 * an existing account rather than failing or creating a second one, so it can
 * be used to reset the demo to a known state before a review call.
 *
 * This is the only place accounts are created. Public sign-up is closed on the
 * project; a stranger cannot make themselves an account, and an account made
 * some other way would have no row in brand_members and would therefore see
 * nothing at all — that case is asserted in tests/isolation.test.ts.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { config } from 'dotenv'
import { createClient } from '@supabase/supabase-js'

config({ path: '.env.local' })

const URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!URL || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.',
  )
  process.exit(1)
}

/*
 * The six accounts come from supabase/seed/portal-accounts.json rather than
 * being written out here, because tests/accounts.test.ts signs in as every one
 * of them and asserts what it can see. One list, read by the thing that
 * creates the accounts and by the thing that verifies them, means the
 * credentials handed over at submission cannot drift from the ones that exist.
 */
const { accounts: ACCOUNTS } = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'supabase', 'seed', 'portal-accounts.json'), 'utf8'),
)

const admin = createClient(URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Supabase has no get-user-by-email, so page through until we find it. */
async function findUserByEmail(email) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) throw new Error(`listUsers failed: ${error.message}`)
    const match = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase())
    if (match) return match
    if (data.users.length < 200) return null
  }
  return null
}

async function main() {
  const { data: brands, error: brandError } = await admin.from('brands').select('id, code')
  if (brandError) throw new Error(`could not read brands: ${brandError.message}`)

  const brandIdByCode = new Map(brands.map((b) => [b.code, b.id]))
  const results = []

  for (const account of ACCOUNTS) {
    const brandId = brandIdByCode.get(account.brand)
    if (!brandId) throw new Error(`brand ${account.brand} is missing — run the migration first`)

    const existing = await findUserByEmail(account.email)
    let userId
    let action

    if (existing) {
      const { error } = await admin.auth.admin.updateUserById(existing.id, {
        password: account.password,
        email_confirm: true,
      })
      if (error) throw new Error(`could not update ${account.email}: ${error.message}`)
      userId = existing.id
      action = 'updated'
    } else {
      const { data, error } = await admin.auth.admin.createUser({
        email: account.email,
        password: account.password,
        email_confirm: true, // no inbox exists at .test, so confirm here
      })
      if (error) throw new Error(`could not create ${account.email}: ${error.message}`)
      userId = data.user.id
      action = 'created'
    }

    /*
     * Delete-then-insert rather than upsert: a user must belong to exactly one
     * brand. If an account were somehow attached to two, upserting the right
     * row would leave the wrong one in place and quietly widen what that
     * person can see.
     */
    const { error: clearError } = await admin.from('brand_members').delete().eq('user_id', userId)
    if (clearError) throw new Error(`could not clear membership: ${clearError.message}`)

    const { error: memberError } = await admin
      .from('brand_members')
      .insert({ user_id: userId, brand_id: brandId, role: account.role })
    if (memberError) throw new Error(`could not attach membership: ${memberError.message}`)

    results.push({ ...account, userId, action })
  }

  console.log('\nSix logins ready:\n')
  console.table(
    results.map((r) => ({
      email: r.email,
      password: r.password,
      brand: r.brand,
      role: r.role,
      '': r.action,
    })),
  )

  const { count } = await admin
    .from('brand_members')
    .select('*', { count: 'exact', head: true })
  console.log(`brand_members rows: ${count} (expected 6)\n`)
}

main().catch((error) => {
  console.error(`\n${error.message}\n`)
  process.exit(1)
})
