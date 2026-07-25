# Google Ads — campaign notes & roadmap

Working notes on the Via Minima Google Ads account: current state, diagnosis,
what's been changed, and the prioritized next steps. For *how* to drive/inspect
the account, see `google-ads-automation.md`.

> Last reviewed: **2026-06-15**.

## Account & campaign

| | |
|---|---|
| Account "Via Minima" | `ocid = 8261308789` |
| Campaign "Via Minima \| Кухни по поръчка \| Search" | `campaignId = 23874236561` |
| Type | Search · single ad group ("Ad group 1") |
| **Goal** | spend ≤ **€100 / month**, maximize **phone calls** |

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

## Changes made (2026-06-23)

- **+1 negative** `"виденов"` (phrase) at campaign level → competitor brand seen in
  search terms (`кухни виденов`, 36 impr). Now **20 negatives total**.
- **+2 exact keywords** to Ad group 1: `[кухня по поръчка]`, `[кухни по поръчка]`
  (were only Broad before). Added via "Create keywords"; show as **Under review**
  initially (hidden by the table's Enabled/Paused filter until Eligible).
- **Location tightened → Sofia, presence-only.** Was whole-country **Bulgaria**
  (presence-or-interest). Now targets **"Sofia, Sofia City Province, Bulgaria
  municipality"** with Location options = **"Presence: people in or regularly in your
  included locations"**. Verified in the Locations report (targeted location now reads
  *Sofia, Sofia City Province, Bulgaria*). Note Sofia traffic already had ~14.7% CTR vs
  4.7% country-wide — higher intent. *(Automation note: the settings drawer is a
  virtualized list — scroll it in small ~200px wheel steps over `.slidealog-body` and
  stop the instant the Locations panel renders, or it virtualizes back out. Save pops a
  "You're removing some locations — Continue?" dialog that must be confirmed **in the
  same script** before detach. See `loc-sofia-final2.js`.)*

### Call-asset recreate — owner did it manually (result: flag NOT cleared)

Owner approved recreating the call asset to flip `callConversionReportingState`
DISABLED → counting. The automation couldn't drive the add-call flow reliably (the
"Create → Call" menu item kept resolving to the asset-type **filter chip**; page hit a
transient "You got disconnected"), so the **owner recreated it manually**.

**Outcome (verified `check-callstate.js`):** new asset `024374685` is **Account-level**,
`Pending / Under review` (created Jun 23) — old campaign-level one gone, no duplicate.
**BUT it STILL reads `callConversionReportingState: DISABLED`** (`callConversionTypeId:
179`). So **recreating did NOT auto-enable call-conversion counting** — at least not
while Under review. Account **Call reporting** is `On` (`/aw/settings/account`) with no
conversion-action link exposed there; the asset Edit form has no toggle for it.

**Two non-exclusive readings of "0 conversions":** (a) the DISABLED flag blocks
counting — may flip to "use account-level call conversion" once the asset is
**Approved** (~1 day); (b) it's partly **real** — call-asset "clicks" are taps, and
few low-intent (old whole-Bulgaria) taps became ≥60s calls. **Next:** re-check the
flag + first counted call **after approval**; if still DISABLED/0 despite a genuine
60s+ call, the per-asset state likely needs the **Google Ads API** (UI exposes no
toggle). Optional now: lower the "Calls from ads" threshold 60s → 30s.

## Diagnosis corrected (2026-06-23) — the call asset is NOT missing

⚠️ A first read of the CALL associations report looked **empty** and suggested no
call asset — that was a **page-load timing artifact** (`extract.js`/`find-phone.js`
raced the async table render). On a full-wait re-read the asset is live:

- **Call asset `024374685`** — Campaign-level, **APPROVED / Eligible**, serving since
  May 31. Last 30 days: **30 clicks (call-button taps), 2,049 impr, €6.32**. So the
  ad *does* show a tap-to-call button and people *are* tapping it.
- But the asset's internal state is **`callConversionReportingState: DISABLED`**
  (countryCode BG, callConversionTypeId 179). Account-level **Call reporting is
  "Turned on"** (Account settings), so calls are *reported as metrics* but **not
  counted as conversions** for this asset.
- Hence **"Phone call leads" conversion = 0** despite 30 taps. The conversion action
  ("Calls from ads", exists & active) literally has nothing to count.
- The asset **Edit** form (Bulgaria + number + ad schedule under Advanced options)
  exposes **no call-conversion toggle** — so flipping `callConversionReportingState`
  cleanly means **deleting + recreating** the asset (a fresh asset with account
  reporting on + a call conversion action defaults to counting calls). Not done —
  sensitive, confirm with owner first (re-review risk).
- Note: the personal number `0885272317` still appears only inside the **abandoned
  PMax draft** payload on the page — not a live asset. Leave/abandon that draft.

**Net:** the dominant reason for "no calls" is now **traffic quality** — whole-country
targeting + broad generic furniture keywords produce low-intent, out-of-area taps that
don't become 60s+ kitchen-order calls. Location tightening (still **Bulgaria**, #3
below) is the biggest untouched lever; the asset conversion-counting fix is secondary
(measurement only).

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
