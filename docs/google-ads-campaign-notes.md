# Google Ads — campaign notes & roadmap

Working notes on the Via Minima Google Ads account: current state, diagnosis,
what's been changed, and the prioritized next steps. For *how* to drive/inspect
the account, see `google-ads-automation.md`.

> Last reviewed: **2026-06-12**.

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
