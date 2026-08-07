# Google Ads — campaign notes & roadmap

Working notes on the Via Minima Google Ads account: current state, diagnosis,
what's been changed, and the prioritized next steps. For *how* to drive/inspect
the account, see `google-ads-automation.md`.

> Last reviewed: **2026-08-08**.

## Account & campaign

| | |
|---|---|
| Account "Via Minima" | `ocid = 8261308789` |
| **Active campaign: "Via Minima \| Кухни по поръчка \| Search #2"** | pasted copy, budget `€147.60 (total) Aug 7 – Nov 5, 2026` (≈€1.64/day pace), Enabled/Eligible |
| Original campaign "Via Minima \| Кухни по поръчка \| Search" | `campaignId = 23874236561` — **permanently Ended** (see budget-type note below), left in place as history, not deleted |
| Type | Search · single ad group ("Ad group 1") each |
| **Goal** | spend ≤ **€100 / month**, maximize **phone calls** |

## ⚠️ Budget-type platform constraint (found 2026-08-08)

This campaign's budget uses Google Ads' **"Campaign total" (flighted/dated) budget
type** — spend €X between a start and end date — **not** a standard daily budget.
Confirmed the hard way, across four separate UI surfaces (Campaign Settings drawer,
the table-cell inline editor, the bulk "Change budget → Average Daily budget"
override tool, and even on a freshly-pasted copy that had never served): **there is
no way to convert this budget type to an ongoing Daily budget, and no way to give
it a genuinely unlimited end date.**

- The end-date calendar hard-caps the window at **90 days from the campaign's
  (fixed, unchangeable) start date** — trying to enter anything beyond that shows
  "Campaigns with this budget type can run for max 90 days" and is rejected.
  The start date field itself is `aria-disabled` — it can never be moved forward.
- This is why the campaign silently stopped on Jul 10, 2026: it was never actually
  an "ongoing" budget, just a fixed-duration one nobody was tracking.
- **The only way to get a true no-end-date daily budget is a brand-new campaign
  built via the full "+ Create campaign" wizard** (not a copy/paste — paste always
  inherits the source's budget type and re-imposes the same 90-day ceiling from
  the new start date). Not attempted yet — judged too risky to automate blind on
  a live account in one session; revisit if the quarterly-renewal cadence below
  becomes too much friction.

