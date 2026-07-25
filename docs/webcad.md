# WebCAD Viewer (`/admin`) — index

A parametric 3D kitchen-modelling tool built on Three.js, served at `/admin`. Pick a
**family**, set parameters, place instances, **move/copy/array** them with Revit-style
snapping, then export a **cut-list (Спецификация)** for the shop.

## Code layout (which file does what)

The engine is split into focused modules under `src/app/admin/` — open only the one you
need. The pure modules (no Angular, no `this`) hold the domain logic; the component is the
Angular interaction controller.

| File | Responsibility |
|------|----------------|
| `webcad.model.ts` | **Read first.** All types (`SceneInstance`, `FamilyDef`, `ParamDef`, `MaterialDef`, `PanelInfo`, …) + shared constants (colours, `CENTRE_ANCHOR`). The vocabulary. |
| `webcad-geometry.ts` | Pure solid builders: `makeMesh` (ploskost + inset PVC bands), `korpusPanels`/`buildKorpus` (carcass), `buildWallPath`, `buildSlabPath`. |
| `webcad-families.ts` | `FAMILIES` catalog (the open/closed extension point) + the КОРПУС param/material lists. |
| `webcad-object3d.ts` | Three.js object utilities: `disposeObj`, `anchorWrap`/`normAnchor`, `addEdges`, `colorObj`/`setEdgeColor`, `ghostify`. |
| `webcad-schedule.ts` | `buildScheduleText(instances, itemize)` — the cut-list (Спецификация) text. |
| `admin-page.component.{ts,html,scss}` | The Angular component: viewport, scene↔data sync, toolbar/panel UI, and every mouse/keyboard tool (place, move/copy/array, measure, wall+vertex editing, slab, match, snap, render/materials, save/load). |

Assets: `assets/images/3D/chipboard-texture.jpg`. Route: `app.routes.ts` maps `admin` → `AdminPageComponent`.

## Read the topic you need (each file is short)

| File | Covers |
|------|--------|
| [`webcad/data-model.md`](webcad/data-model.md) | `SceneInstance`, `objectMap`, ids, in-memory scene, `backfillParams` migration |
| [`webcad/families.md`](webcad/families.md) | `FamilyDef`/`ParamDef`, the four families (incl. hidden wall/slab) & their params, adding a family |
| [`webcad/geometry.md`](webcad/geometry.md) | ploskost as 1–5 inset band solids, `makeMesh`, the texture gotcha, edges, colours |
| [`webcad/korpus.md`](webcad/korpus.md) | КОРПУС С ВРАТА carcass: `korpusPanels`, depth envelope, visible-edge joinery, door fuga |
| [`webcad/snapping.md`](webcad/snapping.md) | endpoint/midpoint/origin/grid snap subsystem |
| [`webcad/tools.md`](webcad/tools.md) | modes, selection (incl. shift-additive), move/copy/array, measure, wall-vertex editing, in-command nav, undo, toolbar |
| [`webcad/visualisation.md`](webcad/visualisation.md) | Render (PBR preview), Materials + JPG textures, dark/light theme, camera brightness |
| [`webcad/schedule.md`](webcad/schedule.md) | the cut-list `.txt` export (columns, kant subtraction, itemize) |
| [`webcad/scene-build.md`](webcad/scene-build.md) | Three.js setup, zones, disposal, build caveats, gotchas checklist |

## Golden rules (the ones that bite)

1. **The data model (`instances[]`) is the source of truth**; the 3D scene is derived.
2. **Build panels with `makeMesh()`** — never raw geometry — to inherit edges, texture,
   bands, and selection. Bands are separate **inset/flush** solids; nominal AB×BC is the
   *finished outer* size.
3. **Run UI-touching handler code in `ngZone.run`** — the render loop is outside Angular.
4. **Don't `cancelMode()` after a successful commit** — use `finishMoveTo` (cancel restores origins).
5. Older instances self-heal via `backfillParams` / `backfillMaterials` when you add a param/material;
   the full scene (instances + material library + view) **does** persist via Save/Load JSON (v2).
6. **Material visuals (colour/texture/PBR) only show in Render mode**, never in CAD mode.
7. **Render is the only realistic mode.** A GPU path tracer (`three-gpu-pathtracer`) and a
   raster "Photo" mode were both tried and removed — don't re-add them. See visualisation.md.

## Verifying changes

Use the **`webcad-verify`** skill — drive the running dev server with Playwright +
`window.ng.getComponent('app-admin-page')` and inspect `instances`. Don't click the
canvas. To author families, use the **`webcad-family`** skill.
