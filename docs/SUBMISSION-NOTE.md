# The 300-word note — draft

> The brief asks for four things in 300 words max: what you tried to break
> before sending it, where the data-isolation guarantee lives (file and line),
> which number you are least sure about, and what isn't finished. This draft
> answers all four in 296 words. The three bracketed facts are the author's to
> fill in.

---

**What I tried to break.** I replaced the `contacts` RLS policy with
`using (true)` and re-ran the suite: five assertions failed and *"sees their
own contact"* stayed green, which is what distinguishes isolated from empty.
I confirmed a send twice from two sessions at once — one wins, one is refused
by a unique index, not a disabled button. As an analyst I inserted straight
into `campaign_sends`; the database refused it. The provider sent an event
whose id was literally `evt-batch_50-forged`, claiming KAROO, naming a KILELE
contact, inside a MARRAKECH batch — discarded, because a provider's own label
never decides which tenant a row belongs to.

The worst one I found by reading the live data back, not by testing. PostgREST
caps every response at 1,000 rows *silently* — no error, just a plausible
answer. A Kilele send recorded 23,969 approved while only the first 1,000 were
ever frozen or sent to: the portal was the half-sender. Fixing that exposed a
second lie — the provider's docs promise 100,000 recipients per call and an
empty `rejected` array, but it caps at 500. A send now fans out into as many
calls as it needs, each recorded in `send_batches`.

**Where isolation lives.**
`supabase/migrations/20260913160000_brands_and_isolation.sql:104` —
`app.current_user_brand_ids()`. Every policy in the project is one line
referring to it.

**The number I trust least.** Karoo's 189 contactable. Correct under the stated
rule, but Karoo's customer records claim 483 unsubscribes while the event log
holds 4,880 more people who opted out. One source is badly stale, and the
portal says so on screen rather than picking.

**What isn't finished.** Three early Kilele sends still carry the truncated
figures, kept rather than rewritten. Delivery reports are polled on demand, not
scheduled. Arabic was dropped deliberately.

---

## Everything else the submission asks for

| Item | Answer |
| --- | --- |
| Live URL | https://campaign-five-flax.vercel.app |
| Six logins | See the table in `README.md` |
| Google sign-in live | Yes — verified end to end |
| Supabase project URL | `https://hhovyvkphaqniunvjoyw.supabase.co` |
| Anon key | The publishable key in `.env.example` |
| Which key the deployed app uses | The **publishable** key everywhere user-facing. The service-role key is server-only, and the two server modules that hold it start with `import 'server-only'`, so a Client Component importing them fails the build |
| Tables | `brands`, `brand_members`, `contacts`, `campaigns`, `contact_events`, `import_runs`, `import_issues`, `campaign_sends`, `send_recipients`, `send_batches`, `shared_reports` |
| Functions | `app.current_user_brand_ids()`, `app.is_brand_owner()`, `app.apply_contact_events()`, `app.delivery_rank()`, `app.touch_updated_at()`, `public.security_coverage()`, `public.import_issue_summary()`, `public.contactability_breakdown()`, `public.signups_per_day()`, `public.campaign_performance()`, `public.campaign_engagement_detail()`, `public.send_progress()`, `public.apply_provider_reports()`, `public.unlock_shared_report()`, `public.hash_report_password()`, `public.mark_send_recipients()` |
| Repo | https://github.com/FadyMasoud/Campaign |
| `schema.sql` | At the repo root, generated from `supabase/migrations/` |
| AI tools used | Claude (Opus 5) via Claude Code — disclosed in detail in `docs/AI-USAGE.md` |
| Where send progress and results are recorded | `/portal/sends/{id}`, backed by `campaign_sends`, `send_recipients` and `send_batches` |
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
