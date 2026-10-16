# WebCAD — the cut-list export (Спецификация)

[← index](../webcad.md)

The cut-list text is built by **`buildScheduleText(instances, itemize)`** in
**`src/app/admin/webcad-schedule.ts`** (pure); the component's `exportSchedule()` just
wraps it in a Blob and downloads `schedule.txt`. It's a **tab-separated `.txt`** (UTF-8
**with BOM**, CRLF) so Excel reads the Cyrillic headers. Button at the bottom of the
SCENE panel.

It lists **every ploskost panel in the project** — standalone Ploskost objects **and**
each panel composing every МОДУЛ (via [`korpusPanels`](korpus.md)), with its `КАНТ_ДЕБЕЛИНА`
for the band thickness. Each panel's own board + edge-band **material names** are resolved
the same way the 3D build colours it (`resolveMaterials` in webcad-schedule.ts, mirroring
`cadColorObj`/`applyRenderMaterials`): a МОДУЛ panel reads its per-panel pick
(`<PANEL_NAME>_МАТЕРИАЛ` / `_КАНТ_МАТЕРИАЛ` from `inst.materials`, spaces → underscores);
a ПЛОСКОСТ reads the flat `МАТЕРИАЛ`/`МАТЕРИАЛ_КАНТ` keys, falling back to the legacy
free-text `material` field for an instance saved before either existed. Blank when nothing
resolves — never a guessed material.

## Columns

`ЕЛЕМЕНТ`*, `МАТЕРИАЛ`, `КАНТ МАТЕРИАЛ`, `РАЗМЕР 1`, `РАЗМЕР 2`, `БРОЙ`*,
`КАНТ РАЗМЕР 1 ОТПРЕД`, `КАНТ РАЗМЕР 1 ОТЗАД`, `КАНТ РАЗМЕР 2 ОТПРЕД`, `КАНТ РАЗМЕР 2 ОТЗАД`.

The `itemize` checkbox toggles the two **mutually-exclusive** columns:
- **off (merged)**: no ЕЛЕМЕНТ; **БРОЙ present**; identical panels (same material, kant
  material, size and banding) merge **across the whole project**; БРОЙ = quantity.
- **on (itemized)**: **ЕЛЕМЕНТ present** (the panel's role/label); **no БРОЙ**; one row
  per physical panel.

## Edge → dimension mapping & the kant subtraction

- РАЗМЕР 1 = AB; its parallel edges are **AB (ОТПРЕД)** and **CD (ОТЗАД)** = `pvc[0]`,
  `pvc[2]` → the **КАНТ РАЗМЕР 1** columns.
- РАЗМЕР 2 = BC; its parallel edges are **BC (ОТПРЕД)** and **DA (ОТЗАД)** = `pvc[1]`,
  `pvc[3]` → the **КАНТ РАЗМЕР 2** columns.
- A КАНТ cell holds the **band thickness (mm)** when that edge is banded, else blank.
- The reported **cut (core) size subtracts the band thickness** for each banded edge of
  that dimension: `РАЗМЕР 1 = AB − kant·(pvcAB?1:0 + pvcCD?1:0)`, likewise РАЗМЕР 2.
  E.g. AB=600, BC=500, pvcAB+pvcBC, kant=1 → **599 × 499**.

## Extending

To add a new family's panels to the cut-list, add a branch in `buildScheduleText`
(webcad-schedule.ts) calling `addPanel(element, material, kantMaterial, AB, BC, pvc, kant)`
per panel — `resolveMaterials(inst, panelName)` (`panelName: null` for a panel-less family)
gets you the two material names.