**Current mitigation:** the campaign was **copied** (Google Ads' native
Ctrl+C/Ctrl+V "Paste campaign" flow, which preserves all keywords/ads/negatives/
targeting/conversion-goal automatically) into **"Search #2"**, given a fresh
`Aug 7 – Nov 5, 2026` window and `€147.60` total (≈€1.64/day, ≈€50/mo — the
owner's requested conservative starting cap), then Enabled. Confirmed **Eligible**
at the ad-group level post-launch.

**⚠️ Action needed around 2026-11-05**: this budget will run out again. Renewal
recipe (fast, ~5 min): select the campaign row → Ctrl+C → Ctrl+V → check "Adjust
start and end dates" → set a fresh 90-day window → Paste → set the new copy's
amount via its Budget table cell → Enable the new copy → optionally pause/remove
the expired one. See `google-ads-automation.md` for the driving mechanics.

## Diagnosis — "why nobody calls"

Both things were true at once: calls couldn't be *seen*, and the campaign hadn't
had a fair chance to produce any.

1. **No conversion tracking.** Every "Conversions" figure is `0.00` because
   nothing is measured — not because nobody acted. A call could have happened and
   be invisible. **#1 gap.**
2. **Barely run.** ~€11.54 spent, 42 clicks, almost all in the last few days. For
   a high-ticket, slow-decision purchase, that volume predicts ~0 calls regardless.
3. **Wrong traffic.** All keywords are **Broad match**; the biggest spenders are
   generic *furniture* terms, not custom-kitchen intent — that's how junk like
   "moderano", "boho", "backsplash", "countertop types" crept in. Of 42 clicks only
   a couple were genuine `кухни по поръчка` buyers.
4. **No easy way to call.** The website used to funnel everyone to the contact
   *form*; the phone number only appeared in the footer, and the ad had no call
   button. Fixed on the site side — see below.
5. **Long consideration cycle.** The searches themselves ("design photos", "types
   of countertops") show people in research mode, not ready to phone.

## Keyword state (as of review)

All **Broad match** in Ad group 1. Spend concentrated on generic furniture terms:

| Keyword | Note |
|---|---|
| `кухненски мебели` (kitchen furniture) | biggest spender, generic |
| `мебели поръчка`, `мебели дизайн` | generic furniture/design — pull junk |
| `кухни по поръчка`, `кухня по поръчка` | ✅ the actual product, low volume |
| `кухни цени`, `кухни интериор`, `вградени кухни`, `дизайн мебел`, `кухни поръчка` | mixed |

## Changes made (2026-06-12)

- **7 phrase-match negative keywords** added at campaign level:
  `обзавеждане за кухня`, `долен шкаф с мивка за кухня`, `модулни кухни ирим мдф`,
  `moderano кухни`, `бохо стил обзавеждане`, `готови ъглови кухни`, `гръб за кухня`.
- **Website call button** shipped — a persistent one-tap `tel:+35924374685` button
  (gold pill, collapses to an icon on mobile). See `AppComponent` (`.call-fab`).

## Changes made (2026-06-15)

- **Removed a personal-number call asset.** `088 527 2317` (the owner's personal
  phone) was live as a campaign call asset since Jun 10 (Eligible, 507 impr / 6
  tap-to-calls) — the cause of off-target personal calls. Removed it; the business
  `024374685` call asset remains. The personal number is still pre-filled in an
  **abandoned Performance Max setup draft** (not saved — "Drafts in progress: 0").
- **+12 phrase-match negatives** at campaign level → **19 total**. Added:
  `шкаф`, `модулна`, `модулни`, `рафт`, `етажерка`, `термоплот`, `единичен`
  (single-cabinet / modular parts), `зора`, `ирим` (competitor brands),
  `идеи`, `снимки`, `безплатно` (low-intent browsing). Note: `шкаф` is broad — it
  also blocks legit "кухненски шкафове"; remove if it over-restricts.

## Changes made (2026-07-26)

- **Business phone number changed** from the old landline `+359 2 4374685`
  (`024374685`) to the new business number `+359 888 152 776` (`0888152776`),
  both on the site (see `CLAUDE.md` guardrail) and in the Google Ads account.
- **Edited the existing account-level Call asset in place** (via the "Edit call"
  form — Country + Phone number are the only editable fields) rather than
  remove+recreate. Verified via `find-phone.js`: zero hits for the old number
  afterward, and the Assets → Call associations table shows a single asset with
  the new number, `Pending / Under review` (expected for any freshly edited call
  asset — see the 2026-06-23 notes on `callConversionReportingState`).
- The leaked personal number is still pre-filled in the same abandoned
  Performance Max draft noted 2026-06-15 — unaffected by this change, still not
  a saved draft.

## Changes made (2026-08-08)

- **Diagnosed "no calls" root cause**: the account had auto-paused for billing
  (prepaid balance hit €0.00, no backup payment method) *and*, separately, the
  campaign's total-budget date range (May 23 – Jul 10, 2026) had expired weeks
  earlier — it was never an ongoing budget, just a fixed-duration one. Owner paid
  €30 to clear the billing pause.
- **Discovered and documented the "Campaign total" budget-type 90-day/no-daily-
  conversion platform constraint** — see the dedicated section above. This cost
  significant back-and-forth (three different remediation plans were invalidated
  in turn as each new constraint was discovered by testing against the live
  form) before landing on the copy-and-renew mitigation.
- **Copied the campaign** (native Ctrl+C/Ctrl+V paste, preserves keywords/ads/
  negatives/targeting/conversion-goal) into **"Search #2"**, `€147.60 (total)
  Aug 7 – Nov 5, 2026` (~€1.64/day, ~€50/mo), Enabled. Confirmed **Eligible** at
  ad-group level. Original campaign left in place, Ended, as history.
- Next renewal due **~2026-11-05** — see the recipe in the constraint section
  above.

## Diagnosis confirmed (2026-06-15)

- **Location targeting = the whole country (`Bulgaria`).** This is why a Varna
  caller got through. Should be **Sofia, presence-only**. Likely also set to the
  default "presence *or interest*". (Owner wants Sofia city + ~20 km.)
- **Still zero conversion tracking**, bid strategy **Maximize clicks** → Google
  optimizes for cheap clicks, not calls. Highest-leverage fix remains call-conversion
  tracking.
- Keywords: confirmed all **Broad match**, one ad group; top spend `кухненски мебели`
  €10, `мебели дизайн` €5, `мебели поръчка` €4.3 — generic furniture, not custom-kitchen.

## Conversion tracking — actual state (2026-06-15)

- **Site tag is present** in `src/index.html`: Google Ads global tag (`gtag.js`)
  `AW-18183572926` — but it only fires `gtag('config', …)`; **no conversion event**
  is sent, and the `tel:` links (footer + `.call-fab`) have no click tracking.
- **A "Calls from ads" conversion action already exists** in the account
  (`ctId=7621070298`, created 5/23/2026): Primary, category Phone call leads, call
  length 60 s, 30-day window, data-driven. It read **"No recent conversions"** —
  set up correctly, just no call ≥ 60 s yet. (`Calls from ads` needs no site tag.)
- **Change made:** Count `Every` → **`One`** (lead best practice — one caller = one
  lead). Everything else left as-is.
- **Open opportunity:** the `AW-18183572926` tag is installed but unused. Adding a
  "Clicks on phone number" website conversion + a `gtag('event','conversion',…)` on
  the `.call-fab` / footer `tel:` taps would also capture calls from people who land
  on the site (needs a small Angular code change). Not yet done.

## Pending (requested, in progress)

Owner asked (2026-06-15) to: tighten location to Sofia presence-only, add the
modular/competitor negatives (done), tighten keywords (pause generic furniture
broad → phrase), and set up call-conversion tracking. **Location, keyword
tightening, and conversion tracking are still to do** — the location edit via UI
automation is fragile (see `google-ads-automation.md` → "Editing the UI").

## Roadmap (priority order)

1. **Call-conversion tracking + a call asset** (highest leverage; native, no site
   change, no extra spend). Without it nothing else is measurable.
2. **Tighten match types** — move `кухни по поръчка` / `кухня по поръчка` to
   phrase/exact; stop paying broad for generic queries.
3. **Pause/demote the generic furniture broad keywords** (`кухненски мебели`,
   `мебели поръчка`, `мебели дизайн`).
4. **Switch to a daily budget ≈ €3.28/day** for a true ongoing €100/mo cap (the old
   €175 total budget expires Jul 10 2026 and isn't a monthly cap).
5. **Add an ad schedule** to hours someone can answer the phone; review location
   targeting for the real service area.
6. Once call data accumulates (~2–3 weeks), consider **Maximize conversions**
   targeting the call conversion.

> ⚠️ Changes here affect live ad spend — confirm with the account owner before
> applying, and prefer one change at a time.
