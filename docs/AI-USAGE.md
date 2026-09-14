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

---

## Phase 3 — loading the data

| File | Origin | Author's involvement |
| --- | --- | --- |
| `supabase/migrations/…_import_runs_and_issues.sql` | AI-generated | Author required refusals and warnings to be separate columns, not one "problems" count |
| `supabase/migrations/…_import_issue_summary.sql` | AI-generated | The SECURITY INVOKER choice was checked explicitly against the definer used in phase 1 |
| `src/lib/import/normalise.ts` | AI-generated | Every mapping argued from counted values; the consent default was the author's call |
| `src/lib/import/dialect.ts`, `rows.ts` | AI-generated | The refuse-vs-reroute decision for wrong-brand rows was the author's |
| `scripts/import-seed.ts` | AI-generated | Bulk loading strategy discussed before writing |
| `tests/normalise.test.ts`, `tests/import.test.ts` | AI-generated | Author required inputs be taken from the real files, not invented |
| `src/app/portal/imports/*` | AI-generated | Copy reviewed line by line |

### The data was counted before any code was written

Four reconnaissance passes over the exports came first, and each changed the
design:

1. **Three dialects.** Comma against semicolon, a byte order mark on the Kilele
   files, and three spellings of the same column (`external_id`, `External Id`,
   `e_mail`). Snake-casing every heading collapses most of it; a four-entry
   alias table handles the French column names.
2. **Naive column splitting misaligns.** An early `cut`-based tally reported
   timestamps in the status column. The fields are quoted and contain embedded
   commas and newlines — about twenty Kilele rows span two lines. This is why a
   real parser is used rather than `split(',')`.
3. **The vocabularies.** Eleven spellings of status, thirteen of consent,
   twenty-three of country. All mapped from counted values.
4. **The traps.** 400 rows declaring the wrong brand, a header line repeated
   mid-file, three NUL bytes, a campaign whose parent belongs to another brand,
   633 results naming campaigns that are not in the export.

### Where the AI was overruled

- It proposed **re-routing** rows that declare another brand to the brand they
  name. Refused: an export for one brand has no business creating rows in
  another, and silently moving 400 customers between tenants is the exact
  failure this project guarantees against. They are refused and counted.
- It proposed **repairing** invalid email addresses by stripping internal
  spaces. Refused: `john doe@vg-eval.test` minus the space is a guess about who
  that person is, and mail to a guessed address is worse than no mail.
- It proposed **stripping** the NUL bytes so the rows could load. Refused: the
  byte sits inside a name, and editing somebody's name to something nobody
  chose is not a fix.
- It proposed **dropping** the 633 Moroccan results whose campaign is missing.
  Refused: unsubscribes and complaints are among them, and losing those would
  leave the portal believing people were contactable who had asked not to be.
  They are kept with no campaign attached.

### Two bugs the tests found

1. **A confident wrong phone number.** The first length check accepted 8–15
   digits, which turned `025701347763` into `+25425701347763` — nobody's
   number. Replaced with a per-market numbering plan of exactly nine
   significant digits.
2. **The fix then broke something else.** Requiring numbers to match the
   brand's own country rejected 6,493 Karoo contacts holding valid Kenyan
   `+254` numbers. A number that states its country code is unambiguous
   wherever it appears; the market a brand sells in does not constrain where
   its customers hold a phone.

### A self-inflicted one worth recording

The importer died mid-run on `invalid byte sequence for encoding "UTF8"`. The
guard against NUL bytes had been written as `split(NUL).join('\0')` — and `\0`
in JavaScript *is* the NUL character, so it replaced NUL with NUL and did
nothing. It now joins with a readable `<NUL>` marker, and the database writer
strips NUL from quoted values as well, because the value echoed back into an
error report is arbitrary input from a file nobody controls.

---

## Phase 4 — the read UI and the metric definitions

| File | Origin | Author's involvement |
| --- | --- | --- |
| `supabase/migrations/…_analytics.sql` | AI-generated | The SECURITY INVOKER choice was checked against the definer used in phase 1 |
| `supabase/migrations/…_contactability_state.sql` | AI-generated | Author required the trigger be statement-level, not row-level, before it was written |
| `supabase/migrations/…_campaign_performance_split.sql` | AI-generated | Splitting list from detail was the author's call after seeing the timings |
| `supabase/migrations/…_contact_search.sql` | AI-generated | pg_trgm chosen over prefix-only search deliberately |
| `src/lib/analytics/queries.ts` | AI-generated | The three-basis model is the author's design |
| `src/app/portal/*` | AI-generated | Copy reviewed line by line; the basis chip was required to be visible, not a tooltip |
| `tests/analytics.test.ts`, `tests/contactability.test.ts` | AI-generated | The five areas of coverage were specified by the author |

### The brief was re-read before building, not after

Both PDFs were extracted and reconciled against the tracking document before
any code was written, which caught three things:

1. The brief names **three views explicitly** — a contacts view, a campaigns
   view and a dashboard. The tracking document had recorded phase 4 only as
   "numbers are right" and would have under-built it.
