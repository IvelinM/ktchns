# WebCAD Viewer (`/admin`)

A parametric 3D kitchen-modelling tool built directly on Three.js, served at the
`/admin` route. It lets you pick a **family** (a parametric object template), set
its parameters, place instances in a 3D scene, select them, and move them with
Revit-style snapping.

Everything lives in one component:

| File | Role |
|------|------|
| `src/app/admin/admin-page.component.ts`   | All logic: families, geometry, Three.js scene, interaction state machine, snapping |
| `src/app/admin/admin-page.component.html` | Control panel + viewport overlays (mode banner, plane selector, snap legend, marquee box) |
| `src/app/admin/admin-page.component.scss` | Styling |
| `assets/images/3D/chipboard-texture.jpg`  | 1300×1300 chipboard texture mapped onto solid edges |

> **Routing note:** `src/app/app.routes.ts` defines `''` → `HomeComponent`
> and `admin` → `AdminPageComponent`. The public marketing site was extracted
> out of `AppComponent` into its own `HomeComponent` so the admin tool could
> live on a separate route. (Earlier the app had no router — if you find docs
> claiming "`app.routes.ts` is empty", they predate the WebCAD work.)

---

## 1. Mental model

```
FAMILIES (templates)  ──pick──▶  currentParams  ──Place──▶  SceneInstance (data)
                                                                │
                                                                ├─▶ objectMap: id → THREE.Object3D (the 3D twin)
                                                                └─▶ instances[]: the serialisable scene list
```

- **`FamilyDef`** — a template. Has an `id`, display `name`, a list of `ParamDef`,
  and a `buildObject(params)` that returns a `THREE.Object3D`.
- **`SceneInstance`** — one placed object: `{ id, familyId, label, params, x, y, z, rotY }`.
  This is the **data model** — the source of truth, serialisable.
- **`objectMap: Map<number, THREE.Object3D>`** — the live Three.js object for each
  instance id. The 3D scene is a *projection* of the data model; the data model is
  never derived from the scene.

Every instance gets a unique `id` from the monotonic `nextId` counter. The id is
the key linking `instances[]`, `objectMap`, `selectedIds`, and `moveOrigins`.

---

## 2. The family system

```ts
interface ParamDef {
  key: string;            // property name in the params record
  label: string;          // shown in the panel (may be Cyrillic, e.g. ДЕБЕЛИНА)
  defaultValue: number;
  min: number;
  step: number;
  unit: string;           // 'mm', '°', '' …
  type?: 'number' | 'toggle';   // 'toggle' renders a checkbox (0/1); default 'number'
}

interface FamilyDef {
  id: string;
  name: string;
  params: ParamDef[];
  buildObject(p: Record<string, number>): THREE.Object3D;
}
```

Families are declared in the module-level `FAMILIES` array. Two exist today:

### `ploskost` (a single panel / slab)
| key             | label          | default | notes |
|-----------------|----------------|---------|-------|
| `AB`            | AB             | 600     | length of side AB (mm) |
| `BC`            | BC             | 600     | length of side BC (mm) |
| `angle`         | ∠ABC           | 90      | angle between AB and BC (°) — allows parallelograms/trapezoids |
| `thickness`     | **ДЕБЕЛИНА**   | 18      | extrusion depth (mm) |
| `pvcEdge`       | **PVC Кант**   | 0       | `toggle` — 1 = PVC-banded edges, 0 = bare chipboard edges |
| `kantThickness` | **КАНТ ДЕБЕЛИНА** | 0.5   | PVC band thickness (mm). **Visual-only today** (see §5) |

`buildObject` → `makeMesh(AB, BC, angle, thickness, pvcEdge, kantThickness)`.

### `cabinet` (a 5-panel box)
Params `ШИРИНА` / `ВИСОЧИНА` / `ДЪЛБОЧИНА` (W/H/D). `buildObject` assembles five
`makeMesh(...)` panels (2 sides, top, bottom, back) into a `THREE.Group`, each
rotated/positioned, using a fixed 18 mm panel thickness.

### Adding a new family
1. Push a new `FamilyDef` into `FAMILIES`.
2. Implement `buildObject(p)` returning a `Mesh` or `Group`. Use `makeMesh()` for
   chipboard panels so you inherit the texture/edge conventions.
3. That's it — the panel, placement, selection, and move flows are family-agnostic.

