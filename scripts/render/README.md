# Photoreal rendering (Blender / Cycles)

Turn a WebCAD scene into a **path-traced, denoised, V-Ray-class still**. The `/admin`
viewport's own **Render** mode is a real-time PBR *preview*; this pipeline is the offline
"money shot". It runs on the **CPU**, so it works on any machine (including Intel Iris Xe,
where the in-browser GPU path tracer never did).

## One-time setup

Install **Blender** (free) — https://www.blender.org/download/. Nothing else: the render
script uses Blender's built-in Python and one of its **bundled** studio HDRIs, so there
are no extra assets or packages to fetch.

## Workflow

1. In `/admin`, model the kitchen and set materials. Frame the shot in the viewport
   exactly as you want the render (the camera is captured).
2. **Visualisation ▸ Export for render (.glb)** → downloads `kitchen-render.glb`.
   It embeds the full PBR look (colours, textures, reflection/gloss) and the current camera.
3. Render it:

   ```powershell
   # from this folder (scripts/render/)
   ./render.ps1 "$env:USERPROFILE\Downloads\kitchen-render.glb"
   ```

   Output PNG lands next to the `.glb` (`kitchen-render.png`) unless you pass an out path.

### Options

| Wrapper flag | Default | What it does |
|---|---|---|
| *(2nd positional)* | `<glb>.png` | Output PNG path |
| `-Samples N` | `256` | Cycles samples. More = cleaner, slower. 128 draft, 512+ final. |
| `-Width N` | `1600` | Output width in px; height follows the captured camera aspect. |
| `-Hdri NAME` | `interior` | Lighting environment: `interior`, `studio`, `courtyard`, `city`, `forest`, `night`, `sunrise`, `sunset` (all bundled with Blender). |
| `-Engine cycles\|eevee` | `cycles` | `eevee` is a fast, less accurate preview; `cycles` is the photoreal path tracer. |

```powershell
# high-quality final frame in a bright studio environment
./render.ps1 kitchen-render.glb final.png -Samples 512 -Width 2400 -Hdri studio
```

### Without the wrapper (macOS/Linux, or Blender on PATH)

```bash
blender -b --python render_kitchen.py -- kitchen-render.glb out.png --samples 512 --hdri studio
```

## How it works / notes

- **Units:** WebCAD is in millimetres; the script scales the import by `0.001` (mm→m)
  about the origin, camera included, so the framing is preserved.
- **Camera match:** the exported camera carries its vertical FOV and a `viewAspect`
  custom property; the script sets the render resolution to that aspect and uses a
  vertical sensor fit, so the render matches the viewport framing.
- **Lighting:** an image-based-lit world (bundled HDRI) plus one soft sun for directional
  contact shadows, and a matte floor at `z = 0` so free-standing cabinets ground properly.
- **Materials:** glTF PBR metallic-roughness maps 1:1 onto Blender's Principled BSDF, so
  reflection/gloss/texture come across automatically. (Glass currently exports as simple
  alpha transparency, not true refraction — fine for previews; refine per-shot in Blender
  if you need real glass.)
- **CPU by default:** `scene.cycles.device = 'CPU'`. Denoising (OpenImageDenoise) keeps
  low-sample renders clean, so CPU is very usable.

This is a *separate, offline* tool. It does **not** change the in-browser renderer, and it
is **not** the removed in-browser GPU path tracer / "Photo" mode — see
`docs/webcad/visualisation.md`.
