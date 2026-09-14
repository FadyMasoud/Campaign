# AI tool usage log

The submission brief requires disclosure of AI assistance. This file is the
running record. It is updated at the end of every phase.

**Tool used:** Claude (Opus 5) via Claude Code, used as a pair-programmer.

**How it was used:** every file below was generated in conversation, then read,
questioned and accepted or amended by the author. Design decisions (stack,
schema shape, security model) were made jointly; the author can explain each
one. Nothing was accepted without an explanation of what it does and how it
could fail.

---

## Phase 0 — Project setup

| File | Origin | Author's involvement |
| --- | --- | --- |
| `package.json` | `create-next-app` scaffold + AI-added scripts | Chose the dependency set; resolved the `@types/node` peer conflict by aligning types with the installed Node 24 rather than force-installing |
| `.env.example` | AI-generated | Reviewed; the public/server split is the author's stated security requirement |
| `.gitignore` (project block) | AI-generated | One rule: re-include `.env.example` after the blanket `.env*` ignore |
| `src/lib/env/public.ts` | AI-generated | Validation schema and the return-a-result-instead-of-throwing decision discussed before writing |
| `src/lib/env/server.ts` | AI-generated | The `server-only` import is the key line; author can explain why it is a build-time guarantee |
| `src/lib/supabase/client.ts` | AI-generated | Browser client, publishable key |
| `src/lib/supabase/server.ts` | AI-generated | Server client acting as the signed-in user |
| `src/lib/supabase/admin.ts` | AI-generated | Service-role client; the usage rules in its doc comment are the operative security policy |
| `src/lib/supabase/health.ts` | AI-generated | Setup diagnostic; the four checks were specified by the author |
| `src/styles/tokens.css` | AI-generated | Palette chosen by AI against the author's "modern classic" brief; contrast ratios verified |
| `src/app/globals.css` | AI-generated | Baseline reset and typography |
| `src/app/layout.tsx` | AI-generated | Font choice (IBM Plex Sans / Serif / Sans Arabic) argued for on the grounds of one type system across both scripts |
| `src/app/page.tsx`, `page.module.css` | AI-generated | Setup diagnostic screen |
| `src/app/loading.tsx`, `error.tsx`, `states.module.css` | AI-generated | Loading and error states |
| `vitest.config.ts` | AI-generated | Test harness for the isolation test in phase 1 |
| `README.md` | AI-generated | Reviewed by author |

### Verified against reality, not assumed

Three things the AI initially got wrong or would have guessed, corrected by
checking the actual docs and the live API:

1. **Next.js 16 renamed `middleware.ts` to `proxy.ts`.** Caught by reading the
   version-matched docs bundled in `node_modules/next/dist/docs/` rather than
   trusting training data. It changes how session refresh is implemented in
   phase 2. The same docs note that proxy is explicitly *not* an authorization
   mechanism — only an optimistic check — which reinforces the decision to put
   the real guarantee in RLS.

2. **`/auth/v1/health` requires an `apikey` header.** The first version of
   `health.ts` omitted it and reported a false failure against a perfectly
   healthy project. Found by calling the endpoint directly with `curl`.

3. **A publishable key cannot read the Data API root.** Supabase restricts
   schema introspection to secret keys (`"Only secret API keys can be used for
   this endpoint"`), so the original "is the key valid?" check failed on a
   valid key. Replaced with a probe of a deliberately non-existent table, which
   cleanly separates the two cases — both branches confirmed by `curl`:

   | Key | Response |
   | --- | --- |
   | valid publishable | `404 PGRST205` — reached the database, table absent |
   | invalid | `401 Invalid API key` |

### Findings carried into phase 2

Reading `/auth/v1/settings` on the live project revealed two things that must
be changed before the six users exist:

- `disable_signup: false` — **public sign-up is currently open.** Anyone with
  the publishable key could create an account. Must be closed.
- `google: false` — Google OAuth is not yet configured.
- `email: true` — email/password is already enabled.

---

## Phase 1 — schema and the isolation guarantee

| File | Origin | Author's involvement |
| --- | --- | --- |
| `supabase/migrations/20260913160000_brands_and_isolation.sql` | AI-generated | Schema shape debated before writing: the brand-scoped uniqueness of `external_id`, and the composite foreign keys, are decisions the author can defend |
| `tests/isolation.test.ts` | AI-generated | The author specified what the test must prove; the "build fixtures, do not trust seeded rows" approach was agreed first |
| `scripts/build-schema.mjs`, `schema.sql` | AI-generated | `schema.sql` is generated, never edited |

### Grounded in the data rather than assumed

The enum vocabularies were not guessed. Every distinct value in the three
contact exports and the three event exports was counted first, which changed
the design twice:

1. **`status` is spelled six ways** — `active`, `ACTIVE`, `Active`, `active `
   (trailing space), `unsubscribe` (singular), and empty — and
   `consent_marketing` appears in **eleven** forms: `true`, `1`, `TRUE`, `yes`,
   `Y`, `f`, `false`, `FALSE`, `0`, `no`, empty. The database types are the
   canonical four and a boolean; normalising is the importer's job, and an
   unmappable value is rejected and reported rather than stored as a guess.

2. **A constraint that looked obvious was wrong.** `reported_opens <=
   reported_sent` would have been a natural check to add. Kilele campaign
   KIL-0016 reports 12,679 opens against 10,640 sent — correctly, because one
   recipient opening twice is two opens. Counting the data before writing the
   constraint is what caught it; the omission is commented in the migration so
   nobody adds it later.

