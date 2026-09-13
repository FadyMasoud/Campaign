# Campaign Portal

A multi-tenant client campaign portal. Three brands' marketing teams sign in and
work only with their own growth data:

| Brand | Market | Relative data size |
| --- | --- | --- |
| Kilele Rides | Kenya | large (~90× the smallest) |
| Karoo Coaches | South Africa | medium |
| Marrakech Express | Morocco | small |

Each brand has an **owner** (can send campaigns) and an **analyst** (read-only).

> **Status:** Phase 0 — project setup. The app currently renders a setup
> diagnostic that verifies it can reach Supabase. No schema or auth yet.

---

## The one rule this project is built around

**A brand can see its own data and nothing from any other brand — on every
route into the data, permanently, including tables added later.**

This is enforced in the database with PostgreSQL Row Level Security, not in the
user interface. The UI is a convenience; the database is the guarantee. An
automated test asserts the isolation and fails if RLS is ever removed.

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

---

## Notes for reviewers

- Styling is hand-written CSS Modules over a design-token file. Light and dark
  are one set of token overrides; there is no second stylesheet.
- All directional CSS uses logical properties (`margin-inline`,
  `border-inline-start`) so Arabic right-to-left is a `dir` attribute change,
  not a parallel stylesheet.
- This project targets **Next.js 16**, in which `middleware.ts` is renamed to
  `proxy.ts`. Session refresh uses the new convention.
