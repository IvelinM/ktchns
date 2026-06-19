# WebCAD — modes, selection, transform tools, undo

[← index](../webcad.md) · snapping: [snapping.md](snapping.md)

## State machine

```ts
type InteractionMode = 'idle' | 'placing' | 'move-from' | 'move-to';
type MovePlane       = 'XZ' | 'XY' | 'YZ';
```
- **idle** — left-click picks; left-drag = marquee box-select.
- **placing** — translucent ghost follows cursor; click commits.
- **move-from / move-to** — shared by **Move, Copy, Array** (distinguished by `isCopy`/
  `isArray`). `Esc` → `cancelMode()`. OrbitControls disabled during placing/move-*.

## Selection

`selectedIds = Set<number>`. `applySelect(ids)` resets old highlights, sets the new
set, [migrates](data-model.md) newly-selected stale instances, applies
`COLOR_SELECTED`/`EDGE_SELECTED`. `selectedId` getter = the single id only when exactly
one is selected.
- **Point pick** (idle click): raycast faces (`!isEdge`), tag `userData['iid']`,
  nearest; clicking the sole selection deselects; empty space clears.
- **Marquee** (idle left-drag): project each AABB's 8 corners to NDC; select those
  overlapping the rect. `.marquee-box` overlay set inside `ngZone.run`.
> Instance rows use `selectedIds.has(id)`, **not** `=== selectedId` (null in multi-select).

## Move / Copy / Array

Start via `beginMoveOp('move'|'copy'|'array')` (toolbar). Guarded by `canEdit` (idle +
≥1 selected). State: `moveFrom`, `moveOrigins` (id→start pos), `movePlane`
(`getActivePlane()` builds the plane through `moveFrom`), `copyGhosts` (Copy: keyed by
`id`; Array: by `arrayKey(id,n)=id*1000+n`), `arrayCount`.

Flow: **start** (snapshot origins, build ghosts, disable controls, `move-from`) →
**move-from click** sets `moveFrom`, enters `move-to` → **move-to mousemove**
previews + draws the guide line + stores in-plane `moveDir` → **commit** (click or
Enter):
- `displaced(origin, toPos)` applies the **plane-allowed delta** (XZ: X&Z, XY: X&Y, YZ: Y&Z).
- **Move** writes new positions; **Copy** spawns one duplicate/obj; **Array** spawns
  `arrayCount` duplicates/obj stepped by delta×n. Copy/Array selects the new objects.

> **⚠️ Don't `cancelMode()` after a successful commit** — it restores `moveOrigins`
> (snapping a real Move back). Use `finishMoveTo(pos)`. `cancelMode` restores originals
> only for a real Move (`!isCopy && !isArray`).

### Typed distance (cursor input)
During `move-to` a numeric input floats by the cursor. It shows the **live** distance
until the user types (`onDistanceTyped` sets `distanceLocked`), then stops syncing.
**Enter** → `commitTypedDistance()` commits along `moveDir` at the typed mm; a click
with a typed value honours it too. Auto-focuses on entering `move-to` (one-shot
`distFocusPending`). `commitTypedDistance` no-ops unless `mode==='move-to'`.

### Shift axis-lock
Holding **Shift** in `move-to` (`applyAxisLock`) pins the lesser-deviation in-plane
axis, so the move runs along the dominant axis.

## Undo (Ctrl/Cmd+Z, 50-deep)

Snapshot-based (`SceneSnapshot { instances, nextId }`, deep-copied).
- `pushHistory()` records **before** each discrete action (place, delete, move, copy,
  array). Capped at `UNDO_LIMIT = 50`.
- Property edits coalesce **per focus session**: `beginEdit()` (input `(focus)`)
  captures the pre-edit snapshot; the first change commits it once via
  `commitPendingEdit()`. One field edit = one undo step.
- `undo()` pops, disposes/clears the scene, restores instances + `nextId`, respawns,
  clears selection. `Ctrl/Cmd+Z` in `onKey` defers to native text undo while typing in
  an input; `Shift` excluded (reserved for a future redo).

## Toolbar & control panel

Top-centre toolbar: **Move · Copy · Array · ×N · Delete** — disabled unless `canEdit`.
The left panel shows one context: **0 selected** = FAMILY picker + place + SCENE list +
[schedule](schedule.md) export; **1 selected** = Материал, Parameters, Position,
Rotation Y (0–360° slider snapping to 0/90/180/270/360 within 8°), Move/Copy/Delete;
**>1** = multi-select banner. `Del` deletes the selection while idle (ignored while
typing in an input).
