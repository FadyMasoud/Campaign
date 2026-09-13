# Campaign Portal

A multi-tenant client campaign portal. Three brands' marketing teams sign in and
work only with their own growth data:

| Brand | Market | Relative data size |
| --- | --- | --- |
| Kilele Rides | Kenya | large (~90× the smallest) |
| Karoo Coaches | South Africa | medium |
| Marrakech Express | Morocco | small |

Each brand has an **owner** (can send campaigns) and an **analyst** (read-only).

> **Status:** Phase 1 — schema and isolation. The database schema, the Row
> Level Security policies and the isolation test are written. The app still
> renders only the setup diagnostic; sign-in arrives in phase 2.

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

### Applying the schema

Migrations are applied with the Supabase CLI, against the hosted project:

```bash
npx supabase db push --db-url "postgresql://postgres:PASSWORD@db.PROJECT_REF.supabase.co:5432/postgres"
```

`npm test` then verifies the result. The isolation suite creates its own users
and rows, asserts that neither brand can reach the other, and deletes them
again — so it proves the mechanism rather than the current arrangement of the
seeded data.

---

## Notes for reviewers

- Styling is hand-written CSS Modules over a design-token file. Light and dark
  are one set of token overrides; there is no second stylesheet.
- All directional CSS uses logical properties (`margin-inline`,
  `border-inline-start`) so Arabic right-to-left is a `dir` attribute change,
  not a parallel stylesheet.
- This project targets **Next.js 16**, in which `middleware.ts` is renamed to
  `proxy.ts`. Session refresh uses the new convention.
