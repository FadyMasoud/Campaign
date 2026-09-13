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
