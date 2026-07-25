# WebCAD — visualisation (Render, Materials, theme, Settings)

[← index](../webcad.md) · data: [data-model.md](data-model.md)

The **Visualisation** toolbar dropdown holds **Render · Materials · Settings**; a separate
toolbar button toggles the **dark/light theme**. All material visuals (colours, textures,
PBR look) appear **only in Render mode** — normal CAD mode stays flat-shaded
(COLOR_NORMAL / selection blue) for clarity.

When `renderMode` is on, `spawnObject` runs `applyRenderMaterials` (PBR conversion);
toggling it calls `refreshAllObjects()` to rebuild every object with the active look.

## Render mode (`renderMode`) — the photoreal PBR preview
`toggleRender()` flips `renderMode`; `enterRenderScene()` builds a `RoomEnvironment` →
PMREM env map once (`envTexture`), sets `ACESFilmicToneMapping`, hides CAD helpers
(grid/axes/labels) + edge lines, and adds a shadow-catching ground plane (`exitRenderScene`
reverses it). `applyRenderMaterials(obj, inst)` converts each flat `MeshPhongMaterial` to
`MeshStandardMaterial` driven by the instance's material(s):
- which library material? panel faces use `inst.materials[<PANEL>_МАТЕРИАЛ]` (or
  `inst.material` for non-panel objects like walls); PVC bands use `*_КАНТ_МАТЕРИАЛ`.
- mapping: `metalness = reflection/100`, `roughness = max(0.06, 1 − glossiness/100)`,
  `opacity = 1 − transparency/100`, plus the JPG `texture` (below). The exposed
  chipboard edge keeps its own texture.

Render is the **only** realistic mode. A GPU path tracer (`three-gpu-pathtracer`) and a
raster "Photo" post-processing mode (EffectComposer/TAA/GTAO) were both built and then
**removed** — the path tracer rendered black on Intel integrated GPUs (the owner's Iris
Xe), and Photo was redundant with Render. **Don't reintroduce either.** (The `roughness`
floor of 0.06 is a leftover NaN-guard from the path-tracer attempt; harmless, keep it.)

## Materials dialog (`materialsDialogOpen`) — the scene material library
Edits `materialDefs: MaterialDef[]` (scene-level; see [data-model.md](data-model.md)).
Per material: name, **Цвят** (colour), **JPG texture** + tile size + rotation, and
0–100 % sliders for **Прозрачност / Отражение / Гланц** (transparency / reflection /
glossiness). Add / delete materials; instances reference a material by **name**.
`onMaterialEdited()` clears the texture cache and (in Render mode) rebuilds the scene.

### JPG textures at real-world scale
A material may hold a `texture` (data URL, so it round-trips in save/load) plus
`textureW`/`textureH` = the **physical tile size in mm** one image covers (e.g. a
1200×800 mm tile → `1200`/`800`) and `textureRotation` (degrees). `materialTexture(def)`
builds one cached `THREE.Texture` per (image + tile size + rotation) with
`repeat = (1/textureW, 1/textureH)`, `center = (0.5,0.5)` and `rotation = deg→rad` (so it
spins about the tile centre). This works because `ExtrudeGeometry` UVs are in
**model-space millimetres** — so the same 1/mm trick the chipboard edge uses maps one
tile to exactly `textureW × textureH` mm on any panel. A textured face renders with
`color = white` so the image shows faithfully.

## Settings dialog (`settingsDialogOpen`) — camera brightness
One slider, `cameraBrightness` (0.2–2.0). `applyLighting()` scales the ambient/key/fill
lights by it (and the tone-mapping exposure in Render mode). Saved in the `view` block.

## Dark / light theme (`lightTheme`, `@HostBinding('class.light')`)
The UI palette is CSS variables (`--c-bg`, `--c-panel`, `--c-text*`, …) in the SCSS;
`:host(.light)` overrides them. `toggleTheme()` flips the host class **and** the 3D
background (`applyViewportBackground`): light theme → near-white viewport, dark → near-black.
Theme + brightness + camera pose are saved/restored.

## Verifying render / texture work
WebGL canvas screenshots are unreliable here (`preserveDrawingBuffer:false` → stale/black
frames). Read pixels directly with `gl.readPixels`, or assert material props
(`mesh.material.map`, `.metalness`, `.color.getHexString()`, `map.repeat`). See the
**`webcad-verify`** skill.