### Adding a new param type
The template branches on `(p.type ?? 'number')`. Currently `'number'` (numeric
input) and `'toggle'` (checkbox writing 0/1). To add another, extend the
`ParamDef.type` union and add a matching `*ngIf` branch in **both** param grids in
the HTML (the "place new" grid **and** the "selected object" grid).

---

## 3. Geometry pipeline

### `buildPloskostGeo(AB, BC, angleDeg, thickness)`
Builds a `THREE.Shape` quad from the four corner points (origin, AB along +X, then
BC at `angle`), extrudes it by `thickness` with `bevelEnabled: false`, then
**recenters** the geometry on its bounding-box center so the object's local origin
is its centroid (important: placement/move math assumes the origin is the center).

### `makeMesh(AB, BC, angle, thickness, pvcEdge, pvcThickness)`
Returns a `THREE.Mesh` with a **two-element material array**, because
`ExtrudeGeometry` produces two groups:

| Group | Faces | Material |
|-------|-------|----------|
| **0** | caps — the two large flat front/back panels | `faceMat` — solid laminate colour (`COLOR_NORMAL`) |
| **1** | side walls — the thin cross-section around the perimeter | `edgeMat` — chipboard texture *or* PVC band |

- `castShadow = receiveShadow = true`.
- `pvcEdge=true` → `edgeMat` is a smooth bright material (`0xfcf9f5`), shininess
  scales subtly with `pvcThickness`.
- `pvcEdge=false` → `edgeMat` is the chipboard texture (see §5).

---

## 4. Colours & constants

```ts
COLOR_NORMAL   = 0xc8a87a   // laminate face, deselected
COLOR_SELECTED = 0x4a9cd4   // laminate face, selected (blue)
EDGE_NORMAL    = 0x333333   // wireframe edge line, deselected (dark)
EDGE_SELECTED  = 0xffffff   // wireframe edge line, selected (white)
EDGE_PVC       = 0x888888   // (declared; reserved)
```

---

## 5. ⚠️ The chipboard texture gotcha (read before touching texture sizing)

**`ExtrudeGeometry` emits side-wall UVs in MODEL-SPACE MILLIMETRES, not normalised
0–1.** One UV axis runs along the perimeter (0…perimeter mm), the other across the
thickness (0…thickness mm).

This means `texture.repeat` is a **mm-per-tile reciprocal**, not a tile count:

```ts
const TILE_MM = 220;                       // one texture tile = 220 mm of real chipboard
tex.repeat.set(1 / TILE_MM, 1 / TILE_MM);  // SAME scale on both axes → no stretching
```

- **Do NOT** write `tex.repeat.set(perimeter / N, …)`. That multiplies an
  already-huge mm-valued UV, producing thousands of sub-millimetre tiles that
  average to a **flat, plain colour**. (This was the original bug.)
- Equal scale on both axes keeps the speckle proportional. On an 18 mm-thick edge,
  V only covers `18/220 ≈ 0.08` of a tile — a thin horizontal slice, which is
  exactly how a real particleboard edge looks. Verify on a thick slab
  (e.g. `ДЕБЕЛИНА = 200`) where the grain is large and obvious.

### Texture loading
```ts
THREE.Cache.enabled = true;                  // module top — fetch the image only once
const CHIPBOARD_URL = 'assets/images/3D/chipboard-texture.jpg';
// inside makeMesh:
const tex = new THREE.TextureLoader().load(CHIPBOARD_URL);
tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
tex.colorSpace = THREE.SRGBColorSpace;       // correct gamma; without it the wood looks washed out
```

Each material loads its own texture object (so per-instance `repeat` can differ),
but `THREE.Cache` means the JPEG is only downloaded once. The texture is **NPOT**
(1300×1300); `RepeatWrapping` on NPOT requires WebGL2, which Three.js uses by
default — fine here.

`colorObj()` deliberately **skips** materials that have a `.map` (`if (!mat.map)`),
so selecting/deselecting a textured object never overwrites the chipboard texture
with a solid colour.

---

## 6. Edges (making solids readable)

Pure solids "hide in the mass" without visible edges, so every mesh gets a
black wireframe overlay:

```ts
function addEdges(obj) {
  obj.traverse(child => {
    if (child instanceof THREE.Mesh && !child.userData['isEdge']) {
      const lines = new THREE.LineSegments(
        new THREE.EdgesGeometry(child.geometry, 10),   // 10° threshold angle
        new THREE.LineBasicMaterial({ color: EDGE_NORMAL }),
      );
      lines.userData['isEdge'] = true;   // ← tag so we can tell edges from faces everywhere
      child.add(lines);                  // ← child of the mesh → inherits its world transform
    }
  });
}
```

