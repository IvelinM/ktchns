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

### HDRI environment + ray-cast AO via progressive accumulation
The realism comes from a **studio HDRI** (`assets/images/3D/studio.hdr`, Poly Haven CC0
`brown_photostudio_02` 1k) and **stochastic shadow-mapped lighting**, both driven by
`renderAccum()`. `loadHdri()` (lazy, `HDRLoader` at `FloatType`) PMREM-encodes the HDRI for
reflections (`envTexture`) and keeps its raw float equirect for CPU direction sampling
(`sampleHdri`); until it loads, RoomEnvironment is the fallback.

While the view is idle, `renderAccum()` averages up to `accumMax` (48) samples into a HalfFloat
ping/pong pair (`accumA`/`accumB`); a `FullScreenQuad` folds each in (`mix(avg, sample, 1/(n+1))`)
and another tone-maps (ACES) the average to screen, so tone mapping happens once. Per sample:
- **camera** jittered sub-pixel (anti-aliasing);
- **one directional key light** aimed from a uniform upper-hemisphere direction, coloured by
  the HDRI radiance there, and **shadow-mapped**. Averaging these *is* image-based lighting
  whose per-direction visibility (the shadow map) darkens crevices and contacts — i.e.
  **ray-cast ambient occlusion + soft shadows** as a byproduct. `n === 0` (the frame shown
  while orbiting) uses a neutral white key for a responsive preview.

`applyLighting()` keeps the constant fill **off** and ambient ~`0.015×` (a uniform unshadowed
fill would cancel the AO), and `enterRenderScene` sets `scene.environmentIntensity = 0.28` so
the analytic IBL supplies specular reflections while the sampled lights carry the *occluded*
diffuse. Accumulation **restarts** (`accumDirty`) on camera move, scene change, HDRI load, or
resize; while moving it shows one fresh sample. The whole pipeline uses only ordinary scene
renders + shadow maps + HalfFloat targets — **no depth-texture sampling** — because screen-space
AO (GTAO) was tried here and produced **no occlusion at all** on the owner's Iris Xe
(ANGLE/D3D11): the normal G-buffer had data but the depth-based AO buffer stayed empty at every
setting. This shadow-map route is the Iris-Xe-safe way to get real AO in the browser.

Render is the **only** realistic *in-browser* mode; the offline Blender/Cycles route
(**Export for render**, below) is the path to true photoreal stills. A GPU path tracer
(`three-gpu-pathtracer`), a raster "Photo" post mode (EffectComposer/TAA/GTAO), and a GTAO AO
pass were all tried and **removed** — the path tracer and GTAO both failed on Intel integrated
GPUs (Iris Xe), and Photo was redundant. **Don't reintroduce any of them.** (The `roughness`
floor of 0.06 is a leftover NaN-guard from the path-tracer attempt; harmless, keep it.)

## Export for render (`exportForRender`) — offline photoreal via Blender
For true V-Ray-class stills (global illumination, area-light shadows, accurate glossy
reflections) there is an **offline** path that does *not* run in the browser, so the Iris Xe
limit doesn't apply. **Visualisation ▸ Export for render (.glb)** writes one self-contained
`.glb` via three's `GLTFExporter`: every instance is **cloned** and given the Render-mode
`MeshStandardMaterial` look (`applyRenderMaterials(clone, inst, false)` — the `false` skips
`m.dispose()` so the shared *live* materials survive), edge lines stay invisible so
`onlyVisible` drops them, and a clone of the current camera is added carrying `viewAspect` in
`userData` (→ glTF node extras). glTF PBR maps 1:1 onto Blender's Principled BSDF. The
render itself is done by `scripts/render/render_kitchen.py` (Cycles + OpenImageDenoise, CPU,
bundled studio HDRI) — see `scripts/render/README.md`. This is a separate tool, **not** a
re-add of the removed in-browser path tracer / Photo mode.

