/**
 * WebCAD — pure geometry builders. Given plain numbers (parameters) these return
 * Three.js objects; none of them touch the scene, the component, or `this`.
 *
 * The core primitive is `makeMesh` (a "ploskost" = one board with optional PVC edge
 * bands as separate inset solids). `korpusPanels` decomposes a cabinet carcass into
 * its boards (the single source of the layout, shared by `buildKorpus` AND the cut-list
 * export), and `buildWallPath` / `buildSlabPath` extrude a ground polyline/polygon.
 */
import * as THREE from 'three';
import { COLOR_NORMAL, LINE_IDLE_COLOR } from './webcad.model';
import type { WallPoint, PlaneDesc } from './webcad.model';

// Enable Three.js asset cache so the same URL is only fetched once even when each
// material loads the texture independently.
THREE.Cache.enabled = true;

// Render-mode-only cosmetic edge chamfer on panel/band geometry (see `extrudePanel`) — a
// perfectly sharp 90° edge reads as a flat-shaded CG box; a tiny bevel catches a specular
// highlight along the edge the way a real laminate/PVC-banded panel does. Never applied in
// CAD mode, where exact nominal dimensions drive snapping, CSG and the cut-list export —
// admin-page.component.ts flips this around rebuilding the scene for Render, not per-call.
let renderBevel = false;
export function setRenderBevel(on: boolean) { renderBevel = on; }

const CHIPBOARD_URL = 'assets/images/3D/chipboard-texture.jpg';

/** PVC band thickness (mm) used on КОРПУС door edges (matches makeMesh's default). */
export const KORPUS_KANT = 1;

/** Default depth (mm) of each РЕБРО ТАВАН panel when С_РЕБРА is set (РЕБРА_ШИРИНА param). */
const REBRO_TAVAN_D_DEFAULT = 100;

/** Intersection of line (p1, dir d1) with line (p2, dir d2); falls back to p2 if parallel. */
function lineIntersect(p1: THREE.Vector2, d1: THREE.Vector2, p2: THREE.Vector2, d2: THREE.Vector2): THREE.Vector2 {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return p2.clone();
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return new THREE.Vector2(p1.x + d1.x * t, p1.y + d1.y * t);
}

/** Extrude a closed 2D outline by `thickness`, centred in Z, and shifted by (-cx,-cy) in plane. */
function extrudePanel(pts: THREE.Vector2[], thickness: number, cx: number, cy: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].y);
  shape.closePath();
  // Scale the chamfer to the panel's own thickness so a thin PVC band (~0.5–1mm) gets a
  // proportionally tiny bevel instead of one that eats the whole band; capped for thick
  // chipboard mass panels so it stays a subtle catch-light, not a visible facet.
  const bevel = renderBevel ? Math.max(0, Math.min(0.35, thickness * 0.2)) : 0;
  const geo = new THREE.ExtrudeGeometry(shape, bevel > 0
    ? { depth: thickness, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 2 }
    : { depth: thickness, bevelEnabled: false });
  geo.translate(-cx, -cy, -thickness / 2);
  return geo;
}

/** Chipboard cross-section texture material (the JPEG image itself is cached). */
function makeChipboardEdgeMat(): THREE.MeshPhongMaterial {
  const tex = new THREE.TextureLoader().load(CHIPBOARD_URL);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  // ExtrudeGeometry emits side-wall UVs in MODEL-SPACE MILLIMETRES (one axis runs
  // along the perimeter, the other across the thickness), not normalised 0–1. So a
  // repeat of 1/TILE_MM makes one tile span TILE_MM of real material — identical
  // scale on both axes, so the speckle stays proportional.
  const TILE_MM = 220;
  tex.repeat.set(1 / TILE_MM, 1 / TILE_MM);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshPhongMaterial({ map: tex, shininess: 5 });
  mat.userData['edgeBand'] = true;
  return mat;
}

/** Smooth bright PVC banding material; shininess scales subtly with band thickness. */
function makePvcEdgeMat(pvcThickness: number): THREE.MeshPhongMaterial {
  const s = Math.min(120, 60 + pvcThickness * 20);
  const mat = new THREE.MeshPhongMaterial({ color: 0xfcf9f5, shininess: s, specular: new THREE.Color(0x333333) });
  mat.userData['edgeBand'] = true;
  return mat;
}

/**
 * A ploskost as 1–5 solids: the chipboard mass plus one PVC band solid per checked
 * edge in `pvcSides` ([AB, BC, CD, DA]). Bands are INSET — the mass is shrunk by the
 * band thickness on each banded edge (offsetting that edge inward) and the band fills
 * the outer strip, so the band's outer face sits flush with the panel's nominal edge
 * and never protrudes beyond it. Returns a bare Mesh when no edge is banded, else a Group.
 */
export function makeMesh(
  AB: number, BC: number, angleDeg: number, thickness: number,
  pvcSides: boolean[] = [false, false, false, false], pvcThickness = 0.5,
  plainEdges = false,   // skip the chipboard image on the extruded perimeter (e.g. walls)
): THREE.Object3D {
  const a = angleDeg * (Math.PI / 180);
  const corners = [
    new THREE.Vector2(0, 0),
    new THREE.Vector2(AB, 0),
    new THREE.Vector2(AB + BC * Math.cos(a), BC * Math.sin(a)),
    new THREE.Vector2(BC * Math.cos(a), BC * Math.sin(a)),
  ];
  const xs = corners.map(c => c.x), ys = corners.map(c => c.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;

  // Offset each banded edge inward by the band thickness; the core corners are the
  // intersections of consecutive (possibly offset) edge lines.
  const dir: THREE.Vector2[] = [];
  const offPt: THREE.Vector2[] = [];
  for (let i = 0; i < 4; i++) {
    const ci = corners[i], cn = corners[(i + 1) % 4];
    const d = new THREE.Vector2().subVectors(cn, ci).normalize();
    dir.push(d);
    const inN = new THREE.Vector2(-d.y, d.x); // inward normal (CCW winding)
    offPt.push(pvcSides[i]
      ? new THREE.Vector2(ci.x + inN.x * pvcThickness, ci.y + inN.y * pvcThickness)
      : ci.clone());
  }
  const core: THREE.Vector2[] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 3) % 4; // previous edge shares corner i
    core.push(lineIntersect(offPt[j], dir[j], offPt[i], dir[i]));
  }

  const faceMat = new THREE.MeshPhongMaterial({
    color: COLOR_NORMAL, shininess: 30, specular: new THREE.Color(0x111111),
  });
  // Group 0 = the two flat faces (solid colour); group 1 = the extruded perimeter. A
  // plain-edge mesh uses the face colour for both, so there is no chipboard image.
  const mass = new THREE.Mesh(
    extrudePanel(core, thickness, cx, cy),
    plainEdges ? faceMat : [faceMat, makeChipboardEdgeMat()],
  );
  mass.castShadow = mass.receiveShadow = true;

  const bands: THREE.Mesh[] = [];
  for (let i = 0; i < 4; i++) {
    if (!pvcSides[i]) continue;
    // Strip filling between the nominal edge (corners i→i+1) and the inset core edge.
    const strip = [corners[i], corners[(i + 1) % 4], core[(i + 1) % 4], core[i]];
    const band = new THREE.Mesh(extrudePanel(strip, thickness, cx, cy), makePvcEdgeMat(pvcThickness));
    band.castShadow = band.receiveShadow = true;
    bands.push(band);
  }

  if (bands.length === 0) return mass;
  const group = new THREE.Group();
  group.add(mass, ...bands);
  return group;
}

/** One chipboard panel of a КОРПУС: part name, cut size (AB×BC), placement, per-side PVC. */
export interface KorpusPanel {
  name: string;     // role, e.g. ТАВАН / ДЪНО / ЛЯВА СТРАНИЦА …
  AB: number; BC: number;
  rx: number; ry: number; rz: number;
  px: number; py: number; pz: number;
  pvc: boolean[];   // [AB, BC, CD, DA]
  t: number;        // this panel's thickness (mm) — the back may differ (ГРЪБ ДЕБЕЛИНА)
}

/**
 * Decompose a КОРПУС (МОДУЛ) into its panels. This is the single source of the
 * carcass layout, consumed both by buildKorpus (to build the 3D group) and by the
 * schedule export (to list every panel).
 *
 * `С_*` toggles include/omit a panel. `*_ВИДИМ_КАНТ_*` flags pick which panel covers
 * the other at a shared edge (true → this panel's edge runs to the outer face and
 * covers its neighbour; false → it is inset by one thickness so the neighbour covers
 * it). A top/bottom flag also shortens the matching side panel to sit under it.
 *
 * С_РЕБРА and С_ТАВАН are mutually exclusive (enforced in the UI, see
 * `setToggleParam` in admin-page.component.ts): С_ТАВАН builds one full ТАВАН panel;
 * С_РЕБРА instead builds two narrow ribs (РЕБРО ТАВАН 1 front / РЕБРО ТАВАН 2 back,
 * each РЕБРА_ШИРИНА deep) spanning ШИРИНА minus the side-panel thicknesses — sides
 * then never trim for ribs (only a full ТАВАН panel trims them). The door's top edge
 * always follows the usual ВРАТИЧКА_ФУГА_ОТГОРЕ reveal (plus ВРАТИЧКА_ГОРЕН_РЪБ_ОФСЕТ),
 * regardless of С_ТАВАН vs С_РЕБРА, overridden to a flush inset when
 * ТАВАН_ВИДИМ_КАНТ_ОТПРЕД is set.
 *
 * ПОЛИЦИ: up to 10 independent shelves (С_ПОЛИЦА_1..10), each positioned purely by its
 * own ОФСЕТ_ОТДОЛУ (mm from the nominal bottom to the shelf's own bottom edge) —
 * unrelated to ДЪНО/ТАВАН/РЕБРА and never trimmed by or trimming any other panel. Its
 * own С_КАНТ_ОТПРЕД toggle bands the front edge; МАТЕРИАЛ/КАНТ_МАТЕРИАЛ live in
 * KORPUS_MATERIAL_PARAMS (webcad-families.ts).
 */