`addEdges` is called by `spawnObject`. The `userData['isEdge']` tag is critical and
checked everywhere: face traversal, colouring, raycast picking, and snap-candidate
collection all use it to separate "real geometry" from "edge overlay lines".

`setEdgeColor(obj, hex)` recolours just the edge lines (used for selection
highlight: `EDGE_NORMAL` ↔ `EDGE_SELECTED`).

These same `EdgesGeometry` `LineSegments` are **also the snap-candidate source**
(see §9) — their vertex pairs give us clean endpoints/midpoints.

---

## 7. Interaction state machine

```ts
type InteractionMode = 'idle' | 'placing' | 'move-from' | 'move-to';
type MovePlane       = 'XZ' | 'XY' | 'YZ';
```

- **`idle`** — left-click picks (raycast); left-drag draws a marquee box-select.
- **`placing`** — a translucent **ghost** follows the cursor; click commits.
- **`move-from`** — first click sets the reference point (`moveFrom`).
- **`move-to`** — cursor previews the displacement live; click commits.

`Esc` (a `document:keydown` HostListener) → `cancelMode()`.

`modeLabel` drives the overlay banner text. The mode "pill" colour is set by CSS
classes `placing`/`moving`.

---

## 8. Selection

State: **`selectedIds = Set<number>`** (multi-select capable).

- `applySelect(ids)` — resets every previously-selected object to normal
  colour/edges, then highlights the new set (`COLOR_SELECTED` + `EDGE_SELECTED`).
- `selectedId` getter — returns the single id **only when exactly one** is selected,
  else `null`. The single-object detail panel binds to this.
- `selectedInstance` / `selectedFamilyDef` — derived from `selectedId`.

### Point pick (idle click)
Raycasts against meshes (faces only — `!isEdge`), tags each with
`userData['iid'] = id`, takes the nearest hit. Clicking the already-sole-selected
object deselects; clicking empty space clears.

### Marquee box-select (idle left-drag)
- Started in `onCanvasDown`; a >5px move flips `isMarqueeing` true.
- `marqueeRect` (client px) drives the blue `.marquee-box` overlay (set inside
  `ngZone.run` so Angular re-renders it).
- On mouse-up, `performMarqueeSelect` projects each object's **AABB 8 corners**
  to NDC, computes their screen-space bounds, and selects every object whose
  bounds overlap the marquee rectangle.

> **Template gotcha:** the instance list and dot use `selectedIds.has(inst.id)`,
> **not** `inst.id === selectedId`. The latter is `null` during multi-select and
> would never highlight more than one row.

---

## 9. Revit-style snapping (the important subsystem)

Goal: snap the cursor to **edge endpoints and midpoints of any solid**, anywhere in
3D — not only where a ray happens to hit a face, and not only on the ground plane.

The old raycast-against-faces approach failed both ways. The current approach is
**screen-space proximity**:

### `collectSnapCandidates(skip: Set<number> | null)`
Traverses the `isEdge` `LineSegments` of every object (except ids in `skip` — the
objects being moved). For each edge (vertex pair `i`, `i+1`):
- world-transform both endpoints,
- add both **endpoints** and their **midpoint**,
- dedupe by rounded world position (separate sets for endpoints vs midpoints),
- project each to **canvas pixel coords** (`vertex.project(camera)` → NDC → px),
- skip anything behind the camera (`ndc.z > 1`).

### `findObjectSnap(e, skip, pxRadius = 18)`
Compares every candidate's pixel position to the mouse pixel position; returns the
nearest within `pxRadius`. **Endpoints are sorted first**, so they win ties over
midpoints.

### `getSnap(e, plane, skip)` — the unified entry point
1. Try `findObjectSnap`. If found:
   - **`plane` given** (move-to): project the 3D snap point onto that plane.
   - **`plane` null** (placing / move-from): return the **raw 3D** snap point.
2. Otherwise fall back to **1 mm grid snap** on the plane (or `groundPlane`):
   raycast the plane, round x/y/z to the nearest mm.

Returns `{ pos, type: 'endpoint' | 'midpoint' | 'grid' }`.

