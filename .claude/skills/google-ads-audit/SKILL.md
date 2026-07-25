---
name: google-ads-audit
description: Read-only health check of the Via Minima Google Ads campaign — conversion tracking, location targeting, budget/bidding, keywords, search terms, and call assets — producing a prioritized diagnosis. Use when asked to review, analyze, diagnose, or explain weak results on the ads account. Makes no changes.
---

# Audit the Via Minima Google Ads campaign

Pure analysis — **never edits**. Requires the browser to be up (run
`google-ads-connect` first). Account `ocid=8261308789`, `campaignId=23874236561`.
All commands run from `C:\Users\MATEV\ads-automation\`.

## What to pull (read each, then synthesize)

Use `nav.js <url> <out.png>` to load, then `extract.js` to dump the table as text.

> ⚠️ **`extract.js`/`find-phone.js` race the async table render** — run them
> immediately after `nav.js` and a *fully-populated* table returns the header row
> only (`ROWS:1`) or `hits: 0`, which **looks empty**. This once caused a false "no
> call asset" diagnosis. **`sleep 6-9` after `nav.js` before extracting**, and treat
> an empty result from a fresh nav as "re-check," never "absent." Details in
> `ads-automation/NOTES.md`.

1. **Conversion tracking** — `https://ads.google.com/aw/conversions?ocid=8261308789`.
   A persistent "Set up conversion tracking" banner or an empty Summary = **not
   tracked**. This is almost always the #1 issue: with `Maximize clicks` and no
   call conversion, Google optimizes for cheap clicks, not calls.
2. **Location targeting** — `.../aw/locations?campaignId=...&ocid=...`. Flag
   anything broader than the real service area (e.g. whole-country `Bulgaria`),
   and check presence-vs-interest in settings.
3. **Budget / bidding / status** — from the campaign header on any sub-page
   (type, budget €/day vs total, bid strategy, optimization score).
4. **Keywords** — `.../aw/keywords?campaignId=...`. Note match types (broad on a
   tiny budget = waste) and the top spenders.
5. **Search terms** — `.../aw/keywords/searchterms?campaignId=...`. The real
   queries → spot competitor brands, single-item/modular searches, and browsing
   intent to negate.
6. **Call assets** — `.../aw/assetreport/associations?assetType=CALL&ocid=...`.
   Confirm only the business number `024374685` serves (see google-ads-phone
   guidance in `docs/google-ads-campaign-notes.md`). **Read the asset's hidden
   state** without opening it: hover the row and read the
   `aria-label^="Edit this Asset, currently"` control — it leaks
   `callAsset {phoneNumber, callConversionReportingState, callConversionTypeId}` +
   `approvalStatus` (use `check-callstate.js`). **A call asset can be approved and
   getting taps yet have `callConversionReportingState: DISABLED`** → calls are
   *reported as metrics but not counted* as "Calls from ads" conversions. So "0
   conversions" can mean (a) this DISABLED flag, **or** (b) genuinely no tap became a
   ≥60s call — don't assume a tracking bug; taps ≠ connected calls. Account-level
   **Call reporting** lives at `/aw/settings/account` (separate from the asset).

## Output

Produce a short prioritized diagnosis (highest-leverage first), each item naming
the concrete fix. Typical order: call-conversion tracking → location tightening →
negative keywords / match types → budget structure → ad schedule. Then stop —
applying changes is the **google-ads-tune** skill, and spend-affecting changes
need the owner's go-ahead.

Reference: `docs/google-ads-campaign-notes.md` (current state) and
`docs/google-ads-automation.md` (methodology).