export function korpusPanels(p: Record<string, number>, withDoor: boolean): KorpusPanel[] {
  const W = p['ШИРИНА']    ?? 800;
  const H = p['ВИСОЧИНА']  ?? 720;
  const D = p['ДЪЛБОЧИНА'] ?? 550;
  const t = p['ПЛОСКОСТ_ДЕБЕЛИНА'] ?? 18;
  const backT = p['ГРЪБ_ДЕБЕЛИНА'] ?? t;   // the back may have its own thickness
  const b = (k: string) => Boolean(p[k]);

  const hasBack = b('С_ГРЪБ'), hasLeft = b('С_ЛЯВА_СТРАНИЦА'), hasRight = b('С_ДЯСНА_СТРАНИЦА');
  const hasRibs = b('С_РЕБРА');
  const hasTop  = b('С_ТАВАН') && !hasRibs;   // a full panel and ribs can never both build
  const hasBottom = b('С_ДЪНО'), hasDoor = b('С_ВРАТИЧКА');

  const grbL = b('ГРЪБ_ВИДИМ_КАНТ_ОТЛЯВО'), grbR = b('ГРЪБ_ВИДИМ_КАНТ_ОТДЯСНО');
  const grbT = b('ГРЪБ_ВИДИМ_КАНТ_ОТГОРЕ'), grbB = b('ГРЪБ_ВИДИМ_КАНТ_ОТДОЛУ');
  const tavL = b('ТАВАН_ВИДИМ_КАНТ_ОТЛЯВО'), tavR = b('ТАВАН_ВИДИМ_КАНТ_ОТДЯСНО');
  const dunL = b('ДЪНО_ВИДИМ_КАНТ_ОТЛЯВО'),  dunR = b('ДЪНО_ВИДИМ_КАНТ_ОТДЯСНО');
  // Does this panel's FRONT edge extend flush with the module's true front face
  // (covering the door there), instead of stopping at the door's rear face? The door
  // then insets on that side by this panel's thickness + 1 mm gap (see below). For the
  // ribs case this shifts РЕБРО ТАВАН 1 (the front rib) forward instead of resizing it.
  const sideLeftFront = b('ЛЯВА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД');
  const sideRightFront = b('ДЯСНА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД');
  const tavFront = b('ТАВАН_ВИДИМ_КАНТ_ОТПРЕД');
  const dunFront = b('ДЪНО_ВИДИМ_КАНТ_ОТПРЕД');
  // Raw vertical offsets (mm) added to that panel's own top/bottom edge, on top of
  // whatever the rest of this function already computes for it: positive always moves
  // the edge up (+Y) — further above the module's nominal top, or further inset from
  // its nominal bottom; negative always moves it down.
  const offTopLeft  = p['ЛЯВА_СТРАНИЦА_ГОРЕН_РЪБ_ОФСЕТ']  ?? 0;
  const offBotLeft  = p['ЛЯВА_СТРАНИЦА_ДОЛЕН_РЪБ_ОФСЕТ']  ?? 0;
  const offTopRight = p['ДЯСНА_СТРАНИЦА_ГОРЕН_РЪБ_ОФСЕТ'] ?? 0;
  const offBotRight = p['ДЯСНА_СТРАНИЦА_ДОЛЕН_РЪБ_ОФСЕТ'] ?? 0;
  const offTopDoor  = p['ВРАТИЧКА_ГОРЕН_РЪБ_ОФСЕТ']       ?? 0;
  const offBotDoor  = p['ВРАТИЧКА_ДОЛЕН_РЪБ_ОФСЕТ']       ?? 0;
  // Applies to whichever of С_ТАВАН/С_РЕБРА is actually active (mutually exclusive —
  // see this function's own doc comment): for a full ТАВАН panel, negative pulls its
  // front edge inward (shrinking depth) while the back edge stays exactly where
  // frontD/frontZ already fix it; for ribs, there's no "back edge" of its own to anchor,
  // so it instead just slides the front rib (РЕБРО ТАВАН 1) along Z — negative toward
  // the back, positive toward the front — leaving the back rib untouched either way.
  const offFrontTop = p['ТАВАН_ОФСЕТ_ОТПРЕД'] ?? 0;

  const mid = (a: number, c: number) => (a + c) / 2;
  const panels: KorpusPanel[] = [];
  const add = (name: string, AB: number, BC: number, rx: number, ry: number, rz: number,
               px: number, py: number, pz: number,
               pvc: boolean[] = [false, false, false, false], pt: number = t) =>
    panels.push({ name, AB, BC, rx, ry, rz, px, py, pz, pvc, t: pt });

  // ДЪЛБОЧИНА is the OUTER depth: the back occupies the rear backT and the door the
  // front t (when present). The sides, top and bottom fit BETWEEN them, so their
  // depth shrinks accordingly, e.g. with both present the top is
  // ДЪЛБОЧИНА − ГРЪБ_ДЕБЕЛИНА − t(ВРАТИЧКА) deep.
  const tBack = hasBack ? backT : 0;
  const tDoor = (withDoor && hasDoor) ? t : 0;
  // Per-panel depth override for a panel whose *_ВИДИМ_КАНТ_ОТПРЕД flag is set: its
  // front bound moves from the door's rear face (D/2 − tDoor) out to the true front
  // face (D/2); the rear bound (back panel/backT) is unaffected either way. `offset`
  // (mm, ТАВАН only so far) nudges that same front bound further still — negative
  // pulls it inward (shrinking depth), positive pushes it out — always relative to
  // the already-chosen front face, with the rear bound untouched regardless.
  const backBound = -D / 2 + tBack;
  const frontD = (extend: boolean, offset = 0, rearBound = backBound) => (extend ? D / 2 : D / 2 - tDoor) + offset - rearBound;
  const frontZ = (extend: boolean, offset = 0, rearBound = backBound) => mid(rearBound, (extend ? D / 2 : D / 2 - tDoor) + offset);
  // When the back panel is INSET on a side (its ГРЪБ_ВИДИМ_КАНТ_ОТЛЯВО/ОТДЯСНО flag is
  // false), that side panel must reach all the way to the true rear face instead of
  // stopping at the back panel's inner face, so it wraps around and covers the back
  // panel's now-recessed edge — the same covering rule already used for ТАВАН/ДЪНО vs
  // the sides (lTop/rTop/lBot/rBot below), just along Z instead of Y. When the flag is
  // true the back panel itself runs to the outer face and covers the side instead, so
  // the side stays at the normal inner boundary — zero change from before.
  const backBoundLeft  = grbL ? backBound : -D / 2;
  const backBoundRight = grbR ? backBound : -D / 2;
  const leftD  = frontD(sideLeftFront,  0, backBoundLeft),  leftZ  = frontZ(sideLeftFront,  0, backBoundLeft);
  const rightD = frontD(sideRightFront, 0, backBoundRight), rightZ = frontZ(sideRightFront, 0, backBoundRight);
  // Same covering rule again, this time between the back panel and ТАВАН/ДЪНО
  // (ГРЪБ_ВИДИМ_КАНТ_ОТГОРЕ/ОТДОЛУ): when the back panel is inset on top/bottom, that
  // panel must reach the true rear face to cover its now-recessed edge instead of
  // stopping at the back panel's inner face. Ribs (С_РЕБРА) are unaffected — this is the
  // full ТАВАН-panel path only, a materially different, mutually-exclusive case.
  const backBoundTop = grbT ? backBound : -D / 2;
  const backBoundBot = grbB ? backBound : -D / 2;
  const topD   = frontD(tavFront, offFrontTop, backBoundTop), topZ = frontZ(tavFront, offFrontTop, backBoundTop);
  const botD   = frontD(dunFront, 0, backBoundBot),            botZ = frontZ(dunFront, 0, backBoundBot);

  // Sides span the inner depth; their height is trimmed only where a present FULL
  // ТАВАН panel covers them (ribs never trim — they always sit between full-height
  // sides), then further adjusted by that side's own ГОРЕН/ДОЛЕН РЪБ ОФСЕТ.
  const lTop = ((hasTop && tavL) ? H / 2 - t : H / 2) + offTopLeft;
  const lBot = ((hasBottom && dunL) ? -(H / 2 - t) : -H / 2) + offBotLeft;
  const rTop = ((hasTop && tavR) ? H / 2 - t : H / 2) + offTopRight;
  const rBot = ((hasBottom && dunR) ? -(H / 2 - t) : -H / 2) + offBotRight;
  // PVC banding per panel, edge order [AB, BC, CD, DA]. The world-facing direction of
  // each local edge depends on the panel's rotation:
  //   Sides  (rot about Y): AB=ОТДОЛУ, BC=back, CD=ОТГОРЕ, DA=ОТПРЕД (meets ВРАТИЧКА).
  //   Top/bot(rot about X): AB=ОТПРЕД, BC=ОТДЯСНО, CD=back, DA=ОТЛЯВО.
  //   Back   (no rotation): AB=ОТДОЛУ, BC=ОТДЯСНО, CD=ОТГОРЕ, DA=ОТЛЯВО.
  const leftPvc  = [b('ЛЯВА_СТРАНИЦА_С_КАНТ_ОТДОЛУ'),  false, b('ЛЯВА_СТРАНИЦА_С_КАНТ_ОТГОРЕ'),  b('ЛЯВА_СТРАНИЦА_С_КАНТ_ОТПРЕД')];
  const rightPvc = [b('ДЯСНА_СТРАНИЦА_С_КАНТ_ОТДОЛУ'), false, b('ДЯСНА_СТРАНИЦА_С_КАНТ_ОТГОРЕ'), b('ДЯСНА_СТРАНИЦА_С_КАНТ_ОТПРЕД')];
  if (hasLeft)  add('ЛЯВА СТРАНИЦА',  leftD,  lTop - lBot, 0, Math.PI / 2, 0, -(W / 2 - t / 2), mid(lTop, lBot), leftZ,  leftPvc);
  if (hasRight) add('ДЯСНА СТРАНИЦА', rightD, rTop - rBot, 0, Math.PI / 2, 0,  (W / 2 - t / 2), mid(rTop, rBot), rightZ, rightPvc);

  // Bottom: width runs to the outer face on a side whose flag = true, else inset;
  // depth is the inner depth (between back and door), or extended flush to the front
  // when its own *_ВИДИМ_КАНТ_ОТПРЕД flag is set (see botD/botZ above).
  if (hasBottom) {
    const xl = dunL ? -W / 2 : -(W / 2 - t), xr = dunR ? W / 2 : W / 2 - t;
    const bottomPvc = [b('ДЪНО_С_КАНТ_ОТПРЕД'), b('ДЪНО_С_КАНТ_ОТДЯСНО'), false, b('ДЪНО_С_КАНТ_ОТЛЯВО')];
    add('ДЪНО', xr - xl, botD, -Math.PI / 2, 0, 0, mid(xl, xr), -(H / 2 - t / 2), botZ, bottomPvc);
  }

  // ПОЛИЦИ: up to 10 independent shelves, each toggled on/off (С_ПОЛИЦА_n) and placed by
  // its own ОФСЕТ_ОТДОЛУ — the shelf's finished bottom edge sits that many mm above the
  // module's nominal bottom, regardless of ДЪНО/ТАВАН/РЕБРА. Always inset between the
  // sides (never extends to the outer face) and never flush to the front door face.
  // ОФСЕТ_ОТПРЕД works exactly like ТАВАН_ОФСЕТ_ОТПРЕД above (same frontD/frontZ, just a
  // per-shelf offset instead of a shared one): negative pulls the shelf's front edge
  // inward (shrinking its depth), positive extends it forward past the door's rear face.
  for (let n = 1; n <= 10; n++) {
    if (!b(`С_ПОЛИЦА_${n}`)) continue;
    const offset = p[`ПОЛИЦА_${n}_ОФСЕТ_ОТДОЛУ`] ?? 0;
    const offsetFront = p[`ПОЛИЦА_${n}_ОФСЕТ_ОТПРЕД`] ?? 0;
    const xl = -(W / 2 - t), xr = W / 2 - t;
    const yb = -H / 2 + offset, yt = yb + t;
    const shelfPvc = [b(`ПОЛИЦА_${n}_С_КАНТ_ОТПРЕД`), false, false, false];
    add(`ПОЛИЦА ${n}`, xr - xl, frontD(false, offsetFront), -Math.PI / 2, 0, 0,
        mid(xl, xr), mid(yb, yt), frontZ(false, offsetFront), shelfPvc);
  }

  // Top: either one full ТАВАН panel (same depth-override rule as the sides/bottom)…
  if (hasTop) {
    const xl = tavL ? -W / 2 : -(W / 2 - t), xr = tavR ? W / 2 : W / 2 - t;
    const topPvc = [b('ТАВАН_С_КАНТ_ОТПРЕД'), b('ТАВАН_С_КАНТ_ОТДЯСНО'), false, b('ТАВАН_С_КАНТ_ОТЛЯВО')];
    add('ТАВАН', xr - xl, topD, -Math.PI / 2, 0, 0, mid(xl, xr),  (H / 2 - t / 2), topZ, topPvc);
  }
  // …or (mutually exclusive) two narrow ribs: width = ШИРИНА − left_t − right_t (sides
  // always cover), depth = РЕБРА_ШИРИНА. After −π/2 rotation around X, the AB edge
  // faces ОТПРЕД (toward door). Each rib's PVC toggle bands that interior-visible face.
  if (hasRibs) {
    const ribD = p['РЕБРА_ШИРИНА'] ?? REBRO_TAVAN_D_DEFAULT;
    const xl = hasLeft  ? -(W / 2 - t) : -W / 2;
    const xr = hasRight ? (W / 2 - t)  :  W / 2;
    const ribW = xr - xl;
    const pyRib = H / 2 - t / 2;
    // РЕБРО ТАВАН 1 — front rib, flush with the front inner face; when ТАВАН_ВИДИМ_КАНТ_ОТПРЕД
    // is set it shifts forward flush with the true front face instead (covering the door there).
    // ТАВАН_ОФСЕТ_ОТПРЕД then SLIDES it along Z on top of that — unlike the full-ТАВАН-
    // panel case (which it resizes, back edge fixed), a rib has no "back edge" of its
    // own to anchor, so here it just moves the whole rib: negative = toward the back
    // (−Z), positive = toward the front (+Z), same sign the full-panel case already uses.
    const z1 = (tavFront ? D / 2 : D / 2 - tDoor) - ribD / 2 + offFrontTop;
    add('РЕБРО ТАВАН 1', ribW, ribD, -Math.PI / 2, 0, 0, mid(xl, xr), pyRib, z1,
        [b('РЕБРО_ТАВАН_1_С_КАНТ_ОТПРЕД'), false, false, false]);
    // РЕБРО ТАВАН 2 — back rib, flush with the back inner face.
    const z2 = -D / 2 + tBack + ribD / 2;
    add('РЕБРО ТАВАН 2', ribW, ribD, -Math.PI / 2, 0, 0, mid(xl, xr), pyRib, z2,
        [b('РЕБРО_ТАВАН_2_С_КАНТ_ОТПРЕД'), false, false, false]);
  }

  // Back occupies the rear thickness of the envelope (its own ГРЪБ ДЕБЕЛИНА); each edge
  // runs to the outer face (covers) or is inset per its ГРЪБ_ВИДИМ flag, and is banded
  // per its ГРЪБ_С_КАНТ flag. ДВОЕН_ГРЪБ splits it into two leaves (see below) instead
  // of resizing it — this xl/xr/yb/yt opening is unaffected either way.
  if (hasBack) {
    const xl = grbL ? -W / 2 : -(W / 2 - t), xr = grbR ? W / 2 : W / 2 - t;
    const yb = grbB ? -H / 2 : -(H / 2 - t), yt = grbT ? H / 2 : H / 2 - t;
    const backZ = -(D / 2 - backT / 2);
    const grbBottom = b('ГРЪБ_С_КАНТ_ОТДОЛУ'), grbRight = b('ГРЪБ_С_КАНТ_ОТДЯСНО');
    const grbTopEdge = b('ГРЪБ_С_КАНТ_ОТГОРЕ'), grbLeftEdge = b('ГРЪБ_С_КАНТ_ОТЛЯВО');
    if (b('ДВОЕН_ГРЪБ')) {
      // Split into two leaves that ALWAYS touch with zero gap (unlike ДВОЙНА_ВРАТИЧКА's
      // configurable reveal) — the seam is never exposed, so that edge is never banded
      // regardless of the matching ГРЪБ_С_КАНТ_* toggle. Both leaves share the SAME
      // 'ГРЪБ' name (and so the same ГРЪБ_* material/kant lookup), only their size
      // differs. ГРЪБ_С_ХОРИЗОНТАЛНА_ФУГА (default true — opposite default from
      // ДВОЙНА_ВРАТИЧКА_С_ВЕРТИКАЛНА_ФУГА) picks which way they split: true → stacked,
      // divided by a HORIZONTAL fugue (split along Y, ГОРЕН/ДОЛЕН — ВИСОЧИНА_ГОРЕН_ГРЪБ
      // sizes the TOP leaf); false → side by side, divided by a VERTICAL fugue (split
      // along X, ЛЯВ/ДЯСЕН — ШИРИНА_ЛЯВ_ГРЪБ sizes the LEFT leaf).
      if (b('ГРЪБ_С_ХОРИЗОНТАЛНА_ФУГА')) {
        const totalH = yt - yb;
        const topH = Math.max(0, Math.min(p['ВИСОЧИНА_ГОРЕН_ГРЪБ'] ?? totalH / 2, totalH));
        const splitY = yt - topH;
        add('ГРЪБ', xr - xl, yt - splitY, 0, 0, 0, mid(xl, xr), mid(splitY, yt), backZ,
            [false, grbRight, grbTopEdge, grbLeftEdge], backT);
        add('ГРЪБ', xr - xl, splitY - yb, 0, 0, 0, mid(xl, xr), mid(yb, splitY), backZ,
            [grbBottom, grbRight, false, grbLeftEdge], backT);
      } else {
        const totalW = xr - xl;
        const leftW = Math.max(0, Math.min(p['ШИРИНА_ЛЯВ_ГРЪБ'] ?? totalW / 2, totalW));
        const splitX = xl + leftW;
        add('ГРЪБ', splitX - xl, yt - yb, 0, 0, 0, mid(xl, splitX), mid(yb, yt), backZ,
            [grbBottom, false, grbTopEdge, grbLeftEdge], backT);
        add('ГРЪБ', xr - splitX, yt - yb, 0, 0, 0, mid(splitX, xr), mid(yb, yt), backZ,
            [grbBottom, grbRight, grbTopEdge, false], backT);
      }
    } else {
      add('ГРЪБ', xr - xl, yt - yb, 0, 0, 0, mid(xl, xr), mid(yb, yt), backZ,
          [grbBottom, grbRight, grbTopEdge, grbLeftEdge], backT);
    }
  }

  // Front door occupies the front thickness of the envelope; left/right edges are
  // always banded, top/bottom follow their own toggles. No rotation, so — like ГРЪБ
  // above — AB=ОТДОЛУ, BC=ОТДЯСНО, CD=ОТГОРЕ, DA=ОТЛЯВО. When a neighbouring panel's
  // own *_ВИДИМ_КАНТ_ОТПРЕД flag extends it flush with the front face on that side,
  // the door insets from that boundary by the panel's thickness + 1 mm gap instead.
  // ДВОЙНА_ВРАТИЧКА splits this one opening into two leaves (see below) instead of
  // widening/narrowing it — the opening's own xl/xr/yb/yt are unaffected either way.
  if (withDoor && hasDoor) {
    const xl = sideLeftFront ? -W / 2 + t + 1 : -W / 2 + (p['ВРАТИЧКА_ФУГА_ОТЛЯВО'] ?? 0);
    const xr = sideRightFront ? W / 2 - t - 1 : W / 2 - (p['ВРАТИЧКА_ФУГА_ОТДЯСНО'] ?? 0);
    const ybNominal = -H / 2 + (p['ВРАТИЧКА_ФУГА_ОТДОЛУ'] ?? 0);
    // The usual ФУГА_ОТГОРЕ reveal, overridden to a flush inset when
    // ТАВАН_ВИДИМ_КАНТ_ОТПРЕД is set — same formula regardless of С_ТАВАН vs С_РЕБРА.
    // ГОРЕН/ДОЛЕН РЪБ ОФСЕТ then further nudges each edge on top of that.
    const yb = (dunFront ? -H / 2 + t + 1 : ybNominal) + offBotDoor;
    const yt = (tavFront ? H / 2 - t - 1 : H / 2 - (p['ВРАТИЧКА_ФУГА_ОТГОРЕ'] ?? 0)) + offTopDoor;
    const doorPvc = [b('ВРАТИЧКА_С_КАНТ_ОТДОЛУ'), true, b('ВРАТИЧКА_С_КАНТ_ОТГОРЕ'), true];
    const doorZ = D / 2 - t / 2;
    if (b('ДВОЙНА_ВРАТИЧКА')) {
      // Split into two leaves separated by a reveal (ФУГА_МЕЖДУ_ВРАТИЧКИ); the first
      // leaf takes the chosen size (ЛЯВА_ВРАТИЧКА_ШИРИНА, clamped to fit), the second
      // always takes whatever remains. Both leaves share the SAME 'ВРАТИЧКА' name (and
      // so the same ВРАТИЧКА_* material/kant lookup) — only their size differs, like two
      // schedule rows cut from the same spec.
      // ДВОЙНА_ВРАТИЧКА_С_ВЕРТИКАЛНА_ФУГА (default true) picks which way they split:
      // true → side by side, divided by a VERTICAL fugue (split along X, ЛЯВА/ДЯСНА);
      // false → stacked, divided by a HORIZONTAL fugue (split along Y, ГОРНА/ДОЛНА —
      // ЛЯВА_ВРАТИЧКА_ШИРИНА then sizes the TOP leaf, matching reading order).
      const GAP = p['ФУГА_МЕЖДУ_ВРАТИЧКИ'] ?? 3;
      if (b('ДВОЙНА_ВРАТИЧКА_С_ВЕРТИКАЛНА_ФУГА')) {
        const totalW = xr - xl;
        const leftW = Math.max(0, Math.min(p['ЛЯВА_ВРАТИЧКА_ШИРИНА'] ?? (totalW - GAP) / 2, totalW - GAP));
        const splitX = xl + leftW;
        add('ВРАТИЧКА', splitX - xl, yt - yb, 0, 0, 0, mid(xl, splitX), mid(yb, yt), doorZ, doorPvc);
        add('ВРАТИЧКА', xr - (splitX + GAP), yt - yb, 0, 0, 0, mid(splitX + GAP, xr), mid(yb, yt), doorZ, doorPvc);
      } else {
        const totalH = yt - yb;
        const topH = Math.max(0, Math.min(p['ЛЯВА_ВРАТИЧКА_ШИРИНА'] ?? (totalH - GAP) / 2, totalH - GAP));
        const splitY = yt - topH;
        add('ВРАТИЧКА', xr - xl, yt - splitY, 0, 0, 0, mid(xl, xr), mid(splitY, yt), doorZ, doorPvc);
        add('ВРАТИЧКА', xr - xl, (splitY - GAP) - yb, 0, 0, 0, mid(xl, xr), mid(yb, splitY - GAP), doorZ, doorPvc);
      }
    } else {
      add('ВРАТИЧКА', xr - xl, yt - yb, 0, 0, 0, mid(xl, xr), mid(yb, yt), doorZ, doorPvc);
    }
  }
  return panels;
}

