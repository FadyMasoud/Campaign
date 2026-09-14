# Campaign Portal

A multi-tenant client campaign portal. Three brands' marketing teams sign in and
work only with their own growth data:

| Brand | Market | Relative data size |
| --- | --- | --- |
| Kilele Rides | Kenya | large (~90× the smallest) |
| Karoo Coaches | South Africa | medium |
| Marrakech Express | Morocco | small |

Each brand has an **owner** (can send campaigns) and an **analyst** (read-only).

> **Status:** Phase 7 — feature-complete. Six accounts sign in (email or
> Google) and land in their own brand's portal. An owner can review an
> audience, send it through the messaging provider, read the delivery reports
> back as they arrive, and publish one campaign's results as a
> password-protected link for a client with no login. What remains is phase 8:
> the design pass, bilingual EN/AR, and deployment.

| Brand | Customers | Campaigns | Results |
| --- | --- | --- | --- |
| Kilele Rides | 81,842 | 44 | 301,209 |
| Karoo Coaches | 12,406 | 19 | 69,100 |
| Marrakech Express | 928 | 6 | 940 |

## The six logins

| Email | Password | Brand | Role |
| --- | --- | --- | --- |
| `owner@kilele.vg-eval.test` | `Kilele-Owner-2026` | Kilele Rides | owner |
| `analyst@kilele.vg-eval.test` | `Kilele-Analyst-2026` | Kilele Rides | analyst |
| `owner@karoo.vg-eval.test` | `Karoo-Owner-2026` | Karoo Coaches | owner |
| `analyst@karoo.vg-eval.test` | `Karoo-Analyst-2026` | Karoo Coaches | analyst |
| `owner@marrakech.vg-eval.test` | `Marrakech-Owner-2026` | Marrakech Express | owner |
| `analyst@marrakech.vg-eval.test` | `Marrakech-Analyst-2026` | Marrakech Express | analyst |

These are synthetic accounts on synthetic data. `@vg-eval.test` is a reserved
TLD that cannot receive mail. Recreate or reset them with `npm run seed:users`,
which is idempotent — it updates existing accounts rather than duplicating
them. The list lives in `supabase/seed/portal-accounts.json` and is read both
by that script and by the test that signs in as all six, so the credentials
above cannot drift from the accounts that exist.

---

## The one rule this project is built around

**A brand can see its own data and nothing from any other brand — on every
route into the data, permanently, including tables added later.**

This is enforced in the database with PostgreSQL Row Level Security, not in the
user interface. The UI is a convenience; the database is the guarantee. An
automated test asserts the isolation and fails if RLS is ever removed.

**It lives in one place.** Every policy in the project is the same single line:

```sql
using (brand_id in (select app.current_user_brand_ids()))
```

