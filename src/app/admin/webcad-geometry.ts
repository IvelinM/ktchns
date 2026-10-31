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
  const shelfD = frontD(false), shelfZ = frontZ(false);
  for (let n = 1; n <= 10; n++) {
    if (!b(`С_ПОЛИЦА_${n}`)) continue;
    const offset = p[`ПОЛИЦА_${n}_ОФСЕТ_ОТДОЛУ`] ?? 0;
    const xl = -(W / 2 - t), xr = W / 2 - t;
    const yb = -H / 2 + offset, yt = yb + t;
    const shelfPvc = [b(`ПОЛИЦА_${n}_С_КАНТ_ОТПРЕД`), false, false, false];
    add(`ПОЛИЦА ${n}`, xr - xl, shelfD, -Math.PI / 2, 0, 0, mid(xl, xr), mid(yb, yt), shelfZ, shelfPvc);
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
  // per its ГРЪБ_С_КАНТ flag.
  if (hasBack) {
    const xl = grbL ? -W / 2 : -(W / 2 - t), xr = grbR ? W / 2 : W / 2 - t;
    const yb = grbB ? -H / 2 : -(H / 2 - t), yt = grbT ? H / 2 : H / 2 - t;
    const backPvc = [b('ГРЪБ_С_КАНТ_ОТДОЛУ'), b('ГРЪБ_С_КАНТ_ОТДЯСНО'), b('ГРЪБ_С_КАНТ_ОТГОРЕ'), b('ГРЪБ_С_КАНТ_ОТЛЯВО')];
    add('ГРЪБ', xr - xl, yt - yb, 0, 0, 0, mid(xl, xr), mid(yb, yt), -(D / 2 - backT / 2), backPvc, backT);
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
      // Split into two leaves separated by a small fixed reveal; ЛЯВА takes the chosen
      // width (clamped to fit), ДЯСНА always takes whatever remains. Both leaves share
      // the SAME 'ВРАТИЧКА' name (and so the same ВРАТИЧКА_* material/kant lookup) —
      // only their size differs, like two schedule rows cut from the same spec.
      const GAP = 2;
      const totalW = xr - xl;
      const leftW = Math.max(0, Math.min(p['ЛЯВА_ВРАТИЧКА_ШИРИНА'] ?? (totalW - GAP) / 2, totalW - GAP));
      const splitX = xl + leftW;
      add('ВРАТИЧКА', splitX - xl, yt - yb, 0, 0, 0, mid(xl, splitX), mid(yb, yt), doorZ, doorPvc);
      add('ВРАТИЧКА', xr - (splitX + GAP), yt - yb, 0, 0, 0, mid(splitX + GAP, xr), mid(yb, yt), doorZ, doorPvc);
    } else {
      add('ВРАТИЧКА', xr - xl, yt - yb, 0, 0, 0, mid(xl, xr), mid(yb, yt), doorZ, doorPvc);
    }
  }
  return panels;
}

/** Build the full КОРПУС (МОДУЛ) carcass group from params, tagging each panel for sub-selection. */
export function buildKorpus(p: Record<string, number>, withDoor: boolean): THREE.Group {
  const kant = p['КАНТ_ДЕБЕЛИНА'] ?? KORPUS_KANT;
  const group = new THREE.Group();
  for (const pan of korpusPanels(p, withDoor)) {
    const mesh = makeMesh(pan.AB, pan.BC, 90, pan.t, pan.pvc, kant);
    mesh.rotation.set(pan.rx, pan.ry, pan.rz);
    mesh.position.set(pan.px, pan.py, pan.pz);
    // Tag the panel node so it can be sub-selected (TAB) and shown read-only.
    mesh.userData['panel'] = {
      name: pan.name, size1: Math.round(pan.AB), size2: Math.round(pan.BC),
      thickness: pan.t, pvc: pan.pvc, kant,
    };
    group.add(mesh);
  }
  return group;
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

/**
 * Trace `pts` as a 2D `THREE.Shape` in local (u, v), rounding every corner that both
 * (a) is eligible — every vertex if `closed`, else only the interior vertices
 * (1..n-2), never the two open endpoints — and (b) has its own `r > 0`. Each eligible
 * corner is trimmed back along both incident edges by `d = min(r, len/2, len/2)` of
 * those edges — this clamp is mandatory, an un-clamped radius on a short edge
 * produces self-overlapping curve geometry — and rounded with a `quadraticCurveTo`
 * through the untrimmed vertex (a visual approximation of a true tangent-circle
 * fillet, not a mathematically exact one — plenty close for a modelling tool, same
 * spirit as every other simplification in this file). Non-filleted vertices get a
 * plain `lineTo`. `closed` shapes are explicitly closed via `closePath()`.
 */
export function filletedPolylineShape(pts: WallPoint[], closed: boolean): THREE.Shape {
  const shape = new THREE.Shape();
  const n = pts.length;
  if (n === 0) return shape;
  if (n < 3) {
    shape.moveTo(pts[0].x, pts[0].z);
    for (let i = 1; i < n; i++) shape.lineTo(pts[i].x, pts[i].z);
    if (closed && n >= 2) shape.closePath();
    return shape;
  }

  const v = (i: number) => new THREE.Vector2(pts[i].x, pts[i].z);
  const trim = (i: number): { start: THREE.Vector2; end: THREE.Vector2 } | null => {
    const r = pts[i].r ?? 0;
    if (r <= 0 || !(closed || (i > 0 && i < n - 1))) return null;
    const curr = v(i), prev = v((i - 1 + n) % n), next = v((i + 1) % n);
    const toPrev = prev.clone().sub(curr), toNext = next.clone().sub(curr);
    const d = Math.min(r, toPrev.length() * 0.5, toNext.length() * 0.5);
    return {
      start: curr.clone().addScaledVector(toPrev.normalize(), d),
      end: curr.clone().addScaledVector(toNext.normalize(), d),
    };
  };

  const t0 = trim(0);
  const startPt = t0 ? t0.start : v(0);
  shape.moveTo(startPt.x, startPt.y);
  if (t0) shape.quadraticCurveTo(pts[0].x, pts[0].z, t0.end.x, t0.end.y);   // vertex 0's own fillet (closed only)
  for (let i = 1; i < n; i++) {
    const t = trim(i);
    if (t) { shape.lineTo(t.start.x, t.start.y); shape.quadraticCurveTo(pts[i].x, pts[i].z, t.end.x, t.end.y); }
    else { const p = v(i); shape.lineTo(p.x, p.y); }
  }
  if (closed) shape.closePath();   // straight edge from the last point back to startPt
  return shape;
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
