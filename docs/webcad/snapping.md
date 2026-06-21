# WebCAD — Revit-style snapping

[← index](../webcad.md) · used by [tools.md](tools.md)

Goal: snap the cursor to **edge endpoints/midpoints of any solid**, the **world origin
(0,0,0)**, or a **1 mm grid** — anywhere in 3D. The approach is **screen-space
proximity**, not raycasting faces (which failed off the ground plane).

- **`collectSnapCandidates(skip)`** — traverses the `isEdge` `LineSegments` of every
  object (except ids in `skip` — the ones being moved). For each edge: world-transform
  both endpoints, add both endpoints + their midpoint, dedupe by rounded world
  position, project to canvas px, drop points behind the camera. The world **origin**
  is always added as an `'origin'` candidate. (Snap candidates come from the edge
  overlay — a family with no edges has none.)

- **`findObjectSnap(e, skip, pxRadius=18)`** — nearest candidate within `pxRadius` px of
  the cursor; tie-priority **origin > endpoint > midpoint**.

- **`getSnap(e, plane, skip)`** — the unified entry point:
  1. Object-snap first. If a `plane` is given (move-to), project the snap onto it; else
     (placing / move-from) return the raw 3D point.
  2. Fallback: 1 mm grid snap on the plane (or `groundPlane`) — raycast, round x/y/z;
     `applyAxisSnap` pins a coord to 0 within a few px of a main axis (type `'axis'`).
  Returns `{ pos, type: 'endpoint'|'midpoint'|'origin'|'axis'|'grid' }`.

- **`showSnap(pos, type)`** moves the `snapDot` sphere and colours it: origin magenta
  `0xff44dd`, endpoint cyan `0x00e5ff`, midpoint lime `0x76ff03`, axis yellow `0xffd400`,
  grid white. The viewport `.snap-legend` mirrors these and shows whenever `mode !== 'idle'`.

## Measure-tool snapping (see [tools.md](tools.md))
The measure cursor uses **`measureSnap(e)`** = object snap → **`worldAxisSnap(e)`** → grid.
`worldAxisSnap` snaps onto the world **X, Y or Z axis line** in true 3D (so it reaches the
**vertical 0y axis**, which the ground grid can't). Holding Shift instead *locks the
segment* to an axis via `axisLockedMeasurePoint` (by dominant drag direction).
