# WebCAD — modes, selection, transform tools, undo

[← index](../webcad.md) · snapping: [snapping.md](snapping.md)

## State machine

```ts
type InteractionMode =
  | 'idle' | 'placing' | 'move-from' | 'move-to'
  | 'measure-from' | 'measure-to' | 'match'
  | 'wall-from' | 'wall-to' | 'slab-from' | 'slab-to';
type MovePlane = 'XZ' | 'XY' | 'YZ';
```
- **idle** — left-click picks; left-drag = marquee box-select.
- **placing** — translucent ghost follows cursor; click commits.
- **move-from / move-to** — shared by **Move, Copy, Array** (distinguished by `isCopy`/
  `isArray`) **and by wall vertex/segment editing** (`wallEdit` set). `Esc` →
  `cancelMode()`. OrbitControls disabled during placing/move-*/measure-*/wall-*/slab-*.
- **measure-from / measure-to** — two-click dimension tool (below).
- **wall-from/wall-to**, **slab-from/slab-to** — the СТЕНА / ПЛОЧА polyline draw tools.
- **match** — click targets to copy the selected source's props onto same-family objects.

## In-command navigation (controls disabled, but you can still look around)
Because tools disable OrbitControls, the component re-implements navigation for them:
- **Scroll wheel** → `onCanvasWheel` dollies the camera (`dollyCamera`) when controls are off.
- **Shift + middle(scroll-wheel)-drag** during measure → `orbitCamera` rotates the view.

## Selection

`selectedIds = Set<number>`. `applySelect(ids)` resets old highlights, sets the new
set, [migrates](data-model.md) newly-selected stale instances, applies
`COLOR_SELECTED`/`EDGE_SELECTED`. `selectedId` getter = the single id only when exactly
one is selected.
- **Point pick** (idle click): raycast faces (`!isEdge`), tag `userData['iid']`,
  nearest; clicking the sole selection deselects; empty space clears.
- **Shift-click = additive/toggle**: adds the clicked instance to the selection, or
  removes it if already selected (ignores TAB panel focus; empty space keeps the set).
  Shift also skips wall-handle pickup so you can multi-select while a wall is selected.
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

## Measure tool (`measure-from` → `measure-to`)
Two clicks drop a dimension line with a length label. The free cursor snaps via
`measureSnap` (object endpoints/midpoints → **world axes incl. the vertical 0y** via
`worldAxisSnap` → ground grid). Holding **Shift** on the 2nd point locks the segment
**parallel to an axis** (0x / 0y / 0z) by the dominant drag direction
(`axisLockedMeasurePoint`) — so vertical measurements work; orbit (Shift+scroll-drag) to
a side view to point along Y. A new first click clears the previous frozen measurement.

## Wall vertex / segment editing (after a wall is finished)
Select a single **СТЕНА** → yellow vertex handles + cyan segment-midpoint handles appear
(`updateWallHandles`, an overlay group, `renderOrder` high, `depthTest:false`). Clicking
a handle enters `move-to` with `wallEdit` set, reusing the whole move pipeline (Shift
axis-lock, snapping, **typed distance + Enter**). Dropping rewrites `inst.path` (local
frame, via `wallToWorld`/`worldToWallLocal`) and rebuilds the solid; one undo step;
`Esc` restores the original polyline. Handles are removed when any tool starts or the
selection changes.

## СТЕНА / ПЛОЧА draw tools
Polyline tools that build **one** instance from `inst.path`. Shift = `lockAxisXZ`
(ground-plane axis lock). Enter finishes the run; a wall keeps its growing instance, a
slab is finalised from its committed polygon in `cancelMode`/finish. New walls and slabs
default `material` to **`'БЯЛО МАТ'`**.

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

Top-centre toolbar: **Move · Copy · Array · ×N · Match · Delete · | · СТЕНА · ПЛОЧА ·
Measure · | · Visualisation ▾ · Dark/Light**. Edit tools disabled unless `canEdit`.
The **Visualisation** dropdown holds **Render · Materials · Settings**, and the
theme button flips dark/light (see [visualisation.md](visualisation.md)).

The left panel shows one context: **0 selected** = FAMILY picker + place (params +
МАТЕРИАЛИ section for КОРПУС) + SCENE list + [schedule](schedule.md) export;
**1 selected** = Материал, Parameters, МАТЕРИАЛИ, Position, Rotation Y (0–360° slider
snapping to 0/90/180/270/360 within 8°), Move/Copy/Delete; **>1** = multi-select banner.
`Del` deletes the selection while idle (ignored while typing in an input).
