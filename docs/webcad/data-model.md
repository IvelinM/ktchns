# WebCAD — data model & migration

[← index](../webcad.md)

```
FAMILIES (templates) ─pick→ currentParams ─Place→ SceneInstance (data)
                                                      ├→ objectMap: id → THREE.Object3D (the 3D twin)
                                                      └→ instances[]: the serialisable scene list
```

- **`SceneInstance`** (defined in `webcad.model.ts`) =
  `{ id, familyId, label, params, material, x, y, z, rotY, anchor?, path?, materials? }`.
  The **source of truth** (serialisable).
  - `material` — free-text laminate spec / library material **name** (e.g. `БЯЛО МАТ`).
    Walls and slabs **default to `'БЯЛО МАТ'`**; cabinets/ploskost default to `''`.
  - `anchor?: {x,y,z}` (each −1/0/+1) — the base/insertion point (bbox face), default centre.
  - `path?: WallPoint[]` — СТЕНА/ПЛОЧА polyline in the instance's local frame (the wall/slab
    geometry is built from this, not from `buildObject`).
  - `materials?: Record<string,string>` — per-panel material **names** for a КОРПУС
    (keys = the family's `materialParams` keys). Used only by Render mode.
- **`objectMap: Map<number, THREE.Object3D>`** — the live Three.js object per id. The
  scene is a *projection* of the data model; never the reverse.
- **`nextId`** — monotonic counter; the id keys `instances[]`, `objectMap`,
  `selectedIds`, `moveOrigins`, and the undo snapshots.
- **Material library** (`materialDefs: MaterialDef[]`) is scene-level, not per-instance:
  `{ name, color, transparency, reflection, glossiness, texture?, textureW?, textureH? }`.
  Edited in the Materials dialog; an instance's `material`/`materials` names look up into
  it. See [visualisation.md](visualisation.md).

## Save / Load (JSON, format v2)

`saveScene()` downloads **everything configurable**: `instances` (with params, materials,
position, anchor, path), the `materials` library, and a `view` block
(`theme`, `cameraBrightness`, `camera.position`, `camera.target`). `loadScene()` restores
all of it (`restoreScene` + `restoreMaterialLibrary` + `restoreView`); older v1 files
(no `materials`/`view`) still load and keep the current library/view. Transient
Render on/off state is **not** saved — files reopen in normal editing view.

## The scene is in-memory only

There is no persistence. So an instance placed **before** a family gained a new param
has no key for it.

**`backfillParams(inst)`** fills any param the family defines but the instance lacks
(from `defaultValue`) and returns whether it changed. Called in:
- `spawnObject` — every freshly built object has complete params.
- `applySelect` — selecting an older instance rebuilds it so its geometry and the panel
  toggles agree.

This self-healing is what lets in-memory instances survive newly-added parameters.
**When you add a param to an existing family, you depend on it** — pick a sensible
default. (Real bug once: a renamed toggle did nothing on existing instances until
backfill existed.) **`backfillMaterials(inst)`** does the same for a КОРПУС's
`materialParams` (fills missing per-panel material names from each `default`).

## Spawning / disposing

- `spawnObject(inst)` — `backfillParams`, `buildObject(params)`, `addEdges`, set
  position/rotation, register in `objectMap`, add to scene.
- `disposeObj(obj)` — disposes geometry + material(s) for `Mesh` and `LineSegments`.
  Called on delete, rebuild, ghost teardown, undo, and `ngOnDestroy`.
- `rebuildSelected()` — on a param change: remove+dispose the old object, respawn,
  re-apply the selection highlight.
