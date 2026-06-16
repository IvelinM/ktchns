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
   guidance in `docs/google-ads-campaign-notes.md`).

## Output

Produce a short prioritized diagnosis (highest-leverage first), each item naming
the concrete fix. Typical order: call-conversion tracking → location tightening →
negative keywords / match types → budget structure → ad schedule. Then stop —
applying changes is the **google-ads-tune** skill, and spend-affecting changes
need the owner's go-ahead.

Reference: `docs/google-ads-campaign-notes.md` (current state) and
`docs/google-ads-automation.md` (methodology).