/** Build a group of `makeMesh` panels from a KorpusPanel[] layout, tagging each one for
 *  sub-selection (TAB) and the schedule — the shared build step behind both buildKorpus
 *  and buildDrawer (any family whose geometry is just a flat list of panels). */
function buildPanelGroup(panels: KorpusPanel[], kant: number): THREE.Group {
  const group = new THREE.Group();
  for (const pan of panels) {
    const mesh = makeMesh(pan.AB, pan.BC, 90, pan.t, pan.pvc, kant);
    mesh.rotation.set(pan.rx, pan.ry, pan.rz);
    mesh.position.set(pan.px, pan.py, pan.pz);
    mesh.userData['panel'] = {
      name: pan.name, size1: Math.round(pan.AB), size2: Math.round(pan.BC),
      thickness: pan.t, pvc: pan.pvc, kant,
    };
    group.add(mesh);
  }
  return group;
}

/** Build the full КОРПУС (МОДУЛ) carcass group from params, tagging each panel for sub-selection. */
export function buildKorpus(p: Record<string, number>, withDoor: boolean): THREE.Group {
  return buildPanelGroup(korpusPanels(p, withDoor), p['КАНТ_ДЕБЕЛИНА'] ?? KORPUS_KANT);
}

/**
 * Decompose a ЧЕКМЕДЖЕ (drawer box) into its panels — the single source of the layout,
 * consumed both by buildDrawer (3D) and the schedule export, same convention as
 * korpusPanels/buildKorpus above. Always exactly six panels (no С_* toggles): ДЪНО sits
 * at the very bottom of the ВИСОЧИНА envelope; ЛЯВА/ДЯСНА СТРАНИЦА stand on it at full
 * depth; ГРЪБ and КОНСТРУКТИВНО ЧЕЛО sit BETWEEN the sides, flush with the back/front
 * faces; ЧЕЛО (the visible, fully-banded face) mounts just in front of КОНСТРУКТИВНО
 * ЧЕЛО, flush with the sides' outer width, its top/bottom edges offset from the box's
 * own top/bottom by ВРАТИЧКА_ОФСЕТ_ОТГОРЕ/ОТДОЛУ (positive ОТГОРЕ grows it upward past
 * the box top; negative ОТДОЛУ — the default — grows it downward past the box bottom;
 * same "positive moves the edge up" sign convention korpusPanels already uses for its
 * own *_РЪБ_ОФСЕТ params). Materials: see `panelMaterialGroup` below — the structural
 * panels share one pick, ЧЕЛО has its own.
 */
