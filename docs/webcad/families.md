# WebCAD — the family system

[← index](../webcad.md) · see also [geometry](geometry.md), [korpus](korpus.md)

Defined in **`src/app/admin/webcad-families.ts`**; types in `webcad.model.ts`; builders
in `webcad-geometry.ts`.

```ts
interface ParamDef { key; label; defaultValue; min; step; unit; type?: 'number'|'toggle'; }
interface MaterialParamDef { key; label; default: string; }   // a per-panel material pick
interface FamilyDef {
  id; name; params: ParamDef[];
  buildObject(p: Record<string,number>): THREE.Object3D;
  hidden?: boolean;                 // not in the FAMILY picker — created by a toolbar tool
  materialParams?: MaterialParamDef[];   // shows a МАТЕРИАЛИ section of material selects
}
```

Families live in the `FAMILIES` array. Cyrillic keys/labels are fine (e.g. `'С_ГРЪБ'`).
The placement, selection, move/copy/array, undo, and schedule flows are
**family-agnostic** — they only need `buildObject` to return a `Mesh`/`Group` of
`makeMesh()` panels. **Four families exist:**

| id | name | picker? | geometry |
|----|------|---------|----------|
| `ploskost` | ПЛОСКОСТ | yes | `makeMesh(...)` — one board + inset PVC bands |
| `cabinet-door` | КОРПУС С ВРАТА | yes | `buildKorpus(p, true)` — carcass + door; has `materialParams` |
| `wall` | СТЕНА | **hidden** | `buildWallPath(inst.path, …)` — vertical extruded polyline |
| `slab` | ПЛОЧА | **hidden** | `buildSlabPath(inst.path, …)` — flat extruded polygon |

`hidden` families are made by their toolbar tool (СТЕНА/ПЛОЧА), not the picker, and build
from `inst.path` (a polyline) rather than `buildObject` — see [tools.md](tools.md).
`materialParams` (КОРПУС only) drive the МАТЕРИАЛИ section — per-panel material names
stored in `inst.materials` and applied only in Render mode (see
[visualisation.md](visualisation.md)).
*(A plain `cabinet`/КОРПУС family existed earlier and was removed — only the door version remains.)*

## `ploskost` — a single panel/slab, optionally PVC-banded

| key | label | default | notes |
|-----|-------|---------|-------|
| `AB` | AB | 600 | finished length of side AB (mm) |
| `BC` | BC | 600 | finished length of side BC (mm) |
| `angle` | ∠ABC | 90 | angle AB↔BC (°); allows parallelograms/trapezoids |
| `thickness` | ДЕБЕЛИНА | 18 | extrusion depth (mm) |
| `pvcAB`/`pvcBC`/`pvcCD`/`pvcDA` | PVC Кант AB/BC/CD/DA | 0 | toggle — band that edge |
| `kantThickness` | КАНТ ДЕБЕЛИНА | 1 | band thickness (mm) — a real modelled solid |

Edges in winding order are **AB, BC, CD, DA** (fixed, assumed everywhere).
`buildObject` → `makeMesh(AB, BC, angle, thickness, [pvcAB,pvcBC,pvcCD,pvcDA], kantThickness)`.

## `cabinet-door` — КОРПУС С ВРАТА

Built by `buildKorpus(p, withDoor=true)` from the shared `KORPUS_PARAMS`. Full geometry:
[korpus.md](korpus.md). Param groups: dims (`ШИРИНА/ВИСОЧИНА/ДЪЛБОЧИНА`),
thicknesses (`ПЛОСКОСТ_ДЕБЕЛИНА`=18, `КАНТ_ДЕБЕЛИНА`=1), present-panel toggles
(`С_*`, default on), visible-edge flags (`*_ВИДИМ_КАНТ_*`), door reveals (`ВРАТИЧКА_ФУГА_*`).

> `С_*` toggles are **positive** (checked = panel present; uncheck to remove). They were
> once negative `БЕЗ_*` (checked = remove), which confused users — positive is correct.

## Adding / editing a family

Use the **`webcad-family`** skill. Push a `FamilyDef` into `FAMILIES`; build geometry
from `makeMesh()` panels; keep the local origin at the centroid. Adding a param to an
existing family relies on [`backfillParams`](data-model.md).

## Adding a param **type**

The template branches on `(p.type ?? 'number')` — `'number'` (numeric input) and
`'toggle'` (checkbox writing 0/1). To add another, extend `ParamDef.type` and add a
matching `*ngIf` branch in **both** param grids in the HTML — the "place new" grid
**and** the "selected object" grid.