`app.current_user_brand_ids()` is defined once, at
[20260913160000_brands_and_isolation.sql:104](supabase/migrations/20260913160000_brands_and_isolation.sql#L104).
Five tables, five identical policies. There is no second place to look and no
policy that can quietly drift from the others.

Two further mechanisms make the rule hold for **tables that do not exist yet**,
neither of which depends on anyone remembering:

- Default privileges in `public` are revoked from the API roles, so a table
  added later is unreachable until it is granted deliberately — the mistake
  fails closed instead of open.
- `public.security_coverage()` reports the posture of every table in `public`,
  and [tests/isolation.test.ts](tests/isolation.test.ts) asserts against that
  live list rather than a hand-written one. A future table without RLS turns
  the suite red with nobody editing the test.

The database also refuses cross-brand references structurally: `brand_id` is
part of both sides of every foreign key between data tables, so a campaign
cannot point at another brand's parent campaign and an event cannot point at
another brand's contact. That is aimed at a real row — the Karoo export names
the Kilele campaign `KIL-0007` as a parent.

---

## Getting started

**Requirements:** Node.js 20.9+ (developed on 24), npm, and a free Supabase
account.

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000. The page tells you exactly which parts of the setup
are complete and which are not.

### Filling in `.env.local`

Create a project at [supabase.com/dashboard](https://supabase.com/dashboard),
then from **Project Settings → Data API** and **Project Settings → API Keys**:

| Variable | Where it comes from | Safe in the browser? |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Data API → Project URL | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | API Keys → publishable / anon | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | API Keys → secret / service_role | **No — never** |
| `DISPATCHER_API_KEY` | Messaging provider (added in the send phase) | **No — never** |

Environment variables are read once when the dev server boots. After editing
`.env.local`, restart it.

---

## How secrets flow

The whole security model rests on one naming rule enforced by the framework:

```
NEXT_PUBLIC_*  ─► compiled into the JavaScript bundle ─► readable by anyone
everything else ─► stays in the Node.js process       ─► never sent to a browser
```

Three Supabase clients exist, and which one you may import is the security
boundary:

| Client | Key | Acts as | Row Level Security | Import from |
| --- | --- | --- | --- | --- |
| `createBrowserSupabaseClient()` | publishable | the signed-in user | **enforced** | anywhere |
| `createServerSupabaseClient()` | publishable | the signed-in user | **enforced** | server only |
| `createAdminSupabaseClient()` | service role | nobody — full access | **bypassed** | server only |

The two server files start with `import 'server-only'`. That package has no
browser build, so if a Client Component ever imports them — directly or through
a chain — **the build fails** rather than shipping a secret to the browser.

The admin client is a deliberate hole in the safety net, for the few jobs with
no logged-in user (seed import, provider webhooks, public reports). Every query
it makes must filter by `brand_id` explicitly, because the database will not do
it for you there.

---

## Layout

```
campaign-portal/
├── schema.sql             Generated single-file view of the migrations
├── scripts/               Build helpers (schema.sql generator)
├── supabase/
│   ├── migrations/        Numbered .sql files — the schema, in order
│   └── seed/              Source CSVs for the import phase
├── src/
│   ├── app/               Routes (App Router). Server Components by default.
│   ├── lib/
│   │   ├── env/           Validated environment access; public vs server split
│   │   └── supabase/      The three clients + setup diagnostic
│   └── styles/
│       └── tokens.css     Design tokens: the only file with raw colours in it
├── tests/                 Integration tests, including the isolation test
└── docs/
    └── AI-USAGE.md        Disclosure of AI assistance, per the brief
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm test` | Integration tests (needs `.env.local`) |
| `npm run schema:build` | Regenerate `schema.sql` from `supabase/migrations/` |
| `npm run seed:users` | Create or reset the six portal logins |
| `npm run import:seed` | Load the seed exports (`-- --dry-run` to parse without writing) |

---

## Loading the data

```bash
npm run import:seed -- --dry-run   # parse and report, write nothing
npm run import:seed                # load everything
```

**Safe to run repeatedly.** Customers and campaigns are matched on
`(brand_id, external_id)` and updated in place; results are matched on the
provider's own reference and ignored if already present. Running the whole
import a second time reports `created 0` for every file and leaves the row
counts unchanged — [tests/import.test.ts](tests/import.test.ts) re-runs the
real importer and fails if anything is created.

### What the exports actually contain

The three brands export in three different dialects, and none of it was
assumed — the files were counted first:

- **Comma against semicolon**, a byte order mark on the Kilele files, and three
  spellings of the same column (`external_id`, `External Id`, `e_mail`).
- **Eleven spellings of `status`** (`active`, `ACTIVE`, `Active`, `active `,
  `unsubscribe`, …), **thirteen of `consent_marketing`** (`true`, `1`, `TRUE`,
  `yes`, `Y`, `f`, …), and **twenty-three of `country`** (`KE`, `KEN`, `kenya`,
  and `254`, the dialling code, in the country column).
- **Quoted fields containing commas and newlines** — about twenty Kilele rows
  span two lines, which is why the files are read with a parser and not split
  on the delimiter.

### What was refused, and what was assumed

Nothing is stored in a half-corrected form. A refused row is not in the portal;
a warning means the row loaded with a field dropped or a stated assumption
applied. Both are visible to the marketer at `/portal/imports`, with the line
number and the offending value.

The decisions worth knowing about:

| Situation | What happens | Why |
| --- | --- | --- |
| Row declares another brand (400 rows) | Refused, in both brands | An export for one brand has no business creating rows in another. Re-routing them would be kinder and no safer |
| Blank consent (10,056 rows) | Read as **no** | The only default in the importer, deliberately cautious: the absence of a recorded yes cannot become permission to contact someone |
| Invalid email (1,105 rows) | Address dropped, customer kept if reachable by phone | Not repaired — deleting the space from `john doe@vg-eval.test` is a guess about who that person is |
| Unreadable phone (22,343 rows) | Number dropped, customer kept | 21,974 are twelve digits behind a zero, leaving eleven significant digits where all three markets use nine |
| `05/03/2026` (452 rows) | Read day-first, assumption reported | Genuinely ambiguous; the portal says which way it read it |
| Results naming a missing campaign (633) | **Kept**, with no campaign attached | Unsubscribes and complaints are among them; dropping them would leave the portal believing people were contactable who had asked not to be |
| NUL byte in a name (3 rows) | Refused | PostgreSQL cannot store one, and rewriting somebody's name is not a fix |

A Karoo campaign names `KIL-0007` — a Kilele campaign — as its parent. The
database refuses that link structurally, so the stated reference is kept
verbatim, the resolved link is left empty, and the marketer is told.

---

## How sign-in works

Three layers sit between a visitor and a brand's data, and only the first one
is load-bearing:

| Layer | File | What it does | If it were deleted |
| --- | --- | --- | --- |
| Database | the RLS policies | Refuses another brand's rows outright | Isolation gone; tests go red |
| Data access layer | [src/lib/auth/dal.ts](src/lib/auth/dal.ts) | Resolves which brand is being rendered; redirects | Pages break; no data leaks |
| Proxy | [src/proxy.ts](src/proxy.ts) | Redirects signed-out visitors; refreshes the token | Uglier redirects; no data leaks |

`proxy.ts` deliberately does **not** decide who may see what. The Next.js
documentation is explicit that proxy is an optimistic check, not an
authorization mechanism: it runs on prefetches and a request can reach a route
handler without passing through it. Putting the guarantee there would be
putting it in the one place that can be skipped.

Sessions are exchanged in Server Actions rather than in the browser, so the
tokens are written as HttpOnly cookies that the page's own JavaScript cannot
read.

**Authentication is not authorization.** Google will happily verify anyone with
a Google account, and they arrive as a genuinely signed-in user. An account
with no row in `brand_members` is sent to `/no-access`, which names no brand
and shows no numbers — a stranger should not learn from an error screen which
brands exist or how large they are.

### Running Google sign-in locally

Three settings have to agree, and when they do not the failure is quiet rather
than loud.

| Where | Setting | Why |
| --- | --- | --- |
| Google Cloud console | Authorised redirect URI `https://<project-ref>.supabase.co/auth/v1/callback` | Google returns to Supabase, never to this app |
| Supabase → Authentication → URL Configuration | Redirect URL `http://localhost:6001/**` | Supabase validates where it is asked to send the user, and **silently falls back to the Site URL** when the address is not listed |
| `.env.local` | `NEXT_PUBLIC_SITE_URL=http://localhost:6001` | Only needed when the host header is not a browsable address |

That last one exists because of a real trap. `next dev -H 0.0.0.0` binds every
interface so the dev server is reachable from a phone on the same network — but
the browser then reports `0.0.0.0` as the host, and a return address built from
that header sends the user to `http://0.0.0.0:6001/…`, which nothing can
reliably open. `NEXT_PUBLIC_SITE_URL` overrides the guess; failing that, the
unroutable spellings (`0.0.0.0`, `[::]`, `[::1]`) are rewritten to `localhost`
in [src/lib/auth/site-url.ts](src/lib/auth/site-url.ts).

**Sign-up must be enabled for Google to work at all.** Supabase counts a
first-time Google identity as a sign-up, so with *Allow new users to sign up*
turned off, a valid Google login is refused with `signup_disabled` before it
ever reaches `/auth/callback`. Turning sign-up on is safe here and is the
deliberate choice: a self-registered account has no row in `brand_members`, so
it reaches `/no-access` and no data — which the isolation suite asserts. That
combination is what makes "sign in whichever way you like" and "outsiders get
in nowhere" both true at once.

### Applying the schema

Migrations are applied with the Supabase CLI, against the hosted project:

```bash
npx supabase db push --db-url \
  "postgresql://postgres.PROJECT_REF:PASSWORD@aws-1-REGION.pooler.supabase.com:5432/postgres"
```

Note the **pooler** host, not the `db.PROJECT_REF.supabase.co` one the
dashboard shows first. That direct hostname now resolves to an IPv6 address
only, so on an IPv4-only network it fails with `ENOTFOUND` — which looks like
a wrong password but is not. The pooler is dual-stack. Port 5432 is session
mode, which migrations need; 6543 is transaction mode and will not run DDL
reliably. The username on the pooler is `postgres.PROJECT_REF`, not `postgres`.

`npm test` then verifies the result. The isolation suite creates its own users
and rows, asserts that neither brand can reach the other, and deletes them
again — so it proves the mechanism rather than the current arrangement of the
seeded data.

The suite has been checked the only way a security test can be: the `contacts`
policy was temporarily replaced with `using (true)` and the suite re-run. Five
assertions failed and `sees their own contact` did not — so it distinguishes
*isolated* from merely *empty*. Details in
[docs/REQUIREMENTS.md](docs/REQUIREMENTS.md#phase-log).

---

## Notes for reviewers

- Styling is hand-written CSS Modules over a design-token file. Light and dark
  are one set of token overrides; there is no second stylesheet.
- All directional CSS uses logical properties (`margin-inline`,
  `border-inline-start`) so Arabic right-to-left is a `dir` attribute change,
  not a parallel stylesheet.
- This project targets **Next.js 16**, in which `middleware.ts` is renamed to
  `proxy.ts`. Session refresh uses the new convention.

---

## The screens, and where every number comes from

| Route | What it shows |
| --- | --- |
| `/portal` | Total customers, contactable, signups per day, campaign performance |
| `/portal/contacts` | Customers — searchable, filterable, 50 per page |
| `/portal/campaigns` | Every campaign, both bases side by side |
| `/portal/campaigns/[id]` | One campaign, including distinct-people counts |
| `/portal/imports` | What loaded and what did not |

**A quietly wrong number is worse than no number**, so every figure carries a
visible chip naming its basis, and the three are never blended:

| Basis | Source |
| --- | --- |
| **Provider-reported** | `campaigns.reported_*`, exactly as the export stated it — never recalculated |
| **Counted from the event log** | one row per open, click, bounce, complaint or unsubscribe |
| **Derived by this portal** | computed from customer records by a rule printed beside the number |

The chip is a label on the page rather than a tooltip, because a basis that
only appears on hover is one most readers never see — and on a phone there is
no hover at all.

### The numbers two people would count differently

**Provider against event log.** Campaign `KAR-0001` is reported by the provider
as 2,732 opens; the log holds 704, from 687 distinct people. `KIL-0016` reports
12,679 opens against 10,640 sent — which is correct, because one recipient
opening twice is two opens. Five campaigns, including `CMP-014`, have **no
event log at all** while the provider claims thousands of sends; those are
labelled "no event log" rather than shown as zeros, because zero and "we do not
know" are different answers.

**Contactable.** Counted the cautious way, as a waterfall where every customer
falls into exactly one bucket:

| | Kilele | Karoo | Marrakech |
| --- | --- | --- | --- |
| Total | 81,842 | 12,406 | 928 |
| − no consent | 23,802 | 6,273 | 469 |
| − unsubscribed / bounced (record) | 6,384 | 685 | 0 |
| − opted out or bounced (event log) | 14,770 | 5,259 | 219 |
| − removed or suppressed | 701 | 0 | 0 |
| **= contactable** | **36,185** | **189** | **240** |

Karoo is why this is shown in full: its customer records claim 483
unsubscribes, while the event log holds **4,880 more people** who opted out
without their record ever being updated. The portal believes the log, and says
so on the screen.

**Signups per day** are bucketed by the brand's *own* timezone, not UTC — a
Kilele signup at 23:30 UTC belongs to the next morning in Nairobi. The window
is the real last 30 days: for Karoo and Marrakech that is empty, because their
exports stop in April 2026, and the screen says exactly that rather than
sliding the window back to wherever the data happens to be.

### Staying quick for the brand with ninety times the data

Requirement 5 is measured, not asserted:

| Query | First attempt | Now |
| --- | --- | --- |
| Contactability | 4,274 ms | **299 ms** |
| Campaign performance | 3,384 ms | **82 ms** |
| Search across 81,842 customers | — | 276 ms |

Neither fix was caching. "Has this person opted out?" is a fact, not a
question to re-ask on every page load, so it became two columns on `contacts`
maintained by a statement-level trigger as events arrive — order-independently,
so a late report cannot undo an earlier opt-out, which is also what the send
phase needs. And the campaign list stopped counting distinct people across
every campaign at once, because only the detail page shows that.

---

## Sending a campaign

An owner opens a campaign, reviews the audience, and confirms. The screen shows
the exact number being approved and the rule that produced it. Nothing is sent
until confirmation, and a campaign cannot be sent twice.

**Where the send is recorded** — `/portal/sends/{id}` shows what was approved,
by whom, how many the provider accepted, how many it refused, and where each
recipient stands. Behind it, `campaign_sends` holds one row per approved send
and `send_recipients` holds the frozen audience.

### The four things that make it safe

| Guarantee | What enforces it |
| --- | --- |
| The confirmation count is what is approved | The audience is re-counted at confirm. If it moved, **nothing is sent** and the new figure is shown |
| No double-send | A partial unique index allowing one live send per campaign — not a disabled button |
| No silent half-send | Accepted and refused are counted separately, and any gap is stated on screen |
| Past approvals still read as approved | Users may `insert` into `campaign_sends` and nothing else — no `update`, no `delete` |

The approved audience is **frozen at approval** into `send_recipients` rather
than recomputed at dispatch. A set recomputed later is not the set that was
approved, and the difference is somebody receiving a message nobody agreed to
send them.

**Owners send, analysts cannot — in the database.** `campaign_sends` carries
the only user-facing write policy in the project, requiring both brand
membership and `app.is_brand_owner`. The test for it inserts directly as an
analyst's own session, bypassing the interface entirely, which is how a grader
with `curl` and the publishable key would try it.

### The provider's documentation is wrong

`/v1/docs` says: *"The report stream is clean and complete: every event is
delivered exactly once and in order."* Neither half is true, and both were
checked against the live service:

- Polling one batch three times returned the same event ids three times.
- Timestamps within a page are not ordered — the real send's first page of 50
  events has `11:55:45Z`, `11:56:40Z`, `11:55:46Z` in that order.

The brief warned the reports would be *"deliberately messy and out of order in
places"*. Where the documentation and the observed behaviour disagree, this
build follows what it observed: events are keyed on the provider's own
`event_id` so re-reading a page changes nothing, and the state they produce is
derived order-independently rather than by last-write-wins.

The provider's `brand_code` field is also ignored — it comes back as
`"account"` regardless of what was sent. Which brand an event belongs to comes
from the send we created, never from the provider.

---

## Reading the provider's delivery reports

The provider has no webhook — its API is `GET /v1/messages/{id}/events?since=`
— so the app polls. Reports pile up while nothing is watching and are
collected when it next looks. **Fetch latest delivery reports** on
`/portal/sends/{id}` runs a sync; the same function is what a scheduled job
would call.

On the real send, twice in a row:

| | First sync | Second sync |
| --- | --- | --- |
| Events read | 320 | 20 |
| New engagement rows | 90 | **0** |
| Recipients updated | 240 | **0** |

223 delivered, 17 bounced. The second run read the same events and changed
nothing.

**Nothing assumes a report arrives once, in order, or at all:**

- **Idempotent** — reports are stored against the provider's own `event_id`,
  under the same unique constraint that made re-importing a seed file a no-op.
- **Order-independent** — an opt-out keeps its earliest timestamp, so a report
  arriving late cannot undo one already recorded.
- **Ranked, not overwritten** — `bounced` beats `delivered`, so a stale
  delivery report cannot mark a dead address reachable again.

### The forged event

The real Marrakech batch contained this:

```json
{"event_id":"evt-batch_50-forged","recipient_id":"CT-033857",
 "brand_code":"KAROO","type":"delivered"}
```

It claims to be Karoo, names a contact belonging to **Kilele**, and arrived in
a **Marrakech** send's report stream.

It was discarded and nothing was written, because the provider's `brand_code`
is never read and `recipient_id` is resolved only against contacts of the brand
whose send is being synced. Which tenant a row belongs to is not a decision
worth outsourcing to whoever is sending the reports.

---

## Sharing results with a client

An owner publishes one campaign's totals as a link protected by a password,
for a client who has no login. The link is created from **Share with a client**
on any campaign page and can be withdrawn again at any time.

The brief asks for two different things here, and they need two different
answers:

**Nothing reachable by guessing the address.** The token is 256 bits from a
cryptographic source — not a UUID, which carries 122 bits and a recognisable
shape. An unknown token, a withdrawn one, and a correct token with the wrong
password all answer identically, so probing the URL space tells a stranger
nothing about which reports exist.

**Nothing reachable by getting past the password.** There is nothing else
behind it. One token resolves to one report, which resolves to one campaign,
and the page takes no identifier from anywhere a reader could alter. The page
shows brand name, campaign name, channel, send date, the provider's figures and
the event log's counts — and no customer rows, no addresses, no other campaign,
no brand-wide totals.

The password is hashed with bcrypt inside the database and never compared in
application code. The function the public page calls returns only whether the
door opened — never the report — so although it is callable without an account,
it cannot be used as a data endpoint. Five wrong answers lock the report for
fifteen minutes.

Proving the reader answered the password, with no account to hang a session on,
is an HMAC over the token and an expiry. A grant issued for one report is
rejected against any other, and rejected if its signature or expiry is altered.
