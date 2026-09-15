# Submission email — ready to send

> Copy everything below the line. Three placeholders in **bold** are yours to
> fill in: how long it took, your earliest start date, and your notice period.

---

**Subject:** Growth Engineer build task — Fady Masoud

Hi,

The campaign portal is built and deployed. Everything you asked for is below.

---

### The build

**Live URL** — https://campaign-five-flax.vercel.app

**The six logins**

| Email | Password | Brand | Role |
| --- | --- | --- | --- |
| owner@kilele.vg-eval.test | Kilele-Owner-2026 | Kilele Rides | owner |
| analyst@kilele.vg-eval.test | Kilele-Analyst-2026 | Kilele Rides | analyst |
| owner@karoo.vg-eval.test | Karoo-Owner-2026 | Karoo Coaches | owner |
| analyst@karoo.vg-eval.test | Karoo-Analyst-2026 | Karoo Coaches | analyst |
| owner@marrakech.vg-eval.test | Marrakech-Owner-2026 | Marrakech Express | owner |
| analyst@marrakech.vg-eval.test | Marrakech-Analyst-2026 | Marrakech Express | analyst |

**Google sign-in is live.** Happy to run it with you on the call. A Google
account that is not one of the six authenticates successfully and lands on
`/no-access` — authentication proves who somebody is, not that they belong to a
brand.

**Supabase**

- Project URL — `https://hhovyvkphaqniunvjoyw.supabase.co`
- Anon (publishable) key — `sb_publishable_Yw4c8cPu7aUuR72DGRXqvA_KccBLcHg`
- **The deployed app uses the publishable key everywhere user-facing.** The
  service-role key is server-only. The two modules that hold it begin with
  `import 'server-only'`, so a client component importing them fails the build
  rather than shipping the secret.

**Tables** (11) — `brands`, `brand_members`, `contacts`, `campaigns`,
`contact_events`, `import_runs`, `import_issues`, `campaign_sends`,
`send_recipients`, `send_batches`, `shared_reports`

**Functions** (16 — 11 callable in `public`, 5 helpers in `app`, which is not
exposed through the API)

- Isolation and roles — `app.current_user_brand_ids()`, `app.is_brand_owner()`
- Analytics — `public.contactability_breakdown()`, `public.signups_per_day()`,
  `public.campaign_performance()`, `public.campaign_engagement_detail()`
- Import — `public.import_issue_summary()`
- Send and provider — `public.send_progress()`,
  `public.apply_provider_reports()`, `public.mark_send_recipients()`
- Shared link — `public.unlock_shared_report()`,
  `public.hash_report_password()`
- Security audit — `public.security_coverage()`
- Internal — `app.apply_contact_events()`, `app.delivery_rank()`,
  `app.touch_updated_at()`

**Repo** — https://github.com/FadyMasoud/Campaign

Real history, one commit per phase. `schema.sql` is at the root, generated from
the 13 migrations. README at the root; `docs/` holds an AI-usage log, a
requirements traceability document, and a project handbook.

**AI tools** — Claude (Opus 5) via Claude Code, used as a pair-programmer.
Disclosed phase by phase in `docs/AI-USAGE.md`, including where I overruled it
and why.

**How long it took** — **[fill in]**

**Earliest start date** — **[fill in]** · **Notice period** — **[fill in]**

---

### The send and the shared link

**Where send progress and results are recorded**

- On screen — `/portal/sends/{id}`: what was approved, by whom, when, how many
  the provider accepted, how many it refused, where each recipient stands, and
  a timeline.
- In the database — `campaign_sends` (one row per approved send, with the
  provider batch reference) and `send_recipients` (the frozen audience, one row
  per person, with delivery status).

A real send has been made: **Marrakech `MAR-0001`, 240 approved, 240 accepted**,
provider batch **`batch_50e1f5a496627f640a36`**. Delivery reports have been
pulled back: 223 delivered, 17 bounced.

Three earlier Kilele sends are also on record, and they show smaller figures
than they approved. That is not a display problem — it is the bug described in
the note below, found late by reading the stored rows back. The code is fixed
and covered by tests; those three rows are left as they happened rather than
tidied up, because rewriting a send record to look better is the one thing this
portal is built not to do.

**Provider key** — `vgk_c5d8fd95e33712d8c402702a9180543e921ba180022aa084`

You can read the same record I can:

```
curl -H "Authorization: Bearer vgk_c5d8fd95e33712d8c402702a9180543e921ba180022aa084" \
  https://dispatcher-production-72fc.up.railway.app/v1/messages/batch_50e1f5a496627f640a36/events
```

**Shared link** — https://campaign-five-flax.vercel.app/r/Ls8kBOfYEKahQas6qUnfwchCZY2Hjp8R0knPZsdzAxc
**Password** — `velocity-review-2026`

---

### The note (289 words)

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

Thanks for putting this together — it was a genuinely good brief to build
against. Looking forward to walking you through it.

Fady
