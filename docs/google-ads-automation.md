# Google Ads — analyse & fine-tune via Chrome CDP + Playwright

How to inspect and adjust the **Via Minima** Google Ads account by driving a real,
logged-in Chrome over the Chrome DevTools Protocol (CDP). This avoids Google's
"this browser may not be secure" sign-in block that hits a vanilla Playwright
Chromium.

> ⚠️ Automating the Google Ads **web UI** is a grey area under Google's ToS and the
> UI changes often, so scripts are brittle. Prefer it only for read/analysis and
> small, supervised edits on the owner's own account. For anything heavier use the
> official **Google Ads API** or **Google Ads Scripts**. **Never make changes that
> affect spend without explicit confirmation from the user.**

## The setup (already created on this machine)

Everything lives **outside this repo** in a scratch workspace so it never pollutes
the Angular project:

```
C:\Users\MATEV\ads-automation\
  launch.js          # launches the logged-in Chrome + opens the CDP port
  shot.js            # screenshot the active Ads tab via CDP
  nav.js             # goto <url> then screenshot
  click.js           # click first element matching text, then screenshot
  profile-chrome\    # persistent Chrome profile (keeps the Google login)
  node_modules\      # playwright installed locally here
```

- **CDP host:** `http://localhost:9222` — the "remote control jack" on that Chrome.
  Local-only, but unauthenticated, so don't leave it running long-term.
- **Persistent profile** (`profile-chrome/`) means you log in **once**; later runs
  reuse the session — no repeated "browser not secure" dance.

## Step 1 — launch the logged-in Chrome (opens the CDP host)

`launch.js` uses real Chrome (`channel: 'chrome'`) with anti-automation flags so
Google trusts the sign-in:

```js
// key options in launch.js
chromium.launchPersistentContext('C:\\Users\\MATEV\\ads-automation\\profile-chrome', {
  headless: false,
  channel: 'chrome',
  ignoreDefaultArgs: ['--enable-automation'],
  args: ['--remote-debugging-port=9222', '--disable-blink-features=AutomationControlled', '--start-maximized'],
});
```

Run it in the background and wait for the `BROWSER_READY` line:

```bash
cd C:\Users\MATEV\ads-automation
node launch.js          # run in background; keep it alive to keep Chrome + port 9222 open
```

The **first** time, log in to Google Ads manually in that window. After that the
profile keeps you signed in. If the window/port disappears, just re-run `launch.js`.

## Step 2 — drive it. Two interchangeable options on the same CDP host

### Option A — Playwright CLI (node scripts, connect over CDP)

Each helper does `chromium.connectOverCDP('http://localhost:9222')`, acts, then
`browser.close()` which **detaches** without closing Chrome:

```bash
node shot.js                                   # screenshot current tab → shot.png
node nav.js "<ads-url>" out.png                # navigate + screenshot
node click.js "Bid strategy learning" out.png  # click by visible text + screenshot
```

Read the PNGs to "see" the dense Ads UI. Cheap (~1.3k image tokens per shot) and
reliable for a heavy SPA where the accessibility tree is huge.

### Option B — Playwright MCP (preferred for interactive editing)

Already installed at **user scope**, pointed at the same CDP host:

```bash
claude mcp add -s user playwright -- npx @playwright/mcp@latest --cdp-endpoint http://localhost:9222
```

MCP tools (`browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`,
`browser_take_screenshot`, …) load only in a **fresh session**. They attach to the
**same logged-in Chrome**, target elements by semantic `ref` (more reliable than
text-clicking), and need no per-action scripts. Note: on Google Ads the default
accessibility-tree snapshot can be large — fall back to `browser_take_screenshot`
when the tree is noisy.

## Step 3 — analysis methodology

Useful deep-link URLs (substitute the account `ocid` and `campaignId`):

| View | URL |
|---|---|
| Overview | `https://ads.google.com/aw/overview?ocid=<OCID>` |
| Campaigns list | `https://ads.google.com/aw/campaigns?ocid=<OCID>` |
| Campaign ad groups | `https://ads.google.com/aw/adgroups?ocid=<OCID>&campaignId=<ID>` |

Known IDs for this account (verify, they can change): account `ocid=8261308789`;
Search campaign "Via Minima | Кухни по поръчка | Search" `campaignId=23874236561`.

What to read before changing anything:
1. **Conversion tracking** — Tools → Conversions. If calls aren't tracked, the
   account **cannot** optimize for calls; flag this first.
2. **Campaign type / budget / bid strategy** — from the campaign header
   (type, budget €/day vs total, "bid strategy learning" status, optimization score).
