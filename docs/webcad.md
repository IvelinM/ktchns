# WebCAD Viewer (`/admin`) — index

A parametric 3D kitchen-modelling tool built on Three.js, served at `/admin`. Pick a
**family**, set parameters, place instances, **move/copy/array** them with Revit-style
snapping, then export a **cut-list (Спецификация)** for the shop.

Everything is one standalone component:
`src/app/admin/admin-page.component.{ts,html,scss}` + `assets/images/3D/chipboard-texture.jpg`.
Route: `app.routes.ts` maps `admin` → `AdminPageComponent`.

## Read the topic you need (each file is short)

| File | Covers |
|------|--------|
| [`webcad/data-model.md`](webcad/data-model.md) | `SceneInstance`, `objectMap`, ids, in-memory scene, `backfillParams` migration |
| [`webcad/families.md`](webcad/families.md) | `FamilyDef`/`ParamDef`, the two families & their params, adding a family |
| [`webcad/geometry.md`](webcad/geometry.md) | ploskost as 1–5 inset band solids, `makeMesh`, the texture gotcha, edges, colours |
| [`webcad/korpus.md`](webcad/korpus.md) | КОРПУС С ВРАТА carcass: `korpusPanels`, depth envelope, visible-edge joinery, door fuga |
| [`webcad/snapping.md`](webcad/snapping.md) | endpoint/midpoint/origin/grid snap subsystem |
| [`webcad/tools.md`](webcad/tools.md) | modes, selection, move/copy/array, typed distance, shift-lock, undo, toolbar, panel |
| [`webcad/schedule.md`](webcad/schedule.md) | the cut-list `.txt` export (columns, kant subtraction, itemize) |
| [`webcad/scene-build.md`](webcad/scene-build.md) | Three.js setup, zones, disposal, build caveats, gotchas checklist |

## Golden rules (the ones that bite)

1. **The data model (`instances[]`) is the source of truth**; the 3D scene is derived.
2. **Build panels with `makeMesh()`** — never raw geometry — to inherit edges, texture,
   bands, and selection. Bands are separate **inset/flush** solids; nominal AB×BC is the
   *finished outer* size.
3. **Run UI-touching handler code in `ngZone.run`** — the render loop is outside Angular.
4. **Don't `cancelMode()` after a successful commit** — use `finishMoveTo` (cancel restores origins).
5. The scene is **in-memory only**; `backfillParams` migrates older instances when you add a param.

## Verifying changes

Use the **`webcad-verify`** skill — drive the running dev server with Playwright +
`window.ng.getComponent('app-admin-page')` and inspect `instances`. Don't click the
canvas. To author families, use the **`webcad-family`** skill.
