# WebCAD — the cut-list export (Спецификация)

[← index](../webcad.md)

`exportSchedule()` writes a **tab-separated `.txt`** (UTF-8 **with BOM**, CRLF) so
Excel reads the Cyrillic headers; downloads as `schedule.txt`. Button at the bottom of
the SCENE panel.

It lists **every ploskost panel in the project** — standalone Ploskost objects **and**
each panel composing every КОРПУС С ВРАТА (via [`korpusPanels`](korpus.md), using the
cabinet's `material` for all its panels and its `КАНТ_ДЕБЕЛИНА` for the door band).

## Columns

`ЕЛЕМЕНТ`*, `МАТЕРИАЛ`, `РАЗМЕР 1`, `РАЗМЕР 2`, `БРОЙ`*,
`КАНТ РАЗМЕР 1 ОТПРЕД`, `КАНТ РАЗМЕР 1 ОТЗАД`, `КАНТ РАЗМЕР 2 ОТПРЕД`, `КАНТ РАЗМЕР 2 ОТЗАД`.

The `itemize` checkbox toggles the two **mutually-exclusive** columns:
- **off (merged)**: no ЕЛЕМЕНТ; **БРОЙ present**; identical panels merge **across the
  whole project**; БРОЙ = quantity.
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

To add a new family's panels to the cut-list, add a branch in `exportSchedule` calling
`addPanel(element, material, AB, BC, pvc, kant)` per panel.