3. **Performance** — clicks, impressions, avg CPC, conversions over last 30 days.
4. **Search terms report** — what people actually typed → wasted spend to negate.

## Step 4 — fine-tuning levers for "≤ €100 / month, maximise phone calls"

Apply only with the user's go-ahead, ideally one change at a time:

1. **Call conversion tracking (highest leverage).** Conversions → New → Phone calls:
   "Calls from ads" (call asset, count calls ≥ ~30–60s) and/or website-number calls.
   Without this nothing else can optimise for calls.
2. **Call assets** — add the business number (`+359 2 4374685`) so ads show a call
   button (drives mobile taps-to-call). ⚠️ **Only the business number may be used.**
   Audit existing call assets / ad copy and remove any personal/non-business number
   (a personal-number call asset previously leaked the owner's mobile and caused
   misdirected calls). Check abandoned campaign-creation drafts too — the number can
   sit pre-filled there.
3. **Budget cap** — a **daily** budget caps the month at `daily × 30.4`. For ~€100/mo
   use **€3.28/day** (€3.00 for headroom). A one-off "total" budget expires and is
   not an ongoing monthly cap.
4. **Bidding** — on a tiny budget start with **Maximize clicks + a max-CPC cap** while
   call-conversion data accumulates (2–3 weeks), then switch to **Maximize conversions**
   targeting the call conversion.
5. **Targeting** — tighten location to the real service area; set an **ad schedule** to
   hours someone can answer the phone; add **negative keywords** from the search-terms
   report so the small budget isn't wasted.

## Hard-won gotchas

Lessons from actually driving this account — they save a lot of dead ends:

