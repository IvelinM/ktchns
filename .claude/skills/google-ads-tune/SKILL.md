---
name: google-ads-tune
description: Apply supervised fine-tuning to the Via Minima Google Ads campaign — add negative keywords, tighten location targeting, adjust keyword match types, set up call-conversion tracking, and remove leaked/unwanted call assets. Use when asked to fix, tune, optimize, or clean up the ads account. Confirm spend-affecting changes first and apply one change at a time.
---

# Tune the Via Minima Google Ads campaign

Makes **live changes to a real ad account**. Requires the browser up
(`google-ads-connect`) and, ideally, a fresh **google-ads-audit** to ground the
changes. Account `ocid=8261308789`, `campaignId=23874236561`. Scripts in
`C:\Users\MATEV\ads-automation\`.

## Guardrails (non-negotiable)

- **Confirm before spend-affecting changes** (budget, bid strategy, turning
  targeting on). Negatives, location tightening, pausing waste, and removing a bad
  asset reduce/refine spend — still confirm scope, then proceed.
- **One change at a time**, and **verify each** against the live UI after saving.
- The owner's business is **Sofia-only, whole-kitchen orders** (no single
  cabinets/modular, no other cities). Personal phone `0885272317` must never appear;
  only business `0888152776` / `+359 888 152 776`.

## Critical automation fact

**Overlays/dialogs/drawers close when the Playwright script detaches.** So an
*open → fill → Save* edit must happen inside **one long-lived node script** (use a
`DOSAVE` env flag: dry-run with screenshots, then commit). Read-only steps can span
scripts. Full selector traps in `docs/google-ads-automation.md` → "Editing the UI"
and `ads-automation/NOTES.md`.

## Playbook

### Add negative keywords (reliable — `neg-final.js`)
Click `material-fab[aria-label="Add negative keywords"]`, poll for
`textarea[aria-label^="Enter or paste"]`, fill one term per line (`"term"` = phrase,
`[term]` = exact), Save, verify against the table + "1 - N of N". Block competitor
brands, single-cabinet/modular parts, and low-intent browsing terms.

### Tighten location → Sofia, presence-only
Settings drawer ("Campaign settings" gear) → **Locations** panel → expand → "Enter
another location" → target Sofia (named city/region is far more reliable than the
brittle radius modal) → set Location options to **Presence** (not "…or interest") →
Save. Detect the expanded editor via the `"Enter another location"` radio, not the
panel summary. Verify via the Locations report.

### Tighten keywords
Pause generic broad keywords (e.g. `мебели дизайн`, `мебели поръчка`) and move core
custom-kitchen terms to phrase/exact. Verify status changes in the Keywords table.

### Set up call-conversion tracking (highest leverage)
Goals → Conversions → New → **Phone calls → "Calls from ads"** (count calls ≥ ~60s).
No site change, no extra spend. Lets a later switch to **Maximize conversions**
optimize for calls once data accumulates (~2–3 weeks).

### Remove a leaked / unwanted call asset
Scan with `find-phone.js <url>` (e.g. the CALL associations page). Filter to **Call**
assets, select only the offending row's checkbox, **Remove**, **Confirm**, then
re-scan to verify only the business number remains.

## After tuning
Log what changed (date, items, caveats) in `docs/google-ads-campaign-notes.md`, and
stop the browser for hygiene.
