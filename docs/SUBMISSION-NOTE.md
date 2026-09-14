# The 300-word note — draft

> The brief asks for four things in 300 words max: what you tried to break
> before sending it, where the data-isolation guarantee lives (file and line),
> which number you are least sure about, and what isn't finished. This draft
> answers all four in 287 words. The three bracketed facts are the author's to
> fill in.

---

**What I tried to break.** I replaced the `contacts` RLS policy with
`using (true)` and re-ran the suite: five assertions failed and *"sees their
own contact"* stayed green, which is what distinguishes isolated from empty.
I confirmed a send twice from two sessions at once — one approval wins, one is
refused by a unique index, not a disabled button. I signed in as an analyst and
inserted straight into `campaign_sends`, bypassing the interface; the database
refused it. I polled the provider three times and it re-served the same events
each time, so nothing is applied twice. And the provider sent me an event whose
id was literally `evt-batch_50-forged`, claiming brand KAROO, naming a KILELE
contact, inside a MARRAKECH batch — it was discarded, because a provider's own
label never decides which tenant a row belongs to.

**Where isolation lives.**
`supabase/migrations/20260913160000_brands_and_isolation.sql:104` —
`app.current_user_brand_ids()`. Every policy in the project is the same one
line referring to it.

**The number I trust least.** Karoo's 189 contactable. It is correct under the
stated rule, but Karoo's customer records claim 483 unsubscribes while the
event log holds 4,880 more people who opted out. One of those sources is badly
stale, and the portal says so on screen rather than picking.

**What isn't finished.** Bilingual Arabic was dropped deliberately. Campaign
detail pages return the not-found UI under HTTP 200 — documented Next.js
behaviour for streamed responses, mitigated by an injected `noindex`. Delivery
reports are polled on demand rather than by a scheduled job.

---

## Everything else the submission asks for

| Item | Answer |
| --- | --- |
| Live URL | *(after deploying to Vercel)* |
| Six logins | See the table in `README.md` |
| Google sign-in live | Yes — verified end to end |
| Supabase project URL | `https://hhovyvkphaqniunvjoyw.supabase.co` |
| Anon key | The publishable key in `.env.example` |
| Which key the deployed app uses | The **publishable** key everywhere user-facing. The service-role key is server-only, and the two server modules that hold it start with `import 'server-only'`, so a Client Component importing them fails the build |
| Tables | `brands`, `brand_members`, `contacts`, `campaigns`, `contact_events`, `import_runs`, `import_issues`, `campaign_sends`, `send_recipients`, `shared_reports` |
| Functions | `app.current_user_brand_ids()`, `app.is_brand_owner()`, `app.apply_contact_events()`, `app.delivery_rank()`, `app.touch_updated_at()`, `public.security_coverage()`, `public.import_issue_summary()`, `public.contactability_breakdown()`, `public.signups_per_day()`, `public.campaign_performance()`, `public.campaign_engagement_detail()`, `public.send_progress()`, `public.apply_provider_reports()`, `public.unlock_shared_report()`, `public.hash_report_password()` |
| Repo | https://github.com/FadyMasoud/Campaign |
| `schema.sql` | At the repo root, generated from `supabase/migrations/` |
| AI tools used | Claude (Opus 5) via Claude Code — disclosed in detail in `docs/AI-USAGE.md` |
| Where send progress and results are recorded | `/portal/sends/{id}`, backed by `campaign_sends` and `send_recipients` |
| Provider key | *(the key issued in the brief email)* |
| Shared link + password | *(create one from any campaign page; the password is shown once)* |
| How long it took | *(author)* |
| Earliest start date + notice period | *(author)* |

## Before sending

1. **Deploy**, set `NEXT_PUBLIC_SITE_URL` to the deployed origin, and add that
   origin to Supabase → Authentication → URL Configuration → Redirect URLs.
2. **Rotate the service-role key and the dispatcher key.** Both passed through
   an AI chat transcript during the build.
3. Publish a shared report from a campaign page and note the link and password.
4. Re-run `npm test` against the deployed configuration.
