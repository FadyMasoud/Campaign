# Campaign Portal

A multi-tenant client campaign portal. Three brands' marketing teams sign in and
work only with their own growth data:

| Brand | Market | Relative data size |
| --- | --- | --- |
| Kilele Rides | Kenya | large (~90× the smallest) |
| Karoo Coaches | South Africa | medium |
| Marrakech Express | Morocco | small |

Each brand has an **owner** (can send campaigns) and an **analyst** (read-only).

> **Status:** Phase 2 — sign-in. Six accounts sign in and land in their own
> brand's portal. Google sign-in is wired end to end but the provider is not
> yet enabled on the Supabase project. Importing the real data is phase 3, so
> the portal currently shows an empty state.

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
