---
name: google-ads-connect
description: Launch and connect to the Via Minima Google Ads account by driving a logged-in Chrome over CDP (port 9222). Use this first, before any Google Ads inspection, audit, or tuning task — the other google-ads-* skills assume the browser is up.
---

# Connect to the Via Minima Google Ads account

Boots the real, logged-in Chrome over the Chrome DevTools Protocol so Playwright
CLI scripts can drive the Ads UI. Tooling lives **outside this repo** at
`C:\Users\MATEV\ads-automation\` (machine-local). Background and gotchas:
`docs/google-ads-automation.md`; selector-level detail: `ads-automation/NOTES.md`.

Account: `ocid = 8261308789` · Search campaign `campaignId = 23874236561`.

## Steps

1. **Check if it's already up** (don't double-launch):
   ```bash
   curl -s http://localhost:9222/json/version | grep -q Browser && echo UP || echo DOWN
   ```
2. **If down, launch in the background** (keep it alive for the whole session):
   ```bash
   cd /c/Users/MATEV/ads-automation && node launch.js   # run_in_background: true
   ```
   Then poll until ready:
   ```bash
   for i in $(seq 1 12); do sleep 1; curl -s http://localhost:9222/json/version | grep -q Browser && { echo READY; break; }; done
   ```
3. **Confirm the right account is loaded** (read-only):
   ```bash
   cd /c/Users/MATEV/ads-automation && node nav.js "https://ads.google.com/aw/overview?ocid=8261308789" overview.png
   ```
   The title should read `Overview - Via Minima - Google Ads`. If it shows a login
   wall, the persistent profile lost its session — log in manually once in that
   Chrome window, then retry.

## Notes
- Use forward-slash paths with the Bash tool (`node /c/...`), `\` gets mangled.
- The session reuses **one tab**; each `nav.js` replaces the previous page.
- **Hygiene:** when finished for the session, stop the browser so port 9222 closes:
  kill the `node launch.js` process / the `chrome.exe` with `--remote-debugging-port=9222`.
