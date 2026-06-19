---
name: webcad-verify
description: Verify WebCAD (/admin) changes by driving the running Angular dev server with Playwright and the window.ng debug API. Use whenever you change src/app/admin/admin-page.component.* and want to confirm geometry, families, the schedule export, move/copy/array, undo, or selection actually work — far more reliable than clicking the 3D canvas.
---

# Verify WebCAD changes against the live component

The WebCAD tool at `/admin` is a single Three.js component whose data model is the
`instances[]` array (the 3D scene is derived from it). The reliable way to test logic
is to grab the live component instance via Angular's debug API and call its methods /
inspect its state directly — **not** to click the 3D canvas (raycasting a `<canvas>`
through Playwright is flaky).

Architecture reference: `docs/webcad.md` (index) and the short topic files in `docs/webcad/`.

## 0. Preconditions

- A dev server is almost always **already running on port 4200** (the user keeps one
  up; Angular hot-reloads on save). Don't start a second one — `npm start` will hit
  "Port 4200 is already in use" and hang on a prompt.
- The route is `http://localhost:4200/admin`.
- Builds run with `ng` in **dev** mode behind the scenes; `window.ng` debug API is
  available (dev build). `window.ng.getComponent(el)` and `window.ng.applyChanges(cmp)`
  are the two you need.

## 1. Navigate

```
mcp__playwright__browser_navigate  →  http://localhost:4200/admin
```
If `window.ng` is undefined on the first call, the page is still re-bootstrapping
after an HMR reload — just re-run the evaluate; it settles in a second.

## 2. Grab the component and drive it

`mcp__playwright__browser_evaluate` with a function like:

```js
() => {
  if (!window.ng) return { error: 'ng not ready' };
  const cmp = window.ng.getComponent(document.querySelector('app-admin-page'));

  // helper: wipe the scene between sub-tests
  const reset = () => {
    cmp['objectMap'].forEach(o => cmp['scene'].remove(o));
    cmp['objectMap'].clear();
    cmp.instances = []; cmp.applySelect([]); cmp['undoStack'].length = 0;
  };

  // helper: place an instance with a family's default params
  const place = (familyId, overrides = {}) => {
    const fam = cmp.families.find(f => f.id === familyId);
    const params = {}; for (const p of fam.params) params[p.key] = p.defaultValue;
    Object.assign(params, overrides);
    const id = cmp['nextId']++;
    cmp.instances.push({ id, familyId, label: 'T'+id, params, material: 'M', x:0, y:0, z:0, rotY:0 });
    cmp['spawnObject'](cmp.instances[cmp.instances.length - 1]);
    return id;
  };

  // count the real (non-edge) solids of an object
  const solids = (id) => { let n = 0;
    cmp['objectMap'].get(id).traverse(c => { if (c.isMesh && !c.userData['isEdge']) n++; });
    return n; };

  reset();
  const id = place('cabinet-door', { 'С_ТАВАН': 0 });
  const res = { panels: solids(id) };
  reset();                       // ALWAYS clean up so the user's scene is untouched
  return res;
}
```

Notes:
- Private fields (`objectMap`, `scene`, `nextId`, `undoStack`, `moveFrom`, `moveDir`,
  `distanceLocked`) are reachable with bracket access — TS `private` is not enforced
  at runtime.
- After mutating `instances`/selection outside an event, call
  `window.ng.applyChanges(cmp)` if you need the **DOM/panel** to reflect it (e.g.
  checking a toolbar button's `disabled`, the mode pill text, or an `*ngIf` panel).
- **Always `reset()` at the end** of a test so you leave the user's scene clean.

## 3. Test the interaction tools (move / copy / array / typed distance)

`startMove/startCopy/startArray` enter `move-from`. To exercise a commit, set up the
`move-to` state and call `commitTypedDistance()`:

```js
cmp.applySelect([id]); cmp.arrayCount = 4; cmp.startArray();
cmp.mode = 'move-to'; cmp['moveFrom'].set(0,0,0); cmp['moveDir'].set(1,0,0);
cmp.distanceStr = '200'; cmp['distanceLocked'] = true;
cmp.commitTypedDistance();
// → originals + 4 stepped copies at x = 200,400,600,800
```
`commitTypedDistance()` **no-ops unless `mode === 'move-to'`** — set it first.
For a true end-to-end check of the cursor input, dispatch real events on
`.move-measure input`: set `.value`, fire `new Event('input',{bubbles:true})`, then
`new KeyboardEvent('keydown',{key:'Enter',bubbles:true})`.

## 4. Test the schedule export (capture the download)

Stub the download to capture the Blob instead of saving a file:

```js
async () => {
  const cmp = window.ng.getComponent(document.querySelector('app-admin-page'));
  /* …place objects… */
  let cap = null;
  const oc = URL.createObjectURL, ock = HTMLAnchorElement.prototype.click;
  URL.createObjectURL = b => { cap = b; return 'x'; };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {};
  cmp.itemize = false;          // or true to test the itemized layout
  cmp.exportSchedule();
  URL.createObjectURL = oc; HTMLAnchorElement.prototype.click = ock;
  const text = (await cap.text()).replace(/^﻿/, '');   // strip the BOM
  return text.split('\r\n');
}
```
Assert headers (БРОЙ vs ЕЛЕМЕНТ swap with `itemize`), row dimensions, and the kant
subtraction (banded РАЗМЕР = nominal − kant per banded edge of that dimension).

## 5. Screenshots (optional)

`mcp__playwright__browser_take_screenshot` after selecting an object shows the 3D
result. Verifying numbers via `browser_evaluate` is usually more decisive.

## 6. Build check (separate from runtime verify)

```bash
npm run build
```
Two **expected, pre-existing** failures that are NOT your bug:
- **`bundle initial exceeded maximum budget … 1.x MB`** — Three.js weight.
- **`Inlining of fonts failed … fonts.googleapis.com`** — only when offline.
A clean run still prints `√ Building...` before these; real TS/template errors appear
as `error TS…` / `error NG…` above them. The build's `prebuild` hook regenerates
`src/app/projects/projects.data.ts` — **revert it** afterward:
`git checkout -- src/app/projects/projects.data.ts`.

## 7. Cleanup (do this every time)

- `reset()` the scene inside your last evaluate.
- Remove Playwright artifacts and the regenerated data file:
  ```bash
  rm -rf .playwright-mcp ; git checkout -- src/app/projects/projects.data.ts
  ```
- Leave `git status` showing only the files you intended to change.