- **Google blocks automated Chromium sign-in** ("This browser or app may not be
  secure"). The vanilla Playwright Chromium will not get past it. Use the
  `launch.js` recipe above (real Chrome + `ignoreDefaultArgs:['--enable-automation']`
  + `--disable-blink-features=AutomationControlled` + persistent profile). Best of
  all, avoid the sign-in flow entirely by reusing an already-logged-in profile.
- **Playwright MCP tools only load in a *fresh* Claude session.** Running
  `claude mcp add` mid-session does **not** make `browser_*` tools callable in the
  current one — restart first. If you need results *now*, use the Playwright CLI
  (Option A) on the same CDP host instead of waiting.
- **`claude mcp add` infers project scope from the current working directory**,
  which can drift and register the server under the wrong project. Use `-s user`.
- **For dense pages, screenshots are often cheaper than the accessibility tree.**
  A screenshot is a fixed ~1.3k image tokens; the Google Ads a11y snapshot can be
  5k–20k+ text tokens. Don't assume the MCP text snapshot is the token-cheaper read.
- **Don't click by screenshot coordinates** — the PNG is scaled relative to real
  page CSS pixels, so guessed coordinates miss. Either read true coordinates via
  `getBoundingClientRect()` in `page.evaluate`, or (preferred) target semantic
  locators: `getByRole`, `getByText`, `getByPlaceholder`.
- **Read tables as text, not images.** `page.evaluate` over `[role="row"]` /
  `[role="gridcell"]` extracts metrics and search-term rows reliably and cheaply.
- **⚠️ Tables hydrate asynchronously — `extract.js` right after `nav.js` reads an
  EMPTY/partial table.** `nav.js` returns on `domcontentloaded`, seconds before the
  grid renders, so a fully-populated table can come back as the header row only
  (`ROWS:1`). This once produced a false "the call asset is missing" diagnosis when
  it was live all along. **Always `sleep 6-9` (or `waitForTimeout(8000)`) before
  extracting**, and treat `ROWS:1` / `hits: 0` from a fresh nav as "re-check," not
  "absent." The conversion **Goals** page is a card UI (always `ROWS:0`) — read its
  `innerText` instead.
- **Screenshot path mangling inside heredoc scripts:** `page.screenshot({path:'C:\\Users\\…\\x.png'})`
  writes a literal-named junk file in cwd. Use a **relative** name (`'x.png'`) or
  `path.resolve('x.png')`.
- **Read an asset's hidden state from the row, without opening it:** the row's
  `aria-label^="Edit this Asset, currently"` control leaks the full resource JSON
  (e.g. `callAsset {phoneNumber, callConversionReportingState, callConversionTypeId}`,
  `policyInfo {approvalStatus}`). Invaluable for checking call-asset config/approval.
- **URL quirks** (all need `ocid` + `campaignId`):
  - Positive keywords: `/aw/keywords` — `/aw/keywords/positive` **404s**.
  - Negative keywords: `/aw/keywords/negative` (singular) — `/negatives` **404s**.
  - The session reuses **one tab**, so each navigation replaces the previous page
    state (don't expect prior tabs to persist).
- **Windows path mangling:** the Bash tool treats `\` as an escape, so
  `node C:\path\script.js` breaks. Use forward slashes: `node /c/path/script.js`.

## Editing the UI (forms, drawers, dialogs)

Read/analyse is easy; *editing* the Ads SPA has its own traps. Full selector-level
detail lives in `ads-automation/NOTES.md` (machine-local); the durable lessons:

- **Overlays close on CDP detach.** Dialogs, the **Campaign settings drawer**, the
  location editor, and the negative-keyword editor all close when the script calls
  `browser.close()` or the node process exits. So you **cannot** open an editor in
  one script and act on it in the next — the state is gone. Any *open → fill → Save*
  edit must run inside **one long-lived node process**. (Read-only nav/extract
  across scripts is fine.) Pattern: a single script with a `DOSAVE` env flag — dry
  run for screenshots, then a real run that clicks Save.
- **"Placeholders" are often `aria-label`,** so `getByPlaceholder()` times out.
  E.g. the negatives textarea is `textarea[aria-label^="Enter or paste"]`. Also
  `locator('textarea').first()` tends to grab the hidden support-chat box — always
  scope to `.acx-overlay-container` or an aria-label.
- **Material chevrons report `expand_less` even when collapsed** — don't infer
  open/closed from icon text; check whether a child control is visible.
- **Direct settings URLs 404** (`/aw/campaigns/settings`). Open settings by clicking
  the **"Campaign settings"** gear from any campaign sub-page. The drawer is "open"
  when a `material-expansionpanel:has-text("Bidding")` is visible.
- **The settings drawer is a *virtualized* list** (`.slidealog-body`): panels far
  down (Locations…) aren't in the DOM until scrolled in, and **`scrollTop` won't
  render them — only real `mouse.wheel` events do.** Position the cursor over the
  drawer centre and wheel in **small ~200px steps**, stopping the instant the target
  panel appears; big steps overshoot and it virtualizes back out (you land on the
  bottom "Other settings" skeletons). The verified end-to-end flow is
  `loc-sofia-final2.js`.
- **Location targeting** lives in that drawer's **Locations** panel
  (summary `Locations Bulgaria (country)`). Expanding it makes the summary text
  vanish, so detect success via the `"Enter another location"` radio, not the panel
  text. **Prefer Including a named city** (the autocomplete row "Sofia, Sofia City
  Province, Bulgaria municipality" → its **`Include`** sub-button = the Sofia *city*;
  avoid "Sofia Province" the oblast) over the brittle Advanced-search → Radius modal.
  Set Location options to **"Presence: People in or regularly in your included
  locations"** (not "…or interest"). **Saving pops a "You're removing some locations.
  Continue?" dialog — you must click `Continue` in the same script** or the edit
  reverts on detach.
- **Negative keywords recipe:** click `material-fab[aria-label="Add negative
  keywords"]`, poll for the `aria-label^="Enter or paste"` textarea, `.fill()` one
  term per line (quotes = phrase, `[brackets]` = exact), Save, then verify against
  the live table (updates immediately).
- **Positive keywords recipe** (`add-kw-exact.js`): button `[aria-label="Create
  keywords"]` → a **"Select an ad group"** dialog first (click the ad group *scoped
  to the dialog*, not the table link behind it) → fill `textarea[aria-label^="Enter"]`
  → Save. New keywords are **"Under review" and hidden by the table's default
  Enabled/Paused filter**, so verify via the post-save screenshot, not `extract.js`.
- **Call assets:** the **"Edit call" form has only Country + Phone + ad schedule —
  no conversion-counting toggle.** A call asset can serve and get taps yet carry
  `callConversionReportingState: DISABLED` (calls reported as metrics but **not
  counted** as "Calls from ads" conversions); **recreating the asset does NOT clear
  this** (confirmed). Account-level **Call reporting** is at `/aw/settings/account`
  ("Account settings"), separate from `/aw/settings` (Campaign settings). The
  "Create → Call" menu item is flaky — it often resolves to the asset-type filter
  chip instead of the create form.

## Hygiene

- Keep `launch.js` running only while working; close that Chrome (or kill the node
  process) afterwards so port 9222 stops listening.
- The scratch workspace and the `playwright` MCP entry are **machine-local config**,
  not part of this repo — don't commit anything about them here beyond this doc.
