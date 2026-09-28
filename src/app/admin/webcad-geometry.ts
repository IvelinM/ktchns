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
import { COLOR_NORMAL } from './webcad.model';
import type { WallPoint } from './webcad.model';

// Enable Three.js asset cache so the same URL is only fetched once even when each
// material loads the texture independently.
THREE.Cache.enabled = true;

const CHIPBOARD_URL = 'assets/images/3D/chipboard-texture.jpg';

/** PVC band thickness (mm) used on КОРПУС door edges (matches makeMesh's default). */
export const KORPUS_KANT = 1;

/** Fixed depth (mm) of each РЕБРО ТАВАН panel in the КОРПУС С РЕБРА family. */
export const REBRO_TAVAN_D = 100;

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
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
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
 * Decompose a КОРПУС into its panels. This is the single source of the carcass
 * layout, consumed both by buildKorpus (to build the 3D group) and by the
 * schedule export (to list every panel).
 *
 * `С_*` toggles include/omit a panel. `*_ВИДИМ_КАНТ_*` flags pick which panel covers
 * the other at a shared edge (true → this panel's edge runs to the outer face and
 * covers its neighbour; false → it is inset by one thickness so the neighbour covers
 * it). A top/bottom flag also shortens the matching side panel to sit under it.
 */
export function korpusPanels(p: Record<string, number>, withDoor: boolean): KorpusPanel[] {
  const W = p['ШИРИНА']    ?? 800;
  const H = p['ВИСОЧИНА']  ?? 720;
  const D = p['ДЪЛБОЧИНА'] ?? 550;
  const t = p['ПЛОСКОСТ_ДЕБЕЛИНА'] ?? 18;
  const backT = p['ГРЪБ_ДЕБЕЛИНА'] ?? t;   // the back may have its own thickness
  const b = (k: string) => Boolean(p[k]);

  const hasBack = b('С_ГРЪБ'), hasLeft = b('С_ЛЯВА_СТРАНИЦА'), hasRight = b('С_ДЯСНА_СТРАНИЦА');
  const hasTop  = b('С_ТАВАН'), hasBottom = b('С_ДЪНО'), hasDoor = b('С_ВРАТИЧКА');

  const grbL = b('ГРЪБ_ВИДИМ_КАНТ_ОТЛЯВО'), grbR = b('ГРЪБ_ВИДИМ_КАНТ_ОТДЯСНО');
  const grbT = b('ГРЪБ_ВИДИМ_КАНТ_ОТГОРЕ'), grbB = b('ГРЪБ_ВИДИМ_КАНТ_ОТДОЛУ');
  const tavL = b('ТАВАН_ВИДИМ_КАНТ_ОТЛЯВО'), tavR = b('ТАВАН_ВИДИМ_КАНТ_ОТДЯСНО');
  const dunL = b('ДЪНО_ВИДИМ_КАНТ_ОТЛЯВО'),  dunR = b('ДЪНО_ВИДИМ_КАНТ_ОТДЯСНО');
  // Does this panel's FRONT edge extend flush with the module's true front face
  // (covering the door there), instead of stopping at the door's rear face? The door
  // then insets on that side by this panel's thickness + 1 mm gap (see below).
  const sideLeftFront = b('ЛЯВА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД');
  const sideRightFront = b('ДЯСНА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД');
  const tavFront = b('ТАВАН_ВИДИМ_КАНТ_ОТПРЕД');
  const dunFront = b('ДЪНО_ВИДИМ_КАНТ_ОТПРЕД');

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
  const innerD = D - tBack - tDoor;     // depth of sides/top/bottom
  const innerZ = (tBack - tDoor) / 2;   // their depth-centre (rear bound + front bound)/2
  // Per-panel depth override for a panel whose *_ВИДИМ_КАНТ_ОТПРЕД flag is set: its
  // front bound moves from the door's rear face (D/2 − tDoor) out to the true front
  // face (D/2); the rear bound (back panel/backT) is unaffected either way.
  const backBound = -D / 2 + tBack;
  const frontD = (extend: boolean) => (extend ? D / 2 : D / 2 - tDoor) - backBound;
  const frontZ = (extend: boolean) => mid(backBound, extend ? D / 2 : D / 2 - tDoor);
  const leftD  = frontD(sideLeftFront),  leftZ  = frontZ(sideLeftFront);
  const rightD = frontD(sideRightFront), rightZ = frontZ(sideRightFront);
  const topD   = frontD(tavFront),       topZ   = frontZ(tavFront);
  const botD   = frontD(dunFront),       botZ   = frontZ(dunFront);

  // Sides span the inner depth; their height is trimmed only where a present top /
  // bottom covers them (that side's *_ВИДИМ flag = true).
  const lTop = (hasTop && tavL) ? H / 2 - t : H / 2;
  const lBot = (hasBottom && dunL) ? -(H / 2 - t) : -H / 2;
  const rTop = (hasTop && tavR) ? H / 2 - t : H / 2;
  const rBot = (hasBottom && dunR) ? -(H / 2 - t) : -H / 2;
  // PVC banding per panel, edge order [AB, BC, CD, DA]. The world-facing direction of
  // each local edge depends on the panel's rotation:
  //   Sides  (rot about Y): AB=ОТДОЛУ, BC=back, CD=ОТГОРЕ, DA=ОТПРЕД (meets ВРАТИЧКА).
  //   Top/bot(rot about X): AB=ОТПРЕД, BC=ОТДЯСНО, CD=back, DA=ОТЛЯВО.
  //   Back   (no rotation): AB=ОТДОЛУ, BC=ОТДЯСНО, CD=ОТГОРЕ, DA=ОТЛЯВО.
  const leftPvc  = [b('ЛЯВА_СТРАНИЦА_С_КАНТ_ОТДОЛУ'),  false, b('ЛЯВА_СТРАНИЦА_С_КАНТ_ОТГОРЕ'),  b('ЛЯВА_СТРАНИЦА_С_КАНТ_ОТПРЕД')];
  const rightPvc = [b('ДЯСНА_СТРАНИЦА_С_КАНТ_ОТДОЛУ'), false, b('ДЯСНА_СТРАНИЦА_С_КАНТ_ОТГОРЕ'), b('ДЯСНА_СТРАНИЦА_С_КАНТ_ОТПРЕД')];
  if (hasLeft)  add('ЛЯВА СТРАНИЦА',  leftD,  lTop - lBot, 0, Math.PI / 2, 0, -(W / 2 - t / 2), mid(lTop, lBot), leftZ,  leftPvc);
  if (hasRight) add('ДЯСНА СТРАНИЦА', rightD, rTop - rBot, 0, Math.PI / 2, 0,  (W / 2 - t / 2), mid(rTop, rBot), rightZ, rightPvc);

  // Bottom / top: width runs to the outer face on a side whose flag = true, else inset;
  // depth is the inner depth (between back and door), or extended flush to the front
  // when that panel's own *_ВИДИМ_КАНТ_ОТПРЕД flag is set (see leftD/topD/botD above).
  if (hasBottom) {
    const xl = dunL ? -W / 2 : -(W / 2 - t), xr = dunR ? W / 2 : W / 2 - t;
    const bottomPvc = [b('ДЪНО_С_КАНТ_ОТПРЕД'), b('ДЪНО_С_КАНТ_ОТДЯСНО'), false, b('ДЪНО_С_КАНТ_ОТЛЯВО')];
    add('ДЪНО', xr - xl, botD, -Math.PI / 2, 0, 0, mid(xl, xr), -(H / 2 - t / 2), botZ, bottomPvc);
  }
  if (hasTop) {
    const xl = tavL ? -W / 2 : -(W / 2 - t), xr = tavR ? W / 2 : W / 2 - t;
    const topPvc = [b('ТАВАН_С_КАНТ_ОТПРЕД'), b('ТАВАН_С_КАНТ_ОТДЯСНО'), false, b('ТАВАН_С_КАНТ_ОТЛЯВО')];
    add('ТАВАН', xr - xl, topD, -Math.PI / 2, 0, 0, mid(xl, xr),  (H / 2 - t / 2), topZ, topPvc);
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
  // always banded, top/bottom follow their own toggles (ВРАТИЧКА ФУГА values inset the
  // door by that reveal gap (mm) on each side). No rotation, so — like ГРЪБ above —
  // AB=ОТДОЛУ, BC=ОТДЯСНО, CD=ОТГОРЕ, DA=ОТЛЯВО. When a neighbouring panel's own
  // *_ВИДИМ_КАНТ_ОТПРЕД flag extends it flush with the front face on that side, the
  // door insets from that boundary by the panel's thickness + 1 mm gap instead.
  if (withDoor && hasDoor) {
    const xl = sideLeftFront ? -W / 2 + t + 1 : -W / 2 + (p['ВРАТИЧКА_ФУГА_ОТЛЯВО'] ?? 0);
    const xr = sideRightFront ? W / 2 - t - 1 : W / 2 - (p['ВРАТИЧКА_ФУГА_ОТДЯСНО'] ?? 0);
    const yb = dunFront ? -H / 2 + t + 1 : -H / 2 + (p['ВРАТИЧКА_ФУГА_ОТДОЛУ'] ?? 0);
    const yt = tavFront ? H / 2 - t - 1 : H / 2 - (p['ВРАТИЧКА_ФУГА_ОТГОРЕ'] ?? 0);
    const doorPvc = [b('ВРАТИЧКА_С_КАНТ_ОТДОЛУ'), true, b('ВРАТИЧКА_С_КАНТ_ОТГОРЕ'), true];
    add('ВРАТИЧКА', xr - xl, yt - yb, 0, 0, 0, mid(xl, xr), mid(yb, yt), (D / 2 - t / 2), doorPvc);
  }
  return panels;
}

/** Build the full КОРПУС carcass group from params, tagging each panel for sub-selection. */
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
 * Decompose a КОРПУС С РЕБРА into its panels. Like korpusPanels but the ТАВАН is
 * replaced by two narrow ribs: РЕБРО ТАВАН 1 (front) and РЕБРО ТАВАН 2 (back), each
 * REBRO_TAVAN_D deep, spanning ШИРИНА minus the side-panel thicknesses (sides always
 * cover the ribs). The ВРАТИЧКА height is driven by ВИСОЧИНА_ВРАТИЧКА (bottom edge
 * fixed, only the top moves).
 */
export function korpusRebraPanels(p: Record<string, number>, withDoor: boolean): KorpusPanel[] {
  const W = p['ШИРИНА']    ?? 800;
  const H = p['ВИСОЧИНА']  ?? 720;
  const D = p['ДЪЛБОЧИНА'] ?? 550;
  const t = p['ПЛОСКОСТ_ДЕБЕЛИНА'] ?? 18;
  const backT = p['ГРЪБ_ДЕБЕЛИНА'] ?? t;
  const b = (k: string) => Boolean(p[k]);

  const hasBack   = b('С_ГРЪБ');
  const hasLeft   = b('С_ЛЯВА_СТРАНИЦА');
  const hasRight  = b('С_ДЯСНА_СТРАНИЦА');
  const hasTop    = b('С_ТАВАН');
  const hasBottom = b('С_ДЪНО');
  const hasDoor   = b('С_ВРАТИЧКА');

  const grbL = b('ГРЪБ_ВИДИМ_КАНТ_ОТЛЯВО'), grbR = b('ГРЪБ_ВИДИМ_КАНТ_ОТДЯСНО');
  const grbT = b('ГРЪБ_ВИДИМ_КАНТ_ОТГОРЕ'), grbB = b('ГРЪБ_ВИДИМ_КАНТ_ОТДОЛУ');
  const dunL = b('ДЪНО_ВИДИМ_КАНТ_ОТЛЯВО'),  dunR = b('ДЪНО_ВИДИМ_КАНТ_ОТДЯСНО');
  // Does this panel's FRONT edge extend flush with the module's true front face
  // (covering the door there), instead of stopping at the door's rear face? The door
  // then insets on that side by this panel's thickness + 1 mm gap (see below). For the
  // ТАВАН role this shifts РЕБРО ТАВАН 1 (the front rib) forward instead of resizing it.
  const sideLeftFront = b('ЛЯВА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД');
  const sideRightFront = b('ДЯСНА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД');
  const tavFront = b('ТАВАН_ВИДИМ_КАНТ_ОТПРЕД');
  const dunFront = b('ДЪНО_ВИДИМ_КАНТ_ОТПРЕД');

  const mid = (a: number, c: number) => (a + c) / 2;
  const panels: KorpusPanel[] = [];
  const add = (name: string, AB: number, BC: number, rx: number, ry: number, rz: number,
               px: number, py: number, pz: number,
               pvc: boolean[] = [false, false, false, false], pt: number = t) =>
    panels.push({ name, AB, BC, rx, ry, rz, px, py, pz, pvc, t: pt });

  const tBack = hasBack ? backT : 0;
  const tDoor = (withDoor && hasDoor) ? t : 0;
  const innerD = D - tBack - tDoor;
  const innerZ = (tBack - tDoor) / 2;
  // Per-panel depth override — see korpusPanels' identical comment for the full rationale.
  const backBound = -D / 2 + tBack;
  const frontD = (extend: boolean) => (extend ? D / 2 : D / 2 - tDoor) - backBound;
  const frontZ = (extend: boolean) => mid(backBound, extend ? D / 2 : D / 2 - tDoor);
  const leftD  = frontD(sideLeftFront),  leftZ  = frontZ(sideLeftFront);
  const rightD = frontD(sideRightFront), rightZ = frontZ(sideRightFront);
  const botD   = frontD(dunFront),       botZ   = frontZ(dunFront);

  // Sides run full height — ribs always sit between them, never trim them at the top.
  const lTop = H / 2;
  const lBot = (hasBottom && dunL) ? -(H / 2 - t) : -H / 2;
  const rTop = H / 2;
  const rBot = (hasBottom && dunR) ? -(H / 2 - t) : -H / 2;
  const leftPvc  = [b('ЛЯВА_СТРАНИЦА_С_КАНТ_ОТДОЛУ'),  false, b('ЛЯВА_СТРАНИЦА_С_КАНТ_ОТГОРЕ'),  b('ЛЯВА_СТРАНИЦА_С_КАНТ_ОТПРЕД')];
  const rightPvc = [b('ДЯСНА_СТРАНИЦА_С_КАНТ_ОТДОЛУ'), false, b('ДЯСНА_СТРАНИЦА_С_КАНТ_ОТГОРЕ'), b('ДЯСНА_СТРАНИЦА_С_КАНТ_ОТПРЕД')];
  if (hasLeft)  add('ЛЯВА СТРАНИЦА',  leftD,  lTop - lBot, 0, Math.PI / 2, 0, -(W / 2 - t / 2), mid(lTop, lBot), leftZ,  leftPvc);
  if (hasRight) add('ДЯСНА СТРАНИЦА', rightD, rTop - rBot, 0, Math.PI / 2, 0,  (W / 2 - t / 2), mid(rTop, rBot), rightZ, rightPvc);

  if (hasBottom) {
    const xl = dunL ? -W / 2 : -(W / 2 - t), xr = dunR ? W / 2 : W / 2 - t;
    const bottomPvc = [b('ДЪНО_С_КАНТ_ОТПРЕД'), b('ДЪНО_С_КАНТ_ОТДЯСНО'), false, b('ДЪНО_С_КАНТ_ОТЛЯВО')];
    add('ДЪНО', xr - xl, botD, -Math.PI / 2, 0, 0, mid(xl, xr), -(H / 2 - t / 2), botZ, bottomPvc);
  }

  // Two ribs at the top: width = ШИРИНА − left_t − right_t (sides always cover), depth = 100 mm.
  // After −π/2 rotation around X, the AB edge faces ОТПРЕД (toward door). Each rib PVC toggle
  // bands that interior-visible forward face.
  if (hasTop) {
    const xl = hasLeft  ? -(W / 2 - t) : -W / 2;
    const xr = hasRight ? (W / 2 - t)  :  W / 2;
    const ribW = xr - xl;
    const pyRib = H / 2 - t / 2;
    // РЕБРО ТАВАН 1 — front rib, flush with the front inner face; when ТАВАН_ВИДИМ_КАНТ_ОТПРЕД
    // is set it shifts forward flush with the true front face instead (covering the door there).
    const z1 = (tavFront ? D / 2 : D / 2 - tDoor) - REBRO_TAVAN_D / 2;
    add('РЕБРО ТАВАН 1', ribW, REBRO_TAVAN_D, -Math.PI / 2, 0, 0, mid(xl, xr), pyRib, z1,
        [b('РЕБРО_ТАВАН_1_С_КАНТ_ОТПРЕД'), false, false, false]);
    // РЕБРО ТАВАН 2 — back rib, flush with the back inner face.
    const z2 = -D / 2 + tBack + REBRO_TAVAN_D / 2;
    add('РЕБРО ТАВАН 2', ribW, REBRO_TAVAN_D, -Math.PI / 2, 0, 0, mid(xl, xr), pyRib, z2,
        [b('РЕБРО_ТАВАН_2_С_КАНТ_ОТПРЕД'), false, false, false]);
  }

  if (hasBack) {
    const xl = grbL ? -W / 2 : -(W / 2 - t), xr = grbR ? W / 2 : W / 2 - t;
    const yb = grbB ? -H / 2 : -(H / 2 - t), yt = grbT ? H / 2 : H / 2 - t;
    const backPvc = [b('ГРЪБ_С_КАНТ_ОТДОЛУ'), b('ГРЪБ_С_КАНТ_ОТДЯСНО'), b('ГРЪБ_С_КАНТ_ОТГОРЕ'), b('ГРЪБ_С_КАНТ_ОТЛЯВО')];
    add('ГРЪБ', xr - xl, yt - yb, 0, 0, 0, mid(xl, xr), mid(yb, yt), -(D / 2 - backT / 2), backPvc, backT);
  }

  // Door: ВИСОЧИНА_ВРАТИЧКА always fixes the height counting from the NOMINAL
  // (ФУГА_ОТДОЛУ) bottom edge, regardless of ТАВАН_ВИДИМ_КАНТ_ОТПРЕД/ДЪНО_ВИДИМ_КАНТ_ОТПРЕД
  // — unlike КОРПУС С ВРАТА (which has no independent height param), the door here must
  // always follow ВИСОЧИНА_ВРАТИЧКА; those flags only reposition РЕБРО ТАВАН 1 / inset
  // the bottom edge, they never touch the door's height. Left/right edges are always
  // banded, top/bottom follow their own toggles — no rotation, so AB=ОТДОЛУ, BC=ОТДЯСНО,
  // CD=ОТГОРЕ, DA=ОТЛЯВО (same convention as ГРЪБ above). ЛЯВА/ДЯСНА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД
  // still inset the door's left/right edge by that panel's thickness + 1 mm gap, same as
  // КОРПУС С ВРАТА.
  if (withDoor && hasDoor) {
    const xl = sideLeftFront ? -W / 2 + t + 1 : -W / 2 + (p['ВРАТИЧКА_ФУГА_ОТЛЯВО'] ?? 0);
    const xr = sideRightFront ? W / 2 - t - 1 : W / 2 - (p['ВРАТИЧКА_ФУГА_ОТДЯСНО'] ?? 0);
    const ybNominal = -H / 2 + (p['ВРАТИЧКА_ФУГА_ОТДОЛУ'] ?? 0);
    const yb = dunFront ? -H / 2 + t + 1 : ybNominal;
    const yt = ybNominal + (p['ВИСОЧИНА_ВРАТИЧКА'] ?? H);
    const doorPvc = [b('ВРАТИЧКА_С_КАНТ_ОТДОЛУ'), true, b('ВРАТИЧКА_С_КАНТ_ОТГОРЕ'), true];
    add('ВРАТИЧКА', xr - xl, yt - yb, 0, 0, 0, mid(xl, xr), mid(yb, yt), D / 2 - t / 2, doorPvc);
  }

  return panels;
}

/** Build the КОРПУС С РЕБРА group from params, tagging each panel for sub-selection. */
export function buildKorpusRebra(p: Record<string, number>, withDoor: boolean): THREE.Group {
  const kant = p['КАНТ_ДЕБЕЛИНА'] ?? KORPUS_KANT;
  const group = new THREE.Group();
  for (const pan of korpusRebraPanels(p, withDoor)) {
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
