# WebCAD — data model & migration

[← index](../webcad.md)

```
FAMILIES (templates) ─pick→ currentParams ─Place→ SceneInstance (data)
                                                      ├→ objectMap: id → THREE.Object3D (the 3D twin)
                                                      └→ instances[]: the serialisable scene list
```

- **`SceneInstance`** = `{ id, familyId, label, params, material, x, y, z, rotY }`.
  The **source of truth** (serialisable). `material` is a free-text laminate spec
  (e.g. `ГЛАДКО БЯЛО КОРПУС`); `label` is `МОДУЛ <id>` for placed objects.
- **`objectMap: Map<number, THREE.Object3D>`** — the live Three.js object per id. The
  scene is a *projection* of the data model; never the reverse.
- **`nextId`** — monotonic counter; the id keys `instances[]`, `objectMap`,
  `selectedIds`, `moveOrigins`, and the undo snapshots.

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
backfill existed.)

## Spawning / disposing

- `spawnObject(inst)` — `backfillParams`, `buildObject(params)`, `addEdges`, set
  position/rotation, register in `objectMap`, add to scene.
- `disposeObj(obj)` — disposes geometry + material(s) for `Mesh` and `LineSegments`.
  Called on delete, rebuild, ghost teardown, undo, and `ngOnDestroy`.
- `rebuildSelected()` — on a param change: remove+dispose the old object, respawn,
  re-apply the selection highlight.