## Materials dialog (`materialsDialogOpen`) — the scene material library
Edits `materialDefs: MaterialDef[]` (scene-level; see [data-model.md](data-model.md)).
Per material: name, **Цвят** (colour), **JPG texture** + tile size + rotation, and sliders for
**Прозрачност / Отражение / Гланц / Релеф** (transparency / reflection / glossiness / bump) plus
**Размер релеф** (bump grain, mm — shown only when bump > 0). Add / delete materials; instances
reference a material by **name**. `onMaterialEdited()` clears the texture cache and re-skins the
scene: full PBR rebuild in Render mode, else it re-applies the **flat CAD colour indication**.

**Релеф (bump)** drives a procedural noise `bumpMap` (`bumpTexture(sizeMM)` — a cached 128²
value-noise `CanvasTexture`, one per grain size, tiling every `bumpSize` mm; `bumpScale =
bump/100 × 1.4`), for a structured/orange-peel micro-surface (ШАГРЕ ships `bump: 55`). Render-mode
only, and not a glTF concept, so the Blender export drops it.

### CAD-mode colour indication (`cadColorObj`)
Outside Render, each element's faces are tinted with its assigned material's **colour** (flat, no
PBR) so finishes are distinguishable in the modelling view — applied at `spawnObject`, restored on
deselect (`applySelect`), and after a library load. Selected objects still show the blue highlight
(`COLOR_SELECTED`); a face with no library material falls back to `COLOR_NORMAL`. **Restore order
gotcha:** `restoreScene` runs before `restoreMaterialLibrary`, so objects are first tinted against
the defaults only; `restoreMaterialLibrary` therefore re-skins every object at the end, or custom
materials would lose their tint on refresh.

The library starts from `DEFAULT_MATERIALS` (ГЛАДКО БЯЛО + БЯЛО ГЛАНЦ/МАТ/ШАГРЕ, ЧЕРНО
ГЛАНЦ/МАТ, СТЪКЛО, ОПУШЕНО СТЪКЛО, НЕРЪЖДАВЕЙКА, ХРОМ). `reflection` → `metalness` and
`glossiness` → `roughness`; the metals (`reflection > 50`) get a ×3.6 `envMapIntensity` boost
in `applyRenderMaterials` so their mirror reflections survive the low `scene.environmentIntensity`
without re-flooding matte AO. A loaded scene keeps its own library but has any **missing**
defaults merged in by name (`restoreMaterialLibrary`), so the standard finishes are always there.

### Per-element assignment
The **МАТЕРИАЛИ** section assigns a library material to each panel/band by name
(`materialParams` key → `<PANEL>_МАТЕРИАЛ` / `_КАНТ_МАТЕРИАЛ`, resolved in `applyRenderMaterials`
by walking up to the `userData['panel']` node). `setMaterial()` writes the pick and, in Render
mode, **re-skins that one object immediately** (`applyRenderMaterials` + `accumDirty`) so the
change is visible at once. Selection does **not** repaint faces in Render mode (`applySelect` /
`rebuildSelected` skip the blue tint there), so the true material stays visible while editing.

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

## Settings dialog (`settingsDialogOpen`) — camera brightness + lighting mode
A `cameraBrightness` slider (0.2–2.0) — `applyLighting()` scales the ambient/key lights by it
(and the tone-mapping exposure in Render). And a **Пряко слънце** (`directLight`) checkbox.
**Both** states cast realistic soft shadows + ray-cast AO: `renderAccum` always lights each
sample with one shadow-mapped directional light drawn from the upper hemisphere and coloured by
the HDRI (`sampleHdri`), so averaging their visibility gives soft overcast shadows. The checkbox
only adds a **sun** on top:
- **on** (default) — ~45 % of samples are a tight cone around `sunDir` (a defined, only slightly
  soft primary shadow); the rest are hemisphere "sky" fill.
- **off** — hemisphere sky only (slightly brighter to compensate for the missing sun): soft,
  even, wrap-around shadows — an overcast look, still grounded by real contact shadows.

`applyRenderEnv` keeps `environmentIntensity` at `0.28` in both (the sampled lights carry the
diffuse + shadows; the env is mainly specular reflections). Saved in the `view` block.

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