export function drawerPanels(p: Record<string, number>): KorpusPanel[] {
  const W = p['ШИРИНА_ЧЕКМЕДЖЕ']    ?? 400;
  const H = p['ВИСОЧИНА_ЧЕКМЕДЖЕ']  ?? 150;
  const D = p['ДЪЛБОЧИНА_ЧЕКМЕДЖЕ'] ?? 450;
  const t = p['ПЛОСКОСТ_ДЕБЕЛИНА']  ?? 16;
  const offTop = p['ВРАТИЧКА_ОФСЕТ_ОТГОРЕ'] ?? 20;
  const offBot = p['ВРАТИЧКА_ОФСЕТ_ОТДОЛУ'] ?? -20;

  const mid = (a: number, c: number) => (a + c) / 2;
  const panels: KorpusPanel[] = [];
  const add = (name: string, AB: number, BC: number, rx: number, ry: number, rz: number,
               px: number, py: number, pz: number, pvc: boolean[]) =>
    panels.push({ name, AB, BC, rx, ry, rz, px, py, pz, pvc, t });

  const innerYb = -H / 2 + t, innerYt = H / 2;   // sides/back/front rest on ДЪНО

  add('ДЪНО', W, D, -Math.PI / 2, 0, 0, 0, -(H / 2 - t / 2), 0, [false, false, false, false]);
  add('ЛЯВА СТРАНИЦА',  D, innerYt - innerYb, 0, Math.PI / 2, 0, -(W / 2 - t / 2), mid(innerYb, innerYt), 0, [false, false, false, false]);
  add('ДЯСНА СТРАНИЦА', D, innerYt - innerYb, 0, Math.PI / 2, 0,  (W / 2 - t / 2), mid(innerYb, innerYt), 0, [false, false, false, false]);

  const innerW = W - 2 * t;
  add('ГРЪБ',             innerW, innerYt - innerYb, 0, 0, 0, 0, mid(innerYb, innerYt), -(D / 2 - t / 2), [false, false, false, false]);
  add('КОНСТРУКТИВНО ЧЕЛО', innerW, innerYt - innerYb, 0, 0, 0, 0, mid(innerYb, innerYt),  (D / 2 - t / 2), [false, false, false, false]);

  const faceYt = H / 2 + offTop, faceYb = -H / 2 + offBot;
  add('ЧЕЛО', W, faceYt - faceYb, 0, 0, 0, 0, mid(faceYb, faceYt), D / 2 + t / 2, [true, true, true, true]);

  return panels;
}

/** Build the ЧЕКМЕДЖЕ group from params, tagging each panel for sub-selection. */
export function buildDrawer(p: Record<string, number>): THREE.Group {
  return buildPanelGroup(drawerPanels(p), p['КАНТ_ДЕБЕЛИНА'] ?? KORPUS_KANT);
}

