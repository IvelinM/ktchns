# WebCAD — Three.js setup, zones, build caveats, gotchas

[← index](../webcad.md)

## Scene (`initThree`)

- **Units:** 1 world unit = 1 mm. Camera at `(1500,1200,1500)`, far 100000;
  OrbitControls `maxDistance 50000`.
- **Lights:** ambient 0.45 + shadow-casting key DirectionalLight (2048² map, ±8000
  ortho) + cool fill.
- **Helpers:** `GridHelper(5000,500)` + `AxesHelper(500)` + X/Y/Z sprite labels
  (`makeAxisLabel`, depthTest off, renderOrder 999).
- **Aids:** `snapDot` (8 mm sphere, hidden until snapping), `moveLine` (gold guide line
  for move/copy/array), `groundPlane` (Y=0 fallback).
- **OrbitControls (non-default):** `LEFT = null` (reserved for select/marquee),
  `MIDDLE = PAN`, `RIGHT = ROTATE`; damping 0.06.
- **Nav cube** (top-right, `initNavCube`): a second, tiny scene/camera/renderer pair
  driving `canvas.nav-cube` — a labelled 6-face `BoxGeometry` gizmo mirroring the main
  camera's viewing direction every frame (`renderNavCube`). Clicking a face
  (`onNavCubeClick` → `orientToNavFace`) slerp-tweens the main camera to look straight
  at it (`stepNavTween`, driven from `animate()`), keeping `controls.target` and
  distance fixed. **Never rotate `camera.up` away from `(0,1,0)`** — OrbitControls
  captures `camera.up` once at construction to build its internal reorientation quat,
  so changing it later desyncs orbiting; TOP/BOTTOM face directions instead carry a
  small (~1°) tilt off the vertical to dodge the `lookAt` degenerate case without
  touching `up`. Face textures are theme-aware canvas textures rebuilt by
  `rebuildNavCubeFaces()` (called from `toggleTheme()`).

## Angular zones

The render loop + setup run in `ngZone.runOutsideAngular` (so 60 fps RAF doesn't
trigger change detection). **Any handler that touches Angular UI** (selection, marquee
rect, distance label, commit) wraps that part in `ngZone.run(...)`. Listeners are
removed and every object disposed in `ngOnDestroy`.

## Build caveats (expected — NOT code bugs)

`npm run build` always reports:
- **`bundle initial exceeded maximum budget … 1.x MB`** — Three.js weight (error-level
  in `angular.json`, pre-existing).
- **`Inlining of fonts failed … fonts.googleapis.com`** — only when offline.

A clean compile still prints `√ Building...`; real errors appear as `error TS…` /
`error NG…` above these. The component-style budget was raised to 16 kB for the
toolbar. The `prebuild` hook rewrites `src/app/projects/projects.data.ts` — **revert
it** afterward (`git checkout --`). Prefer the **`webcad-verify`** skill (dev server +
`window.ng`) over the production build to confirm behaviour.

## Gotchas checklist

1. **Bands are separate inset/flush solids** ([geometry](geometry.md)) — nominal AB×BC
   is the finished outer size. Not material groups.
2. **Texture repeat is mm-reciprocal**: `1/TILE_MM` for the chipboard edge; user material
   JPGs use per-axis `(1/textureW, 1/textureH)` for a real-world tile size ([visualisation](visualisation.md)).
3. **`colorObj` skips `.map` and `edgeBand` materials** — tag new band materials `edgeBand`.
4. **Edges tagged `isEdge`** are the snap source — no edges, no snap/pick.
5. **Don't `cancelMode()` after a successful move/copy/array commit** — use `finishMoveTo`.
6. **Multi-select highlight uses `selectedIds.has(id)`**, not `=== selectedId`.
7. **Geometry origin is the centroid** — move/place math assumes it.
8. **OrbitControls LEFT is disabled** — left-drag is marquee; orbit = right-drag.
9. **Run UI-affecting handler code in `ngZone.run`.**
10. **`С_*` КОРПУС toggles are positive** (checked = present).
11. **`ДЪЛБОЧИНА` is outer depth** — sides/top/bottom fit between back & door.
12. **`backfillParams`/`backfillMaterials` migrate** older in-memory instances on a new param/material.
13. **Material visuals appear only in Render mode** (`renderMode` → `applyRenderMaterials`),
    never in flat CAD mode. Render is the only realistic mode — there is no path tracer
    ([visualisation](visualisation.md)).
14. **Verify the 3D viewport with `gl.readPixels`, not screenshots** —
    `preserveDrawingBuffer:false` makes off-screen captures stale/black.