A third observation is deferred to the import phase: naive column splitting on
the contact files misaligns, because fields are quoted and contain embedded
commas. The importer needs a real CSV parser, not `split(',')`.

### Verified against the live project

Applying the migration surfaced two things worth recording, both found by
running commands rather than by reasoning:

1. **`db.PROJECT_REF.supabase.co` is IPv6-only.** `supabase db push` failed
   with `ENOTFOUND`, which reads like a bad password. `nslookup` showed an
   AAAA record and no A record. The fix is the dual-stack pooler host in
   session mode (port 5432, username `postgres.PROJECT_REF`). The region was
   not guessed: the IPv6 address was matched against Amazon's published
   `ip-ranges.json`, which puts `2a05:d018::/35` in `eu-west-1`.

2. **The isolation guarantee was confirmed before the test suite could run.**
   With the publishable key and no session, all five tables return `42501
   permission denied` — not `404` — while a deliberately absent table returns
   `404 PGRST205`. That difference is the proof: the tables exist, and the
   `anon` role has no privilege on any of them, so the key that ships in the
   browser bundle is worth nothing on its own.

### The test was checked by breaking the thing it tests

The AI proposed reporting the isolation suite as passing. That was rejected as
insufficient: a suite that returns empty for every query also passes. The
`contacts` policy was therefore replaced with `using (true)` on the live
project and the suite re-run — five assertions failed, and crucially `sees
their own contact` did **not**, which is what distinguishes "isolated" from
"empty". The policy was restored and every predicate re-read from `pg_policy`
to confirm it matches the migration exactly.

This is the answer to "what you tried to break before sending it". It is worth
noting because it is the difference between a test and a decoration.

### Where the AI was overruled

- It initially reached for a predicate taking the row as an argument —
  `app.can_access_brand(brand_id)`. That form is re-evaluated per row. Changed
  to a row-independent `setof` returning function so the planner hoists it to
  an InitPlan, which matters at 84k contacts and 312k events.
- `force row level security` was proposed and dropped: `service_role` bypasses
  RLS regardless, so it would have added no protection against the threat
  actually being defended against, while adding a way to break the importer.
- A per-brand `currency_code` column was proposed for `spend`. Dropped — the
  exports never state a currency, and inventing one would be exactly the kind
  of silent assumption requirement 4 is about. The ambiguity gets disclosed on
  screen instead.

---

## Phase 2 — sign-in, sessions and roles

| File | Origin | Author's involvement |
| --- | --- | --- |
| `src/proxy.ts` | AI-generated | Author insisted the file document what it is *not* for, since proxy looks like an authorization boundary and is not one |
| `src/lib/supabase/proxy-client.ts` | AI-generated | The response-getter pattern was questioned until explained |
| `src/lib/auth/dal.ts` | AI-generated | The `cache()` scope — one render pass, not cross-request — was checked explicitly, as a cross-request cache here would serve one user another user's brand |
| `src/lib/auth/actions.ts` | AI-generated | The open-redirect guard on `next` was requested by the author |
| `src/app/login/*`, `src/app/portal/*`, `src/app/no-access/*` | AI-generated | Copy reviewed line by line |
| `src/app/auth/callback/route.ts` | AI-generated | PKCE code exchange |
| `scripts/seed-users.mjs`, `supabase/seed/portal-accounts.json` | AI-generated | Author required one source of truth shared with the test, so handed-over credentials cannot drift |
| `tests/accounts.test.ts` | AI-generated | Author specified: sign in as all six *directly against Supabase*, because that is how the brief says graders will attack it |

### Read the docs rather than the training data

`middleware.ts` is `proxy.ts` in Next.js 16, and the version-matched docs in
`node_modules/next/dist/docs/` were read before writing it. Two things came
from that reading and not from assumption:

- The docs state plainly that proxy **is not an authorization mechanism** —
  it is an optimistic check, it runs on prefetches, and it can be bypassed by
  a request that reaches a route handler directly. That is why the real check
  sits in the database and the second one in the data access layer, and why
  `src/proxy.ts` carries a comment saying deleting it would leak nothing.
- `searchParams` is a Promise in this version. Reading it synchronously is a
  type error that would have been easy to "fix" the wrong way.

### Two bugs the tests found, not the author

1. **The `.eq('user_id')` filter is load-bearing.** The `brand_members` policy
   shows you every member of your own brand, so an owner also sees their
   analyst. The DAL had the filter; the first draft of the test did not, and
   `.single()` failed with *"The result contains 2 rows"*. The test was wrong
   and the code was right — but only because the question had been thought
   about once already. Both behaviours are now asserted explicitly.

2. **The two test suites raced each other.** Vitest runs files in parallel by
   default, and the isolation suite attaches temporary fixture users to Kilele
   and Karoo — while the accounts suite was counting the members of those same
   brands. Three where there should be two. Neither suite was wrong; sharing
   one live database while running concurrently was. Fixed with
   `fileParallelism: false`, and the reason is recorded in the config so
   nobody "optimises" it back.

### Verified against the live project

`/auth/v1/settings` was read again after the work: `email: true`,
`google: false`, `disable_signup: false`. The last two are dashboard settings
that code cannot change, and both are listed as outstanding rather than
quietly assumed done.

A probe of the public sign-up endpoint returned *"Email address … is
invalid"* for a `@vg-eval.test` address — Supabase validates the domain on
the public endpoint while the admin API does not. So the six seeded accounts
could only have been created by an admin, and Google is the realistic route
by which an outsider arrives authenticated. That is exactly the case
`/no-access` exists for.