/**
 * Which stored `inst.materials` key pair a panel's board/edge-band material is read
 * from — usually just the panel's own NAME (one key pair per panel, spaces→underscores,
 * the KORPUS_MATERIAL_PARAMS convention); ЧЕКМЕДЖЕ instead shares ONE pair across all
 * its structural panels (ДЪНО/СТРАНИЦИ/ГРЪБ/КОНСТРУКТИВНО ЧЕЛО, grouped as 'КОРПУС')
 * and a separate pair for the visible ЧЕЛО face — see the `drawer` family's
 * materialParams (webcad-families.ts): КОРПУС_МАТЕРИАЛ/КОРПУС_КАНТ_МАТЕРИАЛ and
 * ЧЕЛО_МАТЕРИАЛ/ЧЕЛО_КАНТ_МАТЕРИАЛ. Used everywhere a panel name is turned into a
 * materials-map key: cadColorObj/applyRenderMaterials (admin-page.component.ts) and
 * resolveMaterials (webcad-schedule.ts) — keep all three in sync with this.
 */
export function panelMaterialGroup(familyId: string, panelName: string): string {
  return familyId === 'drawer' && panelName !== 'ЧЕЛО' ? 'КОРПУС' : panelName;
}

/**
 * Which `<GROUP>_ЗАВЪРТЯН_ФЛАДЕР` toggle (see KORPUS_PARAMS, webcad-families.ts) a
 * panel's own wood-grain rotation override reads — the panel's own NAME, except ТАВАН
 * and its mutually-exclusive РЕБРО ТАВАН 1/2 ribs (see korpusPanels) share the single
 * ТАВАН_ЗАВЪРТЯН_ФЛАДЕР toggle. Used by both `panelGrainRotation` (the Render-mode
 * texture rotation, admin-page.component.ts) and the cut-list's own РАЗМЕР 1/РАЗМЕР 2
 * swap (`collectPanels`, webcad-schedule.ts) — keep both in sync with this.
 */
export function panelGrainGroup(panelName: string): string {
  return panelName.startsWith('РЕБРО ТАВАН') ? 'ТАВАН' : panelName;
}

/** The `inst.params` key a panel's own ЗАВЪРТЯН_ФЛАДЕР toggle lives under. */
export function panelGrainParamKey(panelName: string): string {
  return panelGrainGroup(panelName).replace(/ /g, '_') + '_ЗАВЪРТЯН_ФЛАДЕР';
}

/**
 * The closed footprint outline of a wall centreline `pts`, offset by `half` on each
 * side with MITRED corners (so adjacent segments share one continuous boundary, no
 * gaps/overlaps). Returns the outline as ground points (XZ): the left side forward
 * then the right side back. Uses 2D (x, z) vectors.
 */
function wallOutline(pts: WallPoint[], half: number): WallPoint[] {
  const n = pts.length;
  const P = pts.map(p => new THREE.Vector2(p.x, p.z));
  const dir: THREE.Vector2[] = [];
  const nrm: THREE.Vector2[] = [];   // left normal of each edge
  for (let i = 0; i < n - 1; i++) {
    const d = new THREE.Vector2().subVectors(P[i + 1], P[i]).normalize();
    dir.push(d);
    nrm.push(new THREE.Vector2(-d.y, d.x));
  }
  // Offset every vertex to one side (s = +1 left, −1 right); interior vertices are the
  // intersection of the two adjacent offset edge lines (the mitre joint).
  const side = (s: number): THREE.Vector2[] => {
    const out: THREE.Vector2[] = [];
    for (let i = 0; i < n; i++) {
      if (i === 0)            out.push(P[0].clone().addScaledVector(nrm[0], s * half));
      else if (i === n - 1)   out.push(P[n - 1].clone().addScaledVector(nrm[n - 2], s * half));
      else {
        const a = P[i].clone().addScaledVector(nrm[i - 1], s * half);
        const b = P[i].clone().addScaledVector(nrm[i],     s * half);
        out.push(lineIntersect(a, dir[i - 1], b, dir[i]));
      }
    }
    return out;
  };
  const left = side(1), right = side(-1);
  const outline: WallPoint[] = [];
  for (const p of left) outline.push({ x: p.x, z: p.y });
  for (let i = right.length - 1; i >= 0; i--) outline.push({ x: right[i].x, z: right[i].y });
  return outline;
}

/**
 * Build a wall polyline as ONE continuous solid: extrude the mitred footprint outline
 * (ДЕБЕЛИНА wide, centred on the centreline) vertically from the ground (y = 0) to
 * ВИСОЧИНА. `pts` are local ground vertices (XZ); the local origin is the first one.
 * Plain (untextured) material; edges are added later by addEdges and stay connected.
 */
export function buildWallPath(pts: WallPoint[], height: number, thickness: number): THREE.Object3D {
  const group = new THREE.Group();
  if (pts.length < 2) return group;
  const outline = wallOutline(pts, thickness / 2);
  if (outline.length < 3) return group;
  // Build the footprint in the shape plane as (x, −z); extrude along +Z by the height,
  // then tip it up so the extrusion axis becomes world +Y (and z maps back correctly).
  const shape = new THREE.Shape();
  shape.moveTo(outline[0].x, -outline[0].z);
  for (let i = 1; i < outline.length; i++) shape.lineTo(outline[i].x, -outline[i].z);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshPhongMaterial({
    color: COLOR_NORMAL, shininess: 30, specular: new THREE.Color(0x111111), side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

/**
 * Build a ПЛОЧА (slab) as ONE solid: extrude the filled closed polygon `pts` upward by
 * `thickness` from the ground (y = 0). `pts` are local ground vertices (XZ); the local
 * origin is the first one. Plain (untextured) material; edges added later by addEdges.
 */
export function buildSlabPath(pts: WallPoint[], thickness: number): THREE.Object3D {
  const group = new THREE.Group();
  if (pts.length < 3) return group;
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, -pts[0].z);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].z);
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  const mat = new THREE.MeshPhongMaterial({
    color: COLOR_NORMAL, shininess: 30, specular: new THREE.Color(0x111111), side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

// ── Line / SOLID (arbitrary-plane sketch → extrude) ─────────────────────────────

/**
 * Line / SOLID: a generic polyline sketch drawn on an arbitrary construction plane
 * (`PlaneDesc`), not just the ground — the generalisation of the wall/slab
 * ground-only (x, z) convention above. `WallPoint{x, z}` is reused as a generic
 * local (u, v) in-plane pair; `planeBasis`/`planePointToWorld` map that pair onto
 * world 3D via the plane's own origin/normal/uAxis (vAxis = uAxis × normal, always
 * derived here, never stored — see `PlaneDesc`'s doc comment).
 */
export function planeBasis(plane: PlaneDesc): { origin: THREE.Vector3; normal: THREE.Vector3; uAxis: THREE.Vector3; vAxis: THREE.Vector3 } {
  const origin = new THREE.Vector3(plane.origin.x, plane.origin.y, plane.origin.z);
  const normal = new THREE.Vector3(plane.normal.x, plane.normal.y, plane.normal.z).normalize();
  const uAxis = new THREE.Vector3(plane.uAxis.x, plane.uAxis.y, plane.uAxis.z).normalize();
  // v = u × normal (not normal × u) specifically so the ground plane (normal = +Y,
  // uAxis = +X) derives vAxis = +Z — matching WallPoint.z mapping directly onto world
  // +z, exactly like СТЕНА/ПЛОЧА's existing (unrotated) ground convention.
  const vAxis = new THREE.Vector3().crossVectors(uAxis, normal).normalize();
  return { origin, normal, uAxis, vAxis };
}

/** Map a local (a, b) sketch point onto world 3D via `plane`'s own (uAxis, vAxis) basis. */
export function planePointToWorld(plane: PlaneDesc, p: WallPoint): THREE.Vector3 {
  const { origin, uAxis, vAxis } = planeBasis(plane);
  return origin.clone().addScaledVector(uAxis, p.x).addScaledVector(vAxis, p.z);
}

/**
 * Defensively validate/repair a `PlaneDesc` loaded from untrusted JSON (a hand-edited
 * or corrupted save could hand the geometry builders a non-orthonormal or degenerate
 * basis, silently skewing every Line/SOLID on it) — same defensive spirit as
 * `normAnchor` (webcad-object3d.ts) for anchors. Re-normalises `normal`, then
 * re-orthogonalises `uAxis` against it (Gram-Schmidt) before re-normalising that too;
 * falls back to the ground plane (XZ, origin 0) if either vector is missing/degenerate
 * (near-zero length, or `uAxis` parallel to `normal`) rather than producing NaNs.
 */
export function normalizePlaneDesc(raw: unknown): PlaneDesc {
  const groundPlane: PlaneDesc = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, uAxis: { x: 1, y: 0, z: 0 } };
  const o = raw as Partial<PlaneDesc> | undefined;
  if (!o || typeof o !== 'object') return groundPlane;
  const vec3 = (v: unknown): THREE.Vector3 | null => {
    const p = v as Partial<{ x: number; y: number; z: number }> | undefined;
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null;
    return new THREE.Vector3(p.x, p.y, p.z);
  };
  const origin = vec3(o.origin) ?? new THREE.Vector3();
  const normal = vec3(o.normal);
  if (!normal || normal.lengthSq() < 1e-10) return { ...groundPlane, origin: { x: origin.x, y: origin.y, z: origin.z } };
  normal.normalize();
  let uAxis = vec3(o.uAxis);
  if (uAxis) uAxis.addScaledVector(normal, -uAxis.dot(normal));   // Gram-Schmidt: strip any normal component
  if (!uAxis || uAxis.lengthSq() < 1e-10) {
    // degenerate/missing uAxis — rebuild a stable one the same way the plane-picking tool does
    uAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), normal);
    if (uAxis.lengthSq() < 1e-10) uAxis = new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), normal);
  }
  uAxis.normalize();
  return {
    origin: { x: origin.x, y: origin.y, z: origin.z },
    normal: { x: normal.x, y: normal.y, z: normal.z },
    uAxis: { x: uAxis.x, y: uAxis.y, z: uAxis.z },
  };
}

