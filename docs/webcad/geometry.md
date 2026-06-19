# WebCAD — ploskost geometry, texture, edges

[← index](../webcad.md)

## A ploskost = 1–5 solids (mass + inset band per edge)

A banded ploskost is **not** one mesh with per-side materials (old model). It is a
chipboard **mass solid plus one separate PVC band solid per checked edge** (1–5
solids). Bands are **inset/flush**: nominal `AB`×`BC` is the **finished outer** size;
the mass shrinks by the band thickness on each banded edge, and the band fills the
outer strip so its outer face is flush with the nominal edge — it never protrudes.
This is what makes a door's banded faces sit exactly on the carcass envelope.

`makeMesh(AB, BC, angleDeg, thickness, pvcSides=[AB,BC,CD,DA], pvcThickness=0.5)`:
1. Four quad corners + in-plane centre `(cx,cy)`.
2. For each banded edge, offset it **inward** by `pvcThickness` (inward normal of the
   CCW winding). **Core** corners = intersections of consecutive (offset) edge lines
   via `lineIntersect()` — works for angled panels too.
3. `extrudePanel(core, thickness, cx, cy)` → **mass** mesh, materials
   `[faceMat (laminate), makeChipboardEdgeMat() (textured side walls)]`.
4. For each banded edge, extrude the strip between nominal edge and inset core edge →
   a band mesh with `makePvcEdgeMat()`.
5. No bands → bare `Mesh`; else a `Group` (mass + bands).

> Local origin = centroid (`extrudePanel` shifts by `-cx,-cy` and centres Z). Move/place
> math assumes this.

## ⚠️ Chipboard texture gotcha (read before touching texture sizing)

`ExtrudeGeometry` emits side-wall UVs in **model-space millimetres**, not 0–1. So
`texture.repeat` is a **mm-per-tile reciprocal**, not a tile count:

```ts
const TILE_MM = 220;
tex.repeat.set(1 / TILE_MM, 1 / TILE_MM);  // equal scale both axes → no stretching
```
Never write `tex.repeat.set(perimeter / N, …)` — it averages to a flat colour. Verify
on a thick slab (`ДЕБЕЛИНА=200`) where the grain is obvious.

```ts
THREE.Cache.enabled = true;                 // fetch the JPEG once
tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
tex.colorSpace = THREE.SRGBColorSpace;      // correct gamma
```
NPOT texture (1300²) + `RepeatWrapping` needs WebGL2 (Three's default — don't force WebGL1).

## Edges & band material tagging

- `addEdges(obj)` adds a black `LineSegments` wireframe child to every `Mesh`, tagged
  `userData['isEdge']=true`. This tag separates real geometry from the overlay
  **everywhere** (traversal, colouring, raycast picking, snap candidates). It is also
  the **snap-candidate source** ([snapping.md](snapping.md)).
- `colorObj()` skips materials with a `.map` **and** those tagged `userData['edgeBand']`
  (chipboard *and* PVC), so selecting never repaints an edge band. **Tag every new band
  material `edgeBand`.**
- `setEdgeColor(obj, hex)` recolours just the edge lines for selection highlight.

## Colours & constants

```ts
COLOR_NORMAL=0xc8a87a  COLOR_SELECTED=0x4a9cd4   // laminate face deselected / selected
EDGE_NORMAL=0x333333   EDGE_SELECTED=0xffffff    // wireframe deselected / selected
KORPUS_KANT=1   // fallback door band mm if КАНТ_ДЕБЕЛИНА absent
DOOR_FUGA=2     // door reveal gap mm per checked ВРАТИЧКА ФУГА side
```
