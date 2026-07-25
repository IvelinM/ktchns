---
name: webcad-family
description: Add or edit a parametric family (Ploskost, КОРПУС С ВРАТА, or a new one) in the WebCAD /admin tool — params, buildObject, the panel/band-solid conventions, the КОРПУС carcass model, and the param-migration rule. Use when changing what objects can be modelled or their parameters; families live in src/app/admin/webcad-families.ts (geometry in webcad-geometry.ts).
---

# Add or edit a WebCAD family

The WebCAD engine is split into modules under `src/app/admin/`: families are the
`FAMILIES` array in **`webcad-families.ts`**, geometry builders (`makeMesh`,
`korpusPanels`, `buildKorpus`, `buildWallPath`, `buildSlabPath`) in
**`webcad-geometry.ts`**, types in **`webcad.model.ts`**; the cut-list is
**`webcad-schedule.ts`**; `admin-page.component.ts` is the Angular controller. Reference
docs (short, focused): `docs/webcad/families.md`, `geometry.md`, `korpus.md`,
`data-model.md` (index: `docs/webcad.md`). Verify every change with the
**`webcad-verify`** skill.

```ts
interface ParamDef { key; label; defaultValue; min; step; unit; type?: 'number'|'toggle'; }
interface MaterialParamDef { key; label; default: string; }   // a per-panel material pick
interface FamilyDef {
  id; name; params: ParamDef[];
  buildObject(p: Record<string,number>): THREE.Object3D;
  hidden?: boolean;                 // not in the FAMILY picker — made by a toolbar tool
  materialParams?: MaterialParamDef[];   // shows a МАТЕРИАЛИ section of material selects
}
```

The placement, selection, move/copy/array, undo, and schedule flows are
**family-agnostic** — they only need `buildObject` to return a `Mesh`/`Group` made
from `makeMesh()` panels (so edges, texture, bands, and selection highlighting all
work). **Four families exist:** `ploskost` and `cabinet-door` (КОРПУС С ВРАТА, picker)
plus **hidden** `wall` (СТЕНА) and `slab` (ПЛОЧА), which are made by their toolbar tools
and build from `inst.path` (a polyline) rather than `buildObject`.

## Build panels with `makeMesh`, never raw geometry

```ts
makeMesh(AB, BC, angleDeg, thickness, pvcSides=[AB,BC,CD,DA], pvcThickness=0.5): THREE.Object3D
```
- Returns a chipboard **mass** solid; for each `true` in `pvcSides` it adds a separate
  **inset/flush PVC band solid** on that edge (so 1–5 solids; a `Group` when banded).
- Nominal `AB×BC` is the **finished outer** size — bands inset the mass, never
  protrude. The four edges in winding order are **AB, BC, CD, DA**.
- Panels inherit: laminate face + chipboard-textured side walls, the `isEdge`
  wireframe overlay (added later by `addEdges` in `spawnObject`), and band materials
  tagged `userData['edgeBand']` so selection never repaints them.

## Adding a simple family

1. Push a `FamilyDef` into `FAMILIES` with a unique `id` and Cyrillic-friendly `name`.
2. List `params` (numeric or `type:'toggle'`). Cyrillic keys/labels are fine.
3. `buildObject(p)` returns `makeMesh(...)` or a `THREE.Group` of positioned/rotated
   `makeMesh` panels (see `buildKorpus`).
4. Keep the geometry centred on its centroid (`makeMesh`/`extrudePanel` already do);
   move/place math assumes the local origin is the centre.

## The КОРПУС model (reuse `korpusPanels` if extending cabinets)

`korpusPanels(p, withDoor)` (in `webcad-geometry.ts`) is the **single source** of the
carcass layout — used by both `buildKorpus` (3D) and `buildScheduleText` (cut-list). It
returns `KorpusPanel[]`
with a `name` (Bulgarian role → the schedule's ЕЛЕМЕНТ) and per-panel `pvc`. Rules:
- `ДЪЛБОЧИНА` is the **outer** depth; sides/top/bottom fit **between** back & door
  (`innerD = D − t_back − t_door`, centred at `innerZ`).
- `С_*` toggles are **positive** (checked = panel present). Default them to `1`.
- `*_ВИДИМ_КАНТ_*` flags choose which panel covers the other at a shared edge (true =
  this panel's edge runs to the outer face & covers the neighbour; false = inset).
  Top/bottom flags also drive the matching side panel's height — keep joints
  mutually consistent.
- `t = ПЛОСКОСТ_ДЕБЕЛИНА`, `kant = КАНТ_ДЕБЕЛИНА` come from instance params.
If you add a carcass panel, add it in `korpusPanels` (with a `name` + `pvc`) and it
flows into both the 3D and the schedule automatically.

## Param type rendering (HTML)

The template branches on `(p.type ?? 'number')`: `'number'` (numeric input) and
`'toggle'` (checkbox writing 0/1). To add a new type, extend `ParamDef.type` and add a
matching `*ngIf` branch in **both** param grids — the "place new" grid **and** the
"selected object" grid.

## ⚠️ Adding a param to an EXISTING family

The scene is in-memory only, so instances placed before your new param lack its key.
`backfillParams()` (called in `spawnObject` and `applySelect`) fills missing params
from `defaultValue`, so older instances self-heal when spawned or re-selected — rely
on it, and choose a sensible `defaultValue`. (This was a real bug: a renamed/added
toggle did nothing on existing instances until backfill was added.)

## Schedule integration (`buildScheduleText` in `webcad-schedule.ts`)

If a new family produces ploskost panels you want in the cut-list, add a branch in
`buildScheduleText` mapping the instance to `addPanel(element, material, AB, BC, pvc, kant)`.
Column mapping: РАЗМЕР 1 = AB (banded edges AB=`pvc[0]`/CD=`pvc[2]`), РАЗМЕР 2 = BC
(BC=`pvc[1]`/DA=`pvc[3]`); the reported size subtracts `kant` per banded edge of that
dimension.

## Verify

Build (`npm run build` — ignore the pre-existing bundle/font failures, watch for
`error TS`/`error NG`), then drive the live component per the **`webcad-verify`**
skill: place the family, count solids, toggle params, and export the schedule.
Afterward `git checkout -- src/app/projects/projects.data.ts`.