/**
 * The ROTATION (never translation) from a sketch's own flat local frame (x = u,
 * y = v, z = the extrusion/normal axis) into world orientation — the arbitrary-plane
 * generalisation of wall/slab's fixed `geo.rotateX(-Math.PI / 2)` "build flat, then
 * lift" trick. Deliberately excludes `plane.origin`: geometry here is built relative
 * to LOCAL origin (0, 0, 0) — exactly like every other path-based family — and it's
 * `spawnObject`'s `obj.position.set(inst.x, inst.y, inst.z)` that places it in the
 * world, using `inst.x/y/z`, which the Line tool and `extrudeLine()` both keep equal
 * to `plane.origin` by construction. Baking `origin` in here too would double it up.
 */
function planeBasisMatrix(plane: PlaneDesc): THREE.Matrix4 {
  const { normal, uAxis, vAxis } = planeBasis(plane);
  return new THREE.Matrix4().makeBasis(uAxis, vAxis, normal);
}

/** Circumcircle through 3 local (x, z) points; `null` if they're collinear/degenerate
 *  (the standard circumcenter formula's denominator vanishes) — callers fall back to a
 *  straight line in that case rather than producing garbage. */
function circumcircle(
  a: { x: number; z: number }, b: { x: number; z: number }, c: { x: number; z: number },
): { cx: number; cz: number; radius: number } | null {
  const d = 2 * (a.x * (b.z - c.z) + b.x * (c.z - a.z) + c.x * (a.z - b.z));
  if (Math.abs(d) < 1e-9) return null;
  const aSq = a.x * a.x + a.z * a.z, bSq = b.x * b.x + b.z * b.z, cSq = c.x * c.x + c.z * c.z;
  const cx = (aSq * (b.z - c.z) + bSq * (c.z - a.z) + cSq * (a.z - b.z)) / d;
  const cz = (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d;
  return { cx, cz, radius: Math.hypot(a.x - cx, a.z - cz) };
}

/**
 * Trace `pts` as a 2D `THREE.Shape` in local (u, v). Each edge from vertex `i` to its
 * successor is either:
 * - a 3-point arc, when `pts[i].arc` is set — the circumcircle through
 *   `(pts[i], pts[i].arc, pts[i+1])`, swept whichever direction (`absarc`'s own
 *   `clockwise` flag) actually passes through `arc`'s own angle rather than the other
 *   way around the circle. Falls back to a straight line if the 3 points are
 *   degenerate (`circumcircle` returns `null`).
 * - otherwise a plain straight line, optionally rounded into a corner fillet at
 *   vertex `i` — eligible when `i` (a) is interior (`closed`, or `0 < i < n-1` for an
 *   open path) and (b) has its own `r > 0`. The fillet is a GENUINE tangent-circle
 *   arc of radius `r` (see `fillet` below) — both incident edges are trimmed back by
 *   the correct tangent length `r / tan(θ/2)` (θ = the angle between them), not a
 *   Bezier merely passing near the corner. A fillet is skipped whenever EITHER
 *   incident edge is itself an arc — trimming "back along" a curved edge isn't the
 *   straight-line tangent-trim above; not worth generalizing for how rarely a fillet
 *   would sit right next to a curved segment — or when the corner is degenerate
 *   (~0°, a cusp with no valid circle, or ~180°, already straight).
 * `closed` shapes close via `closePath()` (or the closing edge's own arc, if curved).
 */
export function filletedPolylineShape(pts: WallPoint[], closed: boolean): THREE.Shape {
  const shape = new THREE.Shape();
  const n = pts.length;
  if (n === 0) return shape;
  if (n < 2) { shape.moveTo(pts[0].x, pts[0].z); return shape; }

  const v = (i: number) => new THREE.Vector2(pts[i].x, pts[i].z);
  const isArcEdge = (i: number) => !!pts[i].arc;   // edge FROM vertex i to its successor
  const incomingIsArc = (i: number) => closed ? isArcEdge((i - 1 + n) % n) : (i > 0 && isArcEdge(i - 1));
  const outgoingIsArc = (i: number) => closed ? isArcEdge(i) : (i < n - 1 && isArcEdge(i));
  /** The true tangent-circle fillet at vertex `i`: a circle of radius `r` (or
   *  smaller, if `r` would push a tangent point past the midpoint of either
   *  incident edge — shrunk to fit while staying genuinely tangent, rather than
   *  trimming by `r` outright and losing tangency) that touches both incident edges
   *  at `start`/`end`, plus the arc's own sweep angles/direction — always the
   *  shorter (minor, < 180°) of the two possible arcs between those points, which is
   *  the one that sweeps THROUGH the original (sharp) vertex's own angle from the
   *  centre (see the sweep-direction comment inline below for why). `null` when
   *  there's nothing to round. */
  const fillet = (i: number): {
    start: THREE.Vector2; end: THREE.Vector2; cx: number; cy: number; radius: number;
    startAngle: number; endAngle: number; clockwise: boolean;
  } | null => {
    const r = pts[i].r ?? 0;
    if (r <= 0 || !(closed || (i > 0 && i < n - 1)) || incomingIsArc(i) || outgoingIsArc(i)) return null;
    const curr = v(i), prev = v((i - 1 + n) % n), next = v((i + 1) % n);
    const toPrev = prev.clone().sub(curr), toNext = next.clone().sub(curr);
    const lenPrev = toPrev.length(), lenNext = toNext.length();
    if (lenPrev < 1e-6 || lenNext < 1e-6) return null;
    const dirPrev = toPrev.normalize(), dirNext = toNext.normalize();
    const half = Math.acos(Math.max(-1, Math.min(1, dirPrev.dot(dirNext)))) / 2;
    if (half < 1e-4 || half > Math.PI / 2 - 1e-4) return null;   // ~cusp (no valid circle) or ~straight (nothing to round)
    let tanLen = r / Math.tan(half);
    let radius = r;
    const maxTanLen = Math.min(lenPrev, lenNext) * 0.5;   // don't trim past either edge's own midpoint
    if (tanLen > maxTanLen) { radius = maxTanLen * Math.tan(half); tanLen = maxTanLen; }
    const start = curr.clone().addScaledVector(dirPrev, tanLen);
    const end = curr.clone().addScaledVector(dirNext, tanLen);
    const bisector = dirPrev.clone().add(dirNext).normalize();
    const center = curr.clone().addScaledVector(bisector, radius / Math.sin(half));
    const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
    const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
    const vertexAngle = Math.atan2(curr.y - center.y, curr.x - center.x);
    const norm = (a: number) => { const t = Math.PI * 2; a %= t; return a < 0 ? a + t : a; };
    // The two tangent points subtend π − θ (< π) from the centre on the side the
    // vertex itself sits on — the vertex pokes out just past the chord between them,
    // "in front of" the short way round, not the long way round the far side of the
    // centre. So the correct (always shorter) arc is whichever of CW/CCW from start
    // to end PASSES THROUGH the vertex's own angle — confirmed by hand for both a
    // 90° and a 60° corner before trusting this generally, not just pattern-matched
    // from a single (ambiguous — 90° is its own supplement) test case.
    const vertexOnCcwArc = norm(vertexAngle - startAngle) <= norm(endAngle - startAngle);
    return { start, end, cx: center.x, cy: center.y, radius, startAngle, endAngle, clockwise: !vertexOnCcwArc };
  };
  /** Append the arc for edge `fromIdx → toIdx` if `pts[fromIdx].arc` is set and
   *  non-degenerate (pen must already be exactly at `pts[fromIdx]`'s raw position —
   *  guaranteed since `fillet` disables rounding on either side of an arc edge). */
  const arcTo = (fromIdx: number, toIdx: number): boolean => {
    const from = pts[fromIdx], to = pts[toIdx];
    if (!from.arc) return false;
    const c = circumcircle({ x: from.x, z: from.z }, from.arc, { x: to.x, z: to.z });
    if (!c) return false;
    const startAngle = Math.atan2(from.z - c.cz, from.x - c.cx);
    const endAngle = Math.atan2(to.z - c.cz, to.x - c.cx);
    const midAngle = Math.atan2(from.arc.z - c.cz, from.arc.x - c.cx);
    const norm = (a: number) => { const t = Math.PI * 2; a %= t; return a < 0 ? a + t : a; };
    const midOnCcwArc = norm(midAngle - startAngle) <= norm(endAngle - startAngle);
    shape.absarc(c.cx, c.cz, c.radius, startAngle, endAngle, !midOnCcwArc);
    return true;
  };

  const f0 = fillet(0);
  const startPt = f0 ? f0.start : v(0);
  shape.moveTo(startPt.x, startPt.y);
  if (f0) shape.absarc(f0.cx, f0.cy, f0.radius, f0.startAngle, f0.endAngle, f0.clockwise);   // vertex 0's own fillet (closed only)
  for (let i = 1; i < n; i++) {
    if (arcTo(i - 1, i)) continue;
    const f = fillet(i);
    if (f) { shape.lineTo(f.start.x, f.start.y); shape.absarc(f.cx, f.cy, f.radius, f.startAngle, f.endAngle, f.clockwise); }
    else { const p = v(i); shape.lineTo(p.x, p.y); }
  }
  if (closed && !arcTo(n - 1, 0)) shape.closePath();   // straight edge from the last point back to startPt
  return shape;
}

/** A closed regular polygon of `segments` points approximating a circle of `radius`,
 *  centred at local (0,0) — for the Line tool's Circle sub-tool: a circle is stored the
 *  same way any other Line is (a closed WallPoint[] path on a PlaneDesc), just with its
 *  plane's origin re-based onto the circle's own centre instead of a drawn vertex, so
 *  every other feature a closed Line already supports (Extrude, Mirror, the schedule…)
 *  works on it with zero extra code — it's just a Line with a lot of vertices.
 *
 *  When `segments` is omitted it scales with `radius` (one facet roughly every 15mm of
 *  circumference, clamped to [48, 180]) instead of a flat 48 — every one of a Line's
 *  edges is rendered as a genuine straight `THREE.LineCurve` (never resampled finer by
 *  `buildLinePath`'s `shape.getPoints()`, since Three.js forces a straight curve's own
 *  resolution to exactly 2 points regardless of the divisions argument passed in), so a
 *  flat facet count made a large circle visibly polygonal — more facets for a bigger
 *  radius keeps the facet SIZE roughly constant instead. */
export function circlePoints(radius: number, segments?: number): WallPoint[] {
  const n = segments ?? Math.min(180, Math.max(48, Math.round((2 * Math.PI * radius) / 15)));
  const pts: WallPoint[] = [];
  for (let i = 0; i < n; i++) {
    const theta = (i / n) * Math.PI * 2;
    pts.push({ x: Math.round(radius * Math.cos(theta)), z: Math.round(radius * Math.sin(theta)) });
  }
  return pts;
}

/** Invisible radius (mm) of the pick-target tube behind a Line's true line — this app
 *  selects by mesh-face raycasting (`pickInstance`), so a true zero-thickness
 *  `THREE.Line` isn't directly clickable; a generously-sized but fully invisible tube
 *  underneath it keeps clicking comfortable without affecting how the Line looks. */
const LINE_PICK_RADIUS = 10;

/**
 * A Line's own visible/clickable representation. Deliberately a genuine
 * `THREE.LineSegments` (zero-width, screen-constant, EDGE_NORMAL-coloured) for what
 * you SEE — the exact same visual language as every other family's own
 * `addEdges()`-built wireframe, not a shaded 3D tube (a prior, thicker, Phong-shaded
 * tube version looked exactly like an already-extruded round pipe and was reported as
 * looking like Extrude/Path-extrusion had already run on their own, which they never
 * do — those only ever run from their own toolbar buttons). Tagging it `isEdge` also
 * means it's picked up automatically, with zero other changes, by this app's existing
 * snap system (`collectSnapCandidates`, admin-page.component.ts) — so a Line's own
 * vertices become snappable endpoints/midpoints for whatever's drawn next, exactly
 * like every other family's edges already are — and by the existing hover/selection
 * edge-colour cycle (`setEdgeColor`/`EDGE_SELECTED`/`EDGE_HOVER`), so a Line
 * highlights on hover/select exactly like everything else too; its own idle colour is
 * `LINE_IDLE_COLOR`, not `EDGE_NORMAL` — see that constant's own doc comment for why.
 *
 * A separate, fully invisible tube (never rendered: `visible: false`) rides along the
 * same path purely so the Line stays comfortably clickable — this app's raycasting
 * (`pickInstance`) is mesh-face based and doesn't see `THREE.Line`/`LineSegments` at
 * all, so without it a true zero-width line couldn't be selected by clicking on it.
 */
export function buildLinePath(pts: WallPoint[], closed: boolean, plane: PlaneDesc): THREE.Object3D {
  const group = new THREE.Group();
  if (pts.length < 2) return group;
  const shape = filletedPolylineShape(pts, closed);
  const samples2D = shape.getPoints(Math.max(16, pts.length * 8));
  if (samples2D.length < 2) return group;
  const basis = planeBasisMatrix(plane);
  const samples3D = samples2D.map(p => new THREE.Vector3(p.x, p.y, 0).applyMatrix4(basis));
  const segCount = closed ? samples3D.length : samples3D.length - 1;

  // The true line: paired-vertex positions, (0,1), (2,3), … — exactly the layout
  // `collectSnapCandidates` already expects from every other isEdge LineSegments.
  const linePositions: number[] = [];
  for (let i = 0; i < segCount; i++) {
    const a = samples3D[i], b = samples3D[(i + 1) % samples3D.length];
    linePositions.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
  const lineSegs = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: LINE_IDLE_COLOR }));
  lineSegs.userData['isEdge'] = true;
  lineSegs.userData['isLineWire'] = true;
  group.add(lineSegs);

  // The invisible click target. Deliberately NOT CatmullRomCurve3 here either (same
  // overshoot risk already documented and fixed once for this exact construction) —
  // straight LineCurve3 segments through the exact sample points instead.
  const curve = new THREE.CurvePath<THREE.Vector3>();
  for (let i = 0; i < segCount; i++) curve.add(new THREE.LineCurve3(samples3D[i], samples3D[(i + 1) % samples3D.length]));
  const pickGeo = new THREE.TubeGeometry(curve, segCount, LINE_PICK_RADIUS, 6, false);
  const pickMesh = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ visible: false }));
  pickMesh.userData['isLinePickTarget'] = true;
  group.add(pickMesh);

  return group;
}