2. The author's own build guide requires **light/dark mode and bilingual
   EN/AR with RTL**. The tracking document had them recorded as out of scope,
   which was true of the official brief and false of the guide.
3. Two data traps that survived phase 3: **88 Kilele contacts with signup
   dates up to June 2027**, and **no signups at all in the real last 30 days**
   for Karoo and Marrakech, whose exports stop in April 2026.

### Where the AI was overruled

- It proposed sliding the signups window back to "the last 30 days that
  contain data", so every brand would show a populated chart. Refused: that
  quietly redefines the phrase the brief uses. The window is the real last 30
  days, and the empty case says so in words, naming the most recent signup.
- It proposed a single contactable figure from stored status alone. Refused:
  Karoo's records claim 483 unsubscribes while the log holds 4,880 more
  people who opted out. The log is what happened.
- It proposed reconciling the provider's figures with the event log into one
  "best" number per campaign. Refused outright — that is precisely the
  quietly-wrong number the brief warns about. Both are shown, labelled.
- It proposed caching the slow dashboard query. Refused in favour of fixing
  the shape: the question "has this person opted out?" is a fact, not a
  query, so it became two columns maintained by a trigger.

### Measured, not assumed

The first contactability query was correct and took **4.3 seconds** — it
joined 95,176 contacts against 371,249 events on every page load. The second
attempt at campaign performance took **3.4 seconds** because it counted
distinct contacts across every campaign at once. Both were found by timing
them, not by reading them, and both fixes were structural:

| Query | Before | After |
| --- | --- | --- |
| Contactability | 4,274 ms | 299 ms |
| Campaign performance | 3,384 ms | 82 ms |

### A limitation found and reported rather than papered over

`notFound()` inside a matched dynamic route returns HTTP 200, because the
portal layout has already started streaming. The page content is correct and
leaks nothing — verified by checking the response for another brand's
identifiers and finding none — but the status is wrong. It is recorded as a
known issue rather than quietly left for a grader to find.

---

## Phase 5 — sending

| File | Origin | Author's involvement |
| --- | --- | --- |
| `supabase/migrations/…_sending.sql` | AI-generated | The one-live-send-per-campaign index, rather than a form token, was the author's call |
| `src/lib/provider/dispatcher.ts` | AI-generated | Written only after the real API was probed; nothing about it was guessed |
| `src/lib/send/audience.ts` | AI-generated | One audience definition shared by preview and send was a stated requirement |
| `src/lib/send/actions.ts`, `dispatch.ts` | AI-generated | Approving as the user rather than as admin is the point, and was insisted on |
| `src/app/portal/campaigns/[campaignId]/send/*`, `src/app/portal/sends/[sendId]/*` | AI-generated | Copy reviewed line by line |
| `tests/sending.test.ts` | AI-generated | The attacks were taken from the brief verbatim |

### The API was read and probed, never guessed

The build guide says the provider's docs must be pasted in rather than
invented. They were fetched from `/v1/docs` and then tested against the live
service before any code was written. Three things came out of that:

1. **The `Idempotency-Key` header is real.** Posting the same key twice
   returned the same `batch_id`; omitting it produced a new one. That is what
   makes a retry after a timeout safe, so the send's own id is used as the key.
2. **The documentation is wrong about the event stream.** It states *"every
   event is delivered exactly once and in order"*. Polling one batch three
   times returned the same event ids three times, and timestamps within a page
   are not ordered. The brief had warned the reports would be messy; the docs
   claim otherwise; the observed behaviour settles it.
3. **The provider's `brand_code` is useless.** It returns `"account"` whatever
   is sent. Using it to decide which brand an event belongs to would let the
   provider assign rows to the wrong tenant, so it is ignored entirely.

### Where the AI was overruled

- It proposed a form-generated idempotency token to stop double-submits.
  Refused: that defends one browser tab against itself and nothing else. Two
  sessions would each carry their own token and both would succeed. Replaced
  with a partial unique index, which is what actually makes the race safe.
- It proposed writing the approval with the admin client "for reliability".
  Refused outright — that would bypass the owner policy, which is the single
  thing the brief asks to be enforced for this feature.
- It proposed recomputing the audience at dispatch time. Refused: the list is
  frozen at approval, because a set recomputed later is not the set that was
  approved.
- It proposed treating a partial acceptance as success. Refused: accepted and
  refused counts are stored separately and the gap is stated on screen, since
  a send that quietly reached fewer people than approved is precisely the
  failure the brief names.

### Two problems found by running it

1. **`server-only` blocks a plain Node script**, which is exactly its job. The
   end-to-end send had to be driven with `--conditions=react-server`, the
   condition the package is built around. That the guard fired is evidence it
   works.
2. **The test fixtures exhausted themselves.** Each sending test needs a
   campaign with no live send, and Marrakech has six; holding sends until the
   end of the file ran out part-way through. The tests were wrong, not the
   code — cleanup moved to `afterEach`.

### A real send was made

Marrakech `MAR-0001`: 240 approved, 240 frozen, 240 accepted by the provider,
batch `batch_50e1f5a496627f640a36`. A first attempt was made through a harness
that passed `approved_count: 0`, which would have displayed as a false
half-send; that record was deleted and the send redone with the count a
marketer would actually have seen, rather than left in the database as a
misleading artefact.