> **Key fix:** `getSnap` no longer forces `y = 0` on object snaps, and candidates
> are collected in full 3D. That's what lets you snap to points **off** the ground
> plane (e.g. the top edge of a standing panel).

### `showSnap(pos, type)`
Moves the `snapDot` sphere to `pos` and colours it:
| type      | colour    | hex      |
|-----------|-----------|----------|
| endpoint  | cyan      | `0x00e5ff` |
| midpoint  | lime/green| `0x76ff03` |
| grid      | white     | `0xffffff` |

The viewport legend (`.snap-legend`) mirrors these colours and is shown whenever
`mode !== 'idle'`.

---

## 10. Move (two-step, multi-object, plane-constrained)

State:
- `moveFrom: Vector3` — the reference point chosen in `move-from`.
- `moveOrigins: Map<id, Vector3>` — each selected object's **starting** position,
  captured in `startMove`. (Was a single `moveOrigin` before multi-move.)
- `movePlane: 'XZ' | 'XY' | 'YZ'` — chosen via the plane buttons in the overlay;
  resets to `'XZ'` at the start of each move.

### Flow
1. **`startMove()`** — requires `selectedIds.size > 0`; snapshots every selected
   instance's `(x,y,z)` into `moveOrigins`; disables OrbitControls; enters
   `move-from`. Triggered by the **Move** button (single select) or **Move All**
   button (multi-select banner).
2. **`move-from` click** — `getSnap(e, null, null)` → store in `moveFrom`, enter
   `move-to`.
3. **`move-to` mousemove** — `getSnap(e, getActivePlane(), selectedIds)` →
   `previewDisplacement(pos)` moves every selected 3D object live (no data write).
4. **`move-to` click** — `commitDisplacement(pos)` writes the new positions into
   both the data model and 3D, then **manually** returns to `idle`.

### `getActivePlane()`
Builds a `THREE.Plane` through `moveFrom`, oriented by `movePlane`:
- `XZ` → normal `(0,1,0)` (horizontal, constant Y)
- `XY` → normal `(0,0,1)` (constant Z)
- `YZ` → normal `(1,0,0)` (constant X)

### `previewDisplacement` / `commitDisplacement`
Both iterate `moveOrigins` and apply the **same** delta `(toPos − moveFrom)` to
every selected object, but only the axes the active plane allows:
- `XZ` → move in X and Z, keep original Y
- `XY` → move in X and Y, keep original Z
- `YZ` → move in Y and Z, keep original X

`preview` updates only the 3D object (runs outside Angular zone, in the move
handler). `commit` updates the `SceneInstance` data **and** the object (runs inside
`ngZone.run`).

> **⚠️ The move-commit gotcha:** on a successful commit, **do not call
> `cancelMode()`**. `cancelMode()` has a `move-to` branch that restores every object
> to `moveOrigins` — calling it after committing snaps the objects right back to
> their start. The commit path instead sets `mode='idle'`, re-enables controls, and
> hides the snap dot by hand.

---

## 11. Axis labels

X/Y/Z labels sit at the tips of the central `AxesHelper(500)` arrows, built by
`makeAxisLabel(text, color, pos)`:
- draws the glyph on a 128² canvas, wraps it in a `CanvasTexture` (sRGB),
- returns a `THREE.Sprite` (always camera-facing) with `depthTest: false` and
  `renderOrder: 999` so the labels never get occluded by geometry.
- Colours match the axes: **X** red `0xff5555`, **Y** green `0x55ff55`,
  **Z** blue `0x5588ff`. Positioned at `axisLen + 70` along each axis.

---

## 12. Three.js scene setup (`initThree`)

- **Coordinate system / units:** **1 world unit = 1 mm.** Camera near/far and
  OrbitControls distances are sized accordingly (`maxDistance 50000`,
  far plane `100000`). Camera starts at `(1500, 1200, 1500)` looking at origin.
- **Lights:** ambient (0.45) + a shadow-casting key `DirectionalLight` (2048²
  shadow map, large ortho frustum ±8000) + a cool fill light.
- **Helpers:** `GridHelper(5000, 500)` (≈10 mm cells over 5 m) + `AxesHelper(500)`
  + the three axis-label sprites.
- **`snapDot`** — an 8 mm sphere with a `MeshBasicMaterial`; hidden until a snap is
  active. Recoloured by `showSnap`.
- **`groundPlane`** — `Plane(normal (0,1,0), 0)`, i.e. Y = 0. Used for the
  placement/grid fallback.