/**
 * `planeBasisMatrix`'s (uAxis, vAxis, normal) basis is a REFLECTION (determinant −1,
 * since vAxis = uAxis × normal rather than normal × uAxis — see `planeBasis`'s own
 * comment) — harmless for `buildLinePath` (pure point positions, no winding concept),
 * but it silently inverts every face's winding/normal for real solid geometry, which
 * is fatal for CSG: three-bvh-csg's boolean ops rely on consistent outward winding, so
 * an inside-out cutter brush doesn't throw — it just produces a wrong, hole-less
 * result (confirmed live: IsVoid cuts silently no-op'd without this fix). Reversing
 * each triangle's vertex order AFTER the matrix is applied fixes the winding without
 * moving any vertex — `planeBasisMatrix` itself must stay untouched, since
 * `buildLinePath`/`planePointToWorld` depend on its exact (reflective) mapping for
 * position consistency with snapping.
 */
function reverseWinding(geo: THREE.BufferGeometry): void {
  if (geo.index) {
    const arr = geo.index.array as Uint16Array | Uint32Array;
    for (let i = 0; i < arr.length; i += 3) { const tmp = arr[i + 1]; arr[i + 1] = arr[i + 2]; arr[i + 2] = tmp; }
    geo.index.needsUpdate = true;
  } else {
    const count = geo.attributes['position'].count;
    const idx: number[] = [];
    for (let i = 0; i < count; i += 3) idx.push(i, i + 2, i + 1);
    geo.setIndex(idx);
  }
  geo.computeVertexNormals();
}

/**
 * Extrude a CLOSED, filleted Line into a solid: the standard one-sided CAD
 * convention (from the plane, `depth` mm along its own +normal) — not the old
 * (reverted) VOID family's symmetric ±depth/2, which existed only because a cutter
 * specifically needs to guarantee passing through its target regardless of
 * thickness; irrelevant here, Phase 1 has no cutting.
 */