---

## Phase 6 — ingesting the provider's reports

| File | Origin | Author's involvement |
| --- | --- | --- |
| `supabase/migrations/…_provider_reports.sql` | AI-generated | Ranking delivery status rather than overwriting it was specified before writing |
| `supabase/migrations/…_apply_reports_callable.sql` | AI-generated | Corrects two mistakes in the previous migration, both found by running it |
| `src/lib/provider/ingest.ts` | AI-generated | Saving the cursor *after* applying a page, never before, was the author's requirement |
| `src/lib/provider/actions.ts` | AI-generated | The brand check before touching the service role was insisted on |
| `src/app/portal/sends/[sendId]/sync.tsx` | AI-generated | Copy reviewed; the message reports how many were NEW, not how many were read |
| `tests/provider-reports.test.ts` | AI-generated | Cases taken from what the live service actually returned |

### The provider planted a forged cross-tenant event

Syncing the real Marrakech send reported `unmatched: 1`. Chasing that one row
found this in the stream:

```json
{"event_id":"evt-batch_50-forged","recipient_id":"CT-033857",
 "brand_code":"KAROO","type":"delivered"}
```

An event claiming to be Karoo, naming a contact that belongs to Kilele,
delivered inside a Marrakech batch. Its own id says `forged`.

It was discarded without anything being written, because of two decisions
taken before it was ever seen: the provider's `brand_code` is never read, and
`recipient_id` is resolved only against contacts of the brand whose send is
being synced. Either shortcut — trusting the label, or resolving the reference
globally — would have written another tenant's row.

This is the strongest evidence in the project that the isolation work was not
theoretical, and it is now a test.

### Two mistakes, both found by running it

1. **The applier was unreachable.** It was written into the `app` schema,
   which is deliberately not exposed through the API — that being the whole
   reason the isolation predicate lives there. But this function has to be
   called *by* the application, so it belongs in `public`, with execute granted
   to `service_role` alone. The first sync failed with "Could not find the
   function", which is the schema doing exactly what it was set up to do.
2. **It used a temporary table across two statements.** Rewritten as one
   statement of common table expressions, which is simpler and genuinely
   atomic: a page of reports now applies in full or not at all, so an
   interrupted sync cannot leave a recipient marked delivered while the
   matching engagement row is missing.

### Where the AI was overruled

- It proposed saving the cursor before applying a page, "to avoid reprocessing".
  Refused: a crash between the two would skip a page that was never applied.
  The cursor is saved afterwards, and reprocessing is free because the same
  report cannot be applied twice.
- It proposed taking the brand from the event's `brand_code`, which is what
  the field appears to be for. Refused — and the forged event proved the
  refusal right within the hour.
- It proposed last-write-wins for delivery status. Refused: a stale
  `delivered` would resurrect a bounced address, which is the precise failure
  the brief describes.

---

## Phase 7 — the shared link

| File | Origin | Author's involvement |
| --- | --- | --- |
| `supabase/migrations/…_shared_reports.sql` | AI-generated | Returning an outcome rather than the report from the anon-callable function was the author's requirement |
| `src/lib/reports/session.ts` | AI-generated | Deriving the signing key from an existing secret rather than adding a new one was discussed and agreed |
| `src/lib/reports/read.ts`, `actions.ts` | AI-generated | The "no id a reader could change" rule is the author's |
| `src/app/r/[token]/*` | AI-generated | Copy reviewed line by line |
| `tests/shared-report.test.ts` | AI-generated | Written from the stranger's position — publishable key, no session |

### Where the AI was overruled

- It proposed having `unlock_shared_report()` return the campaign figures on
  success, "to save a round trip". Refused: that makes an anon-callable
  function into a data endpoint handing out results to anyone who guesses a
  token and a password. It returns an outcome; the figures are read separately
  under the service role, which no browser can reach.
- It proposed different messages for an unknown token and a wrong password,
  as better usability. Refused — that turns the endpoint into an oracle for
  which tokens exist. Both answer `denied`, and a withdrawn link answers the
  same.
- It proposed `crypto.randomUUID()` for the token. Refused: a v4 UUID carries
  122 bits and a recognisable shape. 32 bytes from `randomBytes` instead.
- It proposed reusing `campaign_performance()` on the public page. Refused —
  that function returns every campaign in the brand, which is far more than
  this page is allowed to know, and relying on filtering afterwards is exactly
  the habit this project avoids.

### Verified without a browser

The machine ran out of memory during this phase — 379 MB free of 7.9 GB — and
both `next build` and `next dev` died with V8 heap errors after serving a
single request. Rather than claim a check that had not happened, the parts that
could be tested directly were:

- the object the public page renders, read through the real function, showing
  aggregates only and nothing about any customer;
- an unknown token returning null, which is what produces the 404;
- the grant cookie, rejected when replayed against another token, when its
  signature is altered, and when its expiry is extended.

The rendered pages for this phase have still not been opened in a browser, and
that is recorded as outstanding rather than assumed fine.