### OrbitControls button mapping (deliberately non-default)
```ts
controls.mouseButtons.LEFT   = null;          // ← left is reserved for select / marquee
controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
controls.mouseButtons.RIGHT  = THREE.MOUSE.ROTATE;
```
Damping on (`0.06`). Controls are **disabled** during `placing` / `move-*` so drags
don't orbit the camera mid-operation.

### Zone management
The whole render loop and Three.js setup run via
`ngZone.runOutsideAngular(() => this.initThree())` so the 60 fps `requestAnimationFrame`
loop doesn't trigger Angular change detection. Any handler that must update Angular
UI (selection, marquee rect, commit) explicitly wraps that part in `ngZone.run(...)`.

Canvas listeners (`mousedown`/`click`/`mousemove`/`mouseup`) are bound in
`initThree` and removed in `ngOnDestroy`, alongside `cancelAnimationFrame`,
`resizeObserver.disconnect()`, `renderer.dispose()`, and disposing every object.

A `ResizeObserver` on the canvas parent keeps camera aspect and renderer size in
sync.

---

## 13. Memory management

- `disposeObj(obj)` traverses and disposes geometry + material(s) for both `Mesh`
  and `LineSegments`. Called on delete, on rebuild, on ghost teardown, and for
  every object in `ngOnDestroy`.
- `rebuildSelected()` (when a selected object's params change) removes + disposes
  the old object and respawns it, re-applying the selection highlight.

---

## 14. Property editing (single-select panel)

- **Parameters** — editing a numeric/toggle param calls `rebuildSelected()`
  (geometry changes → must rebuild the mesh).
- **Position (x/y/z, mm)** — `updatePosition()` just sets `obj.position`
  (no rebuild needed).
- **Rotation Y (°)** — `updateRotation()` sets `obj.rotation.y` (degrees → radians).
- **Move / Delete** buttons. Move is disabled unless `mode === 'idle'`.

---

## 15. Gotchas checklist

1. **Texture repeat is mm-reciprocal, not tile count.** See §5. Equal scale on
   both axes; use `1 / TILE_MM`.
2. **`colorObj` skips `.map` materials** so chipboard isn't recoloured on select.
3. **Edges are tagged `userData['isEdge']`.** Every face/geometry traversal filters
   on this — keep tagging new edge overlays.
4. **Snap candidates come from the `isEdge` LineSegments.** No edges → no snap
   points. Any new family that wants snapping must go through `addEdges`.
5. **Don't `cancelMode()` after a successful move-commit** — it restores origins.
6. **Multi-select highlight uses `selectedIds.has(id)`**, not `=== selectedId`.
7. **Geometry origin is the centroid** (recentred in `buildPloskostGeo`) — move/
   place math assumes this.
8. **OrbitControls LEFT is disabled** — left-drag belongs to marquee select; orbit
   is right-drag, pan is middle-drag.
9. **Run UI-affecting handler code inside `ngZone.run`** — the render loop is
   outside Angular's zone.
10. **`kantThickness` (КАНТ ДЕБЕЛИНА) is visual-only today** — it nudges PVC
    shininess but does **not** model the band as separate offset geometry. If a
    real banded edge is needed, inset the chipboard and add a thin shell mesh.
11. **NPOT chipboard texture (1300²) needs WebGL2** for `RepeatWrapping` (default in
    Three.js — fine, but don't force WebGL1).

---

## 16. Quick verification recipe

Dev server: `npm start` → http://localhost:4200/admin

Manual smoke test:
1. Place two Ploskost panels → confirm tan faces, visible dark edges, X/Y/Z labels
   at the origin.
2. Set `ДЕБЕЛИНА = 200`, place, orbit (right-drag) + zoom → the thick edge shows
   chipboard speckle grain (not a flat colour).
3. Toggle **PVC Кант** on a selected panel → edges turn smooth bright white;
   **КАНТ ДЕБЕЛИНА** input appears/edits.
4. Left-drag a marquee over both → "2 objects selected" banner with **Move All**.
5. **Move All** → pick a reference point, switch plane (XZ/XY/YZ), watch the snap
   dot turn cyan on endpoints / green on midpoints, click to commit; objects keep
   their new position (don't snap back).

(During the WebCAD work this was automated with a Playwright script driving the
canvas and asserting param labels + console-error-free load; the script was a
throwaway and is not committed.)
