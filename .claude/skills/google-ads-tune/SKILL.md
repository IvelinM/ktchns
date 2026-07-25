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
  only business `024374685` / `+359 2 4374685`.

## Critical automation fact

**Overlays/dialogs/drawers close when the Playwright script detaches.** So an
*open → fill → Save* edit must happen inside **one long-lived node script** (use a
`DOSAVE` env flag: dry-run with screenshots, then commit). This includes
**confirmation dialogs** (e.g. location Save → "Continue?") — handle them before the
script ends. Read-only steps can span scripts. Full selector traps in
`docs/google-ads-automation.md` → "Editing the UI" and `ads-automation/NOTES.md`.

**When verifying a change, give the table time to render** — `extract.js` right after
`nav.js` reads a stale/empty grid (`ROWS:1`). `sleep 6-9` first, and prefer the live
report/screenshot over change history (which lags hours).

## Playbook

### Add negative keywords (reliable — `neg-final.js`)
Click `material-fab[aria-label="Add negative keywords"]`, poll for
`textarea[aria-label^="Enter or paste"]`, fill one term per line (`"term"` = phrase,
`[term]` = exact), Save, verify against the table + "1 - N of N". Block competitor
brands, single-cabinet/modular parts, and low-intent browsing terms.

### Tighten location → Sofia, presence-only (DONE 2026-06-23 — `loc-sofia-final2.js`)
Already applied: targeting is now **"Sofia, Sofia City Province, Bulgaria"** with
**Presence-only**. The verified recipe (the settings drawer is a **virtualized
list**, so this is fiddly):
1. Open the drawer ("Campaign settings"); "open" = `material-expansionpanel:has-text("Bidding")` visible; wait ~3s for panels to populate (else skeletons).
2. Cursor over `.slidealog-body` centre, **wheel in ~200px steps**, stop the **instant** a panel matching `/Bulgaria \(country\)|^Locations\b/` renders (big steps overshoot and it virtualizes back out).
3. Expand it (detect via the `"Enter another location"` radio) → click it → type `Sofia` into the widest empty input in `.acx-overlay-container` → click **`Include`** on the **"Sofia, Sofia City Province, Bulgaria municipality"** row (the *city*; not "Sofia Province" the oblast).
4. **Location options** → select **"Presence: People in or regularly in your included locations"**.
5. Save → a **"You're removing some locations. Continue?" dialog must be `Continue`-clicked in the same script** or it reverts. Verify in the Locations report.

### Tighten keywords (add positive — `add-kw-exact.js`)
Add exact/phrase core terms: button `[aria-label="Create keywords"]` → **"Select an
ad group"** dialog (click the ad group *scoped to the dialog*, not the table link
behind it) → fill `textarea[aria-label^="Enter"]` (`[brackets]`=exact, `"q"`=phrase)
→ Save. **New keywords show "Under review" and are hidden by the table's default
Enabled/Paused filter** — verify via the post-save screenshot, not `extract.js`.
*(Done 2026-06-23: added `[кухня по поръчка]`, `[кухни по поръчка]`.)* To **pause**
generic broad keywords, select the row checkbox → Edit → Pause (not yet scripted).

### Call-conversion tracking — current reality (read before "fixing")
The **"Calls from ads" / "Phone call leads" conversion action already exists** and is
active, **and** account-level **Call reporting is On** (`/aw/settings/account`). Yet
the call asset shows **`callConversionReportingState: DISABLED`** (calls reported but
not counted) and conversions read 0. **Recreating the call asset did NOT clear that
flag** (confirmed 2026-06-23, while the new asset is `Under review`). So don't assume
recreate fixes counting; the open question is whether the flag flips on approval or
needs the Google Ads **API**. Also note **0 conversions can simply be real** — call
"clicks" are *taps*, and few low-intent taps become ≥60s calls. Optional measurement
tweak: lower the "Calls from ads" call-length threshold **60s → 30s** (Goals →
Conversions → the action → Settings). Check asset state any time with
`check-callstate.js`.

### Remove a leaked / unwanted call asset
Scan with `find-phone.js <url>` (e.g. the CALL associations page — **wait for render
first**, it races). Filter to **Call** assets, select only the offending row's
checkbox, **Remove**, **Confirm**, then re-scan to verify only the business number
remains. *(The personal `0885272317` currently survives only inside an abandoned
PerformanceMax setup **draft** payload — not a live asset; abandon/leave that draft.)*

## After tuning
Log what changed (date, items, caveats) in `docs/google-ads-campaign-notes.md`, and
stop the browser for hygiene.