export function buildSolidExtrude(pts: WallPoint[], depth: number, plane: PlaneDesc): THREE.Object3D {
  const group = new THREE.Group();
  if (pts.length < 3) return group;
  const shape = filletedPolylineShape(pts, true);
  // ExtrudeGeometry's own cap/side winding is NOT symmetric under a negative depth —
  // it's a genuinely different (mirrored) construction, not just "the same shape the
  // other way" (confirmed live: a negative-depth void, as IsVoid produces when a Line
  // is drawn facing the solid's -normal side, silently failed to cut while positive
  // depth worked). Always extrude a POSITIVE depth and, for a negative request,
  // translate the result to the other side instead — keeps ExtrudeGeometry's winding
  // behaviour uniform so the single `reverseWinding` below (compensating
  // `planeBasisMatrix`'s reflection — see its own doc comment) is correct for both.
  const absDepth = Math.abs(depth);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: absDepth, bevelEnabled: false });
  if (depth < 0) geo.translate(0, 0, depth);
  geo.applyMatrix4(planeBasisMatrix(plane));
  reverseWinding(geo);
  const mat = new THREE.MeshPhongMaterial({
    color: COLOR_NORMAL, shininess: 30, specular: new THREE.Color(0x111111), side: THREE.DoubleSide,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = mesh.receiveShadow = true;
  group.add(mesh);
  return group;
}

const WORLD_UP = new THREE.Vector3(0, 1, 0);
const FALLBACK_UP = new THREE.Vector3(0, 0, 1);

/**
 * The rotation that takes local +Z to world `dir`, with local Y (the profile's own
 * "v") as close to world up as it can be — degrades gracefully to a world +Z
 * reference only when `dir` IS world up/down (a perfectly vertical path segment).
 */
function segmentOrientation(dir: THREE.Vector3): THREE.Quaternion {
  const zAxis = dir.clone().normalize();
  let yAxis = WORLD_UP.clone().addScaledVector(zAxis, -WORLD_UP.dot(zAxis));
  if (yAxis.lengthSq() < 1e-8) yAxis = FALLBACK_UP.clone().addScaledVector(zAxis, -FALLBACK_UP.dot(zAxis));
  yAxis.normalize();
  const xAxis = yAxis.clone().cross(zAxis).normalize();
  const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

/**
 * Path-extrusion (sweep): carry a CLOSED, filleted profile (`profilePts`, in its own
 * local (u, v) — its own plane's orientation is otherwise irrelevant here, only the
 * 2D shape matters) along a PATH (`pathPts` on `pathPlane`, open or closed). One
 * straight extruded run PER path segment, butted together at each corner (no mitre
 * cut yet — same accepted simplification as everywhere else in this file). Builds
 * relative to the path's own first point (local origin 0,0,0) — the caller places it
 * in the world via the usual `inst.x/y/z`, which must equal that first point's world
 * position (see `sweepLines` in admin-page.component.ts).
 *
 * `profileRotationDeg` spins the profile about its own bounding-box centre, around the
 * SEGMENT's own direction (`segmentOrientation`'s local Z) — never the whole solid, so
 * rotating the cross-section doesn't tilt the sweep off the path. `offsetU`/`offsetV`
 * shift that same centre along the profile's own local X/Y as `segmentOrientation`
 * defines them: X ⟂ both the path direction and (as closely as possible) world up, Y
 * as close to world up as it can be — so for an ordinary roughly-horizontal path these
 * read as "horizontal" and "vertical" exactly as a user watching the result expects.
 */
export function buildSolidSweep(
  profilePts: WallPoint[], pathPts: WallPoint[], pathPlane: PlaneDesc, pathClosed: boolean,
  profileRotationDeg = 0, offsetU = 0, offsetV = 0,
): THREE.Object3D {
  const group = new THREE.Group();
  if (profilePts.length < 3 || pathPts.length < 2) return group;
  const shape = filletedPolylineShape(profilePts, true);
  const xs = profilePts.map(p => p.x), zs = profilePts.map(p => p.z);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...zs) + Math.max(...zs)) / 2;
  const rot = profileRotationDeg * (Math.PI / 180);
  const path3D = pathPts.map(p => planePointToWorld(pathPlane, p));
  const origin = path3D[0].clone();
  const localPath = path3D.map(p => p.clone().sub(origin));
  const mat = new THREE.MeshPhongMaterial({
    color: COLOR_NORMAL, shininess: 30, specular: new THREE.Color(0x111111), side: THREE.DoubleSide,
  });
  const segCount = pathClosed ? localPath.length : localPath.length - 1;
  for (let i = 0; i < segCount; i++) {
    const a = localPath[i], b = localPath[(i + 1) % localPath.length];
    const dir = b.clone().sub(a);
    const len = dir.length();
    if (len < 1e-6) continue;
    const geo = new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: false });
    // Profile transform FIRST, in its own flat local frame (rotate about its own
    // centre, then offset) — then the per-segment orientation + placement, exactly
    // like buildSolidExtrude's "build flat, then lift" convention.
    geo.translate(-cx, -cy, 0);
    if (rot) geo.rotateZ(rot);
    geo.translate(cx + offsetU, cy + offsetV, 0);
    geo.applyMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(segmentOrientation(dir)));
    geo.translate(a.x, a.y, a.z);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// ── Light fixtures (СПОТ / ЛЕД ЛЕНТА) ───────────────────────────────────────────
//
// Real local lights for Render mode — the gap a single sampled "sun" direction
// (admin-page.component.ts's renderAccum) can't fill: specular highlights and
// falloff gradients from an actual nearby point/area source. Each fixture is a small
// cosmetic housing (visible in both CAD and Render, so it can be placed/selected like
// any other object) plus the real THREE.Light, tagged `userData['isSceneLight']` so
// admin-page.component.ts can toggle it off in CAD mode (CAD's flat MeshPhongMaterial
// tinting still RESPONDS to scene lights, unlike Render's PBR swap elsewhere, so an
// always-on fixture would visibly leak into the plain CAD view otherwise) without
// having to special-case every light family by id wherever that toggle happens.
//
// Both builders take the family's own ParamDef values directly (no new SceneInstance
// fields needed): horizontal aim reuses the instance's own existing `rotY`; a НАКЛОН
// param (degrees, 0 = straight down) tilts the beam about local X, baked into the
// light/target position here rather than a second rotation axis on the instance.

/** Approximate black-body colour temperature → sRGB (Tanner Helland's fit) — good enough
 *  for a "warm/neutral/cool white" light picker; not colourimetrically exact. */
export function kelvinToColor(kelvin: number): THREE.Color {
  const k = Math.max(1000, Math.min(12000, kelvin)) / 100;
  let r: number, g: number, b: number;
  if (k <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(k) - 161.1195681661;
    b = k <= 19 ? 0 : 138.5177312231 * Math.log(k - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(k - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(k - 60, -0.0755148492);
    b = 255;
  }
  const clamp01 = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  return new THREE.Color(clamp01(r), clamp01(g), clamp01(b));
}

/** СПОТ: a small ceiling/shelf spotlight — a THREE.SpotLight aimed via ЪГЪЛ (cone)/
 *  ЗАТИХВАНЕ (penumbra)/НАКЛОН (tilt from straight down), with an optional shadow. */
export function buildSpotLightFixture(p: Record<string, number>): THREE.Object3D {
  const group = new THREE.Group();
  const color = kelvinToColor(p['ЦВЕТНА_ТЕМПЕРАТУРА'] ?? 3000);

  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(40, 46, 50, 20),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.4 }),
  );
  group.add(housing);

  // Lens: shows the configured colour temperature at a glance, even outside Render mode.
  // emissiveIntensity scales with the light's own ИНТЕНЗИТЕТ (relative to its default) —
  // a fixed constant regardless of that param looked disconnected from it (a "dim" spot
  // still showing a full-brightness bulb face) and, at too high a fixed value, bloomed
  // into an oversized blob out of proportion to the fixture (see buildLineLightFixture's
  // own note on this, which hit the same thing harder on a thin strip).
  const lensGlow = Math.min(2, Math.max(0.15, (p['ИНТЕНЗИТЕТ'] ?? 400) / 400));
  const lens = new THREE.Mesh(
    new THREE.CircleGeometry(38, 20),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: lensGlow, roughness: 0.3 }),
  );
  lens.position.y = -25.1;
  lens.rotation.x = -Math.PI / 2;
  group.add(lens);

  const angleDeg = Math.max(1, Math.min(89, p['ЪГЪЛ'] ?? 30));
  const light = new THREE.SpotLight(
    color,
    Math.max(0, p['ИНТЕНЗИТЕТ'] ?? 400),
    Math.max(0, p['ОБХВАТ'] ?? 0),
    THREE.MathUtils.degToRad(angleDeg),
    Math.max(0, Math.min(1, p['ЗАТИХВАНЕ'] ?? 0.3)),
    1,
  );
  const tilt = THREE.MathUtils.degToRad(p['НАКЛОН'] ?? 0);
  const target = new THREE.Object3D();
  target.position.set(0, -1000 * Math.cos(tilt), 1000 * Math.sin(tilt));
  group.add(target);
  light.target = target;
  light.castShadow = (p['СЯНКА'] ?? 1) > 0;
  if (light.castShadow) {
    light.shadow.mapSize.set(1024, 1024);
    light.shadow.camera.near = 10;
    light.shadow.camera.far = (p['ОБХВАТ'] ?? 0) > 0 ? p['ОБХВАТ'] : 6000;
    light.shadow.bias = -0.0015;
  }
  light.userData['isSceneLight'] = true;
  group.add(light);
  return group;
}

/** ЛЕД ЛЕНТА: a configurable-length LED strip — a THREE.RectAreaLight (area lights have
 *  no shadow support in Three.js at all, so there's no СЯНКА toggle here — see the
 *  family's own params doc comment in webcad-families.ts). Needs
 *  RectAreaLightUniformsLib.init() called once before Render mode actually lights it
 *  correctly (admin-page.component.ts's ensureRectAreaLightLib, lazy — this builder
 *  still works/constructs fine before that, it just won't look right on screen yet). */
export function buildLineLightFixture(p: Record<string, number>): THREE.Object3D {
  const group = new THREE.Group();
  const color = kelvinToColor(p['ЦВЕТНА_ТЕМПЕРАТУРА'] ?? 4000);
  const length = Math.max(10, p['ДЪЛЖИНА'] ?? 600);
  const width = Math.max(5, p['ШИРИНА'] ?? 15);

  const housing = new THREE.Mesh(
    new THREE.BoxGeometry(length, 8, width),
    new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6, metalness: 0.3 }),
  );
  group.add(housing);

  // emissiveIntensity scales with ИНТЕНЗИТЕТ (see buildSpotLightFixture's identical
  // reasoning) — a long, thin, uniformly bright strip is exactly the shape that most
  // exposed the old fixed-1.0 constant's downstream problems: at full-res-to-quarter-
  // res bloom extraction (ensureAccum's bloomExtractQuad), a single point-sample per
  // output texel randomly hit-or-missed this strip along its length, reading as a
  // string of separate bright blobs rather than one continuous glow, with the
  // occasional lucky/unlucky sample spreading into an oversized one once blurred — see
  // that shader's own comment for the real fix (a proper box-filtered downsample);
  // this scaling just keeps the SOURCE brightness itself proportionate to what was
  // actually configured, on top of that.
  const lensGlow = Math.min(2, Math.max(0.15, (p['ИНТЕНЗИТЕТ'] ?? 1500) / 1500));
  const lens = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.max(1, length - 4), Math.max(1, width - 4)),
    new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: lensGlow, roughness: 0.4, side: THREE.DoubleSide }),
  );
  lens.rotation.x = -Math.PI / 2;
  lens.position.y = -4.01;
  group.add(lens);

  const light = new THREE.RectAreaLight(color, Math.max(0, p['ИНТЕНЗИТЕТ'] ?? 1500), length, width);
  // RectAreaLight shines along its local -Z by default — rotate -90° about X to aim it
  // straight down (НАКЛОН = 0, matching the spot light's own convention), then apply the
  // tilt on top of that base aim.
  light.rotation.x = -Math.PI / 2 + THREE.MathUtils.degToRad(p['НАКЛОН'] ?? 0);
  light.position.y = -4;
  light.userData['isSceneLight'] = true;
  group.add(light);
  return group;
}
