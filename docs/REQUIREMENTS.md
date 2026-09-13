# Brief → build traceability

Working checklist derived from *Growth Engineer: build task*. Every line in the
brief maps to a phase here, so nothing is discovered missing at submission time.

Status: ☐ not started · ◐ in progress · ☑ done

---

## The eleven "done" criteria

| # | Requirement | Phase | Status |
| --- | --- | --- | --- |
| 1 | Three brands live. Six logins, each landing in its own portal, at an openable URL, **whichever way they sign in**. Owners send, analysts can't, outsiders get in nowhere. | 2 | ☐ |
| 2 | A brand sees its own data and nothing from another brand — on every route, **including ones added later**. | 1 | ☐ |
| 3 | Data loads; the marketer sees what didn't and why. Loading the same export twice leaves **one** set of customers. | 3 | ☐ |
| 4 | Numbers are right. Where two careful people could count differently, **say on screen which way you counted**. | 4 | ☐ |
| 5 | As usable for the 90× brand as the small one. | 4 | ☐ |
| 6 | Sending is safe and honest. Confirmation count = what is approved. No double-send, no silent half-send. Past approvals still read as approved. | 5 | ☐ |
| 7 | Provider talks back over time, out of order, while the app isn't looking. "Who's contactable" stays correct. | 6 | ☐ |
| 8 | **At least one test that fails if brand isolation is removed.** | 1 | ☐ |
| 9 | Shared link safe for a stranger: one campaign's aggregates, nothing reachable by guessing the URL or getting past the password. | 7 | ☐ |
| 10 | Bad input rejected not stored. Loading / empty / broken screens say so. AI tools named. | all | ◐ |
| 11 | A real web app: phone and laptop, client-ready not demo-ready. | 8 | ☐ |

## Submission checklist

| Item | Where it comes from | Status |
| --- | --- | --- |
| Live URL | Deploy (Vercel) | ☐ |
| Six logins — email **and password** for each | Phase 2 | ☐ |
| Confirmation Google sign-in is live | Phase 2 | ☐ |
| Supabase project URL + anon key | Have both | ☑ |
| Table **and function** names | Phase 1 | ☐ |
| Which key the deployed app uses | Publishable, everywhere user-facing | ◐ |
| Public GitHub repo with **real history** | Commit every phase — cannot be retrofitted | ◐ |
| `schema.sql` | Phase 1 | ☐ |
| README | Drafted Phase 0, finalised Phase 8 | ◐ |
| AI tools used | `docs/AI-USAGE.md` | ◐ |
| How long it took | Track as you go | ☐ |
| Earliest start date + notice period | Author supplies | ☐ |
| Where send progress/results are recorded | Phase 5 | ☐ |
| Provider key (given to graders) | From the brief email | ☐ |
| Shared link + its password | Phase 7 | ☐ |
| 300-word note | Phase 8 | ☐ |

### The 300-word note must answer

1. What you tried to break before sending it.
2. **Where the data-isolation guarantee lives — file and line.**
3. Which number on your screens you're least sure about.
4. What isn't finished.

> Point 2 has a design consequence *now*: the isolation rule should live in one
> obvious, citable place, not be scattered across a dozen policies. Phase 1 is
> built around a single reusable predicate so this citation is one line.

## How the graders will attack it

Design against these specifically — they are stated, not guessed.

| They will… | Defended by | Phase |
| --- | --- | --- |
| Sign in as each user **directly against Supabase**, not just through the app | RLS — the app is not in the loop, so UI filtering proves nothing | 1 |
| Make requests they expect to be turned down | RLS + server-side role re-checks | 1, 2 |
| Try Google sign-in **live on the call** | Phase 2 must genuinely work, not be stubbed | 2 |
| Read the same delivery record the app sees | Send/delivery state stored legibly, not in logs | 5, 6 |
| Send deliberately messy, out-of-order provider reports | Idempotent, order-independent event application | 6 |
| Press confirm more than once, **from two sessions at once** | DB-level idempotency key, not a disabled button | 5 |
| Come at the shared link the way a stranger would | Unguessable token + password + aggregates only | 7 |

## Scope notes

- **"Build only what's asked."** Bilingual EN/AR with RTL, and light/dark theming,
  are *not* in the brief. They are the author's additions. They may earn the
  "brownie points" the brief offers for UI/UX, but they are not graded criteria
  and must not come out of the budget for data correctness.
- **"UI and UX earn brownie points… the main thing we're grading is the data and
  the guarantees around it."** Priority order is phases 1, 3, 5, 6, 7 first.
- **"About a day of real, focused work."**
- Data is synthetic; emails are `@vg-eval.test`, a reserved TLD that cannot
  receive mail. Nothing real is ever sent.
- Seed zip SHA-256 verified against the brief:
  `4961a25b151ca13ac56089ca46b94def6074c315445ec193c7bf87060683d35c` ✓
