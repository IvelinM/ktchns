import {
  Component, ElementRef, ViewChild, OnInit, OnDestroy, NgZone, HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParamDef {
  key: string;
  label: string;
  defaultValue: number;
  min: number;
  step: number;
  unit: string;
  type?: 'number' | 'toggle';
}

export interface FamilyDef {
  id: string;
  name: string;
  params: ParamDef[];
  buildObject(p: Record<string, number>): THREE.Object3D;
  hidden?: boolean;   // not offered in the FAMILY picker — created by a dedicated tool (e.g. СТЕНА)
}

/**
 * The base (insertion) point of an instance, as a bounding-box anchor. Each axis is
 * -1 / 0 / +1 = the min face / centre / max face of the object's local bounding box.
 * The instance's stored x/y/z is the world location of THIS point (default centre).
 */
export interface BasePoint { x: number; y: number; z: number; }

/** A ground-plane vertex of a wall polyline, in the instance's LOCAL frame (mm). */
export interface WallPoint { x: number; z: number; }

export interface SceneInstance {
  id: number;
  familyId: string;
  label: string;
  params: Record<string, number>;
  material: string;   // laminate spec for this module's chipboard, e.g. "ГЛАДКО БЯЛО КОРПУС"
  x: number;
  y: number;
  z: number;
  rotY: number;
  anchor?: BasePoint;  // which bbox point x/y/z refers to; absent ⇒ centre {0,0,0}
  path?: WallPoint[];  // СТЕНА only: the polyline (local coords, first vertex at origin)
}

/** A restorable copy of the scene's data model for the undo history. */
interface SceneSnapshot { instances: SceneInstance[]; nextId: number; }

/** Read-only info shown when a single panel of a family instance is sub-selected. */
interface PanelInfo {
  instanceId: number; name: string; material: string;
  size1: number; size2: number;          // С КАНТ — built/nominal size
  core1: number; core2: number;          // БЕЗ КАНТ — cut size (band thickness removed per banded edge)
  thickness: number; pvc: boolean[]; kant: number;
}

export type InteractionMode = 'idle' | 'placing' | 'move-from' | 'move-to' | 'measure-from' | 'measure-to' | 'match' | 'wall-from' | 'wall-to' | 'slab-from' | 'slab-to';
export type MovePlane      = 'XZ' | 'XY' | 'YZ';

// ── Colors ────────────────────────────────────────────────────────────────────

const COLOR_NORMAL   = 0xc8a87a;
const COLOR_SELECTED = 0x4a9cd4;
const EDGE_NORMAL    = 0x333333;
const EDGE_SELECTED  = 0xffffff;
const EDGE_HOVER     = 0xffaa00;   // TAB hover-cycle highlight (orange)
const EDGE_PVC       = 0x888888;   // slightly lighter edge for PVC faces

// Enable Three.js asset cache so the same URL is only fetched once even when
// each material loads the texture independently.
THREE.Cache.enabled = true;

const CHIPBOARD_URL = 'assets/images/3D/chipboard-texture.jpg';

// ── Geometry helpers ──────────────────────────────────────────────────────────

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
function makeMesh(
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

/**
 * A КОРПУС carcass: left/right sides, bottom (ДЪНО), top (ТАВАН) and (optionally) a
 * back (ГРЪБ), with an optional front door (ВРАТА). Shared by the КОРПУС and
 * КОРПУС С ВРАТА families.
 *
 * `БЕЗ_*` toggles omit a panel entirely.
 *
 * `*_ВИДИМ_КАНТ_*` flags pick which panel covers the other at a shared edge ("which
 * banded edge is visible"). For each side of the back / top / bottom: true → that
 * panel's edge runs to the outer face and *covers* the neighbouring side panel
 * (its own edge stays visible); false → it is inset by one thickness so the side
 * panel covers it instead. A top/bottom flag also controls the matching side
 * panel's height: when the top/bottom covers the side, the side is shortened to
 * sit under it; otherwise the side runs full height and covers the top/bottom.
 */
/** One chipboard panel of a КОРПУС: part name, cut size (AB×BC), placement, per-side PVC. */
interface KorpusPanel {
  name: string;     // role, e.g. ТАВАН / ДЪНО / ЛЯВА СТРАНИЦА …
  AB: number; BC: number;
  rx: number; ry: number; rz: number;
  px: number; py: number; pz: number;
  pvc: boolean[];   // [AB, BC, CD, DA]
  t: number;        // this panel's thickness (mm) — the back may differ (ГРЪБ ДЕБЕЛИНА)
}

/** PVC band thickness (mm) used on КОРПУС door edges (matches makeMesh's default). */
const KORPUS_KANT = 1;

/**
 * Decompose a КОРПУС into its panels. This is the single source of the carcass
 * layout, consumed both by buildKorpus (to build the 3D group) and by the
 * schedule export (to list every panel).
 */
function korpusPanels(p: Record<string, number>, withDoor: boolean): KorpusPanel[] {
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
  if (hasLeft)  add('ЛЯВА СТРАНИЦА',  innerD, lTop - lBot, 0, Math.PI / 2, 0, -(W / 2 - t / 2), mid(lTop, lBot), innerZ, leftPvc);
  if (hasRight) add('ДЯСНА СТРАНИЦА', innerD, rTop - rBot, 0, Math.PI / 2, 0,  (W / 2 - t / 2), mid(rTop, rBot), innerZ, rightPvc);

  // Bottom / top: width runs to the outer face on a side whose flag = true, else inset;
  // depth is the inner depth (between back and door).
  if (hasBottom) {
    const xl = dunL ? -W / 2 : -(W / 2 - t), xr = dunR ? W / 2 : W / 2 - t;
    const bottomPvc = [b('ДЪНО_С_КАНТ_ОТПРЕД'), b('ДЪНО_С_КАНТ_ОТДЯСНО'), false, b('ДЪНО_С_КАНТ_ОТЛЯВО')];
    add('ДЪНО', xr - xl, innerD, -Math.PI / 2, 0, 0, mid(xl, xr), -(H / 2 - t / 2), innerZ, bottomPvc);
  }
  if (hasTop) {
    const xl = tavL ? -W / 2 : -(W / 2 - t), xr = tavR ? W / 2 : W / 2 - t;
    const topPvc = [b('ТАВАН_С_КАНТ_ОТПРЕД'), b('ТАВАН_С_КАНТ_ОТДЯСНО'), false, b('ТАВАН_С_КАНТ_ОТЛЯВО')];
    add('ТАВАН', xr - xl, innerD, -Math.PI / 2, 0, 0, mid(xl, xr),  (H / 2 - t / 2), innerZ, topPvc);
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

  // Front door occupies the front thickness of the envelope; all four edges PVC-banded.
  // ВРАТИЧКА ФУГА values inset the door by that reveal gap (mm) on each side.
  if (withDoor && hasDoor) {
    const xl = -W / 2 + (p['ВРАТИЧКА_ФУГА_ОТЛЯВО'] ?? 0);
    const xr =  W / 2 - (p['ВРАТИЧКА_ФУГА_ОТДЯСНО'] ?? 0);
    const yb = -H / 2 + (p['ВРАТИЧКА_ФУГА_ОТДОЛУ'] ?? 0);
    const yt =  H / 2 - (p['ВРАТИЧКА_ФУГА_ОТГОРЕ'] ?? 0);
    add('ВРАТИЧКА', xr - xl, yt - yb, 0, 0, 0, mid(xl, xr), mid(yb, yt), (D / 2 - t / 2), [true, true, true, true]);
  }
  return panels;
}

function buildKorpus(p: Record<string, number>, withDoor: boolean): THREE.Group {
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

/** Shared parameter list for the КОРПУС and КОРПУС С ВРАТА families. */
const KORPUS_PARAMS: ParamDef[] = [
  { key: 'ШИРИНА',             label: 'ШИРИНА',             defaultValue: 800, min: 37, step: 1, unit: 'mm' },
  { key: 'ВИСОЧИНА',           label: 'ВИСОЧИНА',           defaultValue: 720, min: 37, step: 1, unit: 'mm' },
  { key: 'ДЪЛБОЧИНА',          label: 'ДЪЛБОЧИНА',          defaultValue: 550, min: 19, step: 1, unit: 'mm' },
  { key: 'ПЛОСКОСТ_ДЕБЕЛИНА',  label: 'ПЛОСКОСТ ДЕБЕЛИНА',  defaultValue: 18,  min: 1,   step: 1,   unit: 'mm' },
  { key: 'ГРЪБ_ДЕБЕЛИНА',      label: 'ГРЪБ ДЕБЕЛИНА',      defaultValue: 18,  min: 1,   step: 1,   unit: 'mm' },
  { key: 'КАНТ_ДЕБЕЛИНА',      label: 'КАНТ ДЕБЕЛИНА',      defaultValue: 1,   min: 0.1, step: 0.1, unit: 'mm' },
  { key: 'С_ГРЪБ',           label: 'С ГРЪБ',           defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ЛЯВА_СТРАНИЦА',  label: 'С ЛЯВА СТРАНИЦА',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ДЯСНА_СТРАНИЦА', label: 'С ДЯСНА СТРАНИЦА', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ТАВАН',          label: 'С ТАВАН',          defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ДЪНО',           label: 'С ДЪНО',           defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ВРАТИЧКА',       label: 'С ВРАТИЧКА',       defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_ВИДИМ_КАНТ_ОТЛЯВО',  label: 'ГРЪБ ВИДИМ КАНТ ОТЛЯВО',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_ВИДИМ_КАНТ_ОТДЯСНО', label: 'ГРЪБ ВИДИМ КАНТ ОТДЯСНО', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_ВИДИМ_КАНТ_ОТГОРЕ',  label: 'ГРЪБ ВИДИМ КАНТ ОТГОРЕ',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_ВИДИМ_КАНТ_ОТДОЛУ',  label: 'ГРЪБ ВИДИМ КАНТ ОТДОЛУ',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_ВИДИМ_КАНТ_ОТЛЯВО',  label: 'ТАВАН ВИДИМ КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_ВИДИМ_КАНТ_ОТДЯСНО', label: 'ТАВАН ВИДИМ КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_ВИДИМ_КАНТ_ОТЛЯВО',  label: 'ДЪНО ВИДИМ КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_ВИДИМ_КАНТ_ОТДЯСНО', label: 'ДЪНО ВИДИМ КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ВРАТИЧКА_ФУГА_ОТЛЯВО',  label: 'ВРАТИЧКА ФУГА ОТЛЯВО',  defaultValue: 1, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_ФУГА_ОТДЯСНО', label: 'ВРАТИЧКА ФУГА ОТДЯСНО', defaultValue: 1, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_ФУГА_ОТГОРЕ',  label: 'ВРАТИЧКА ФУГА ОТГОРЕ',  defaultValue: 0, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_ФУГА_ОТДОЛУ',  label: 'ВРАТИЧКА ФУГА ОТДОЛУ',  defaultValue: 0, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ТАВАН_С_КАНТ_ОТПРЕД',  label: 'ТАВАН С КАНТ ОТПРЕД',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_С_КАНТ_ОТЛЯВО',  label: 'ТАВАН С КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_С_КАНТ_ОТДЯСНО', label: 'ТАВАН С КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_С_КАНТ_ОТПРЕД',   label: 'ДЪНО С КАНТ ОТПРЕД',   defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_С_КАНТ_ОТЛЯВО',   label: 'ДЪНО С КАНТ ОТЛЯВО',   defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_С_КАНТ_ОТДЯСНО',  label: 'ДЪНО С КАНТ ОТДЯСНО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_С_КАНТ_ОТПРЕД',  label: 'ЛЯВА СТРАНИЦА С КАНТ ОТПРЕД',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_С_КАНТ_ОТГОРЕ',  label: 'ЛЯВА СТРАНИЦА С КАНТ ОТГОРЕ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_С_КАНТ_ОТДОЛУ',  label: 'ЛЯВА СТРАНИЦА С КАНТ ОТДОЛУ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_С_КАНТ_ОТПРЕД', label: 'ДЯСНА СТРАНИЦА С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_С_КАНТ_ОТГОРЕ', label: 'ДЯСНА СТРАНИЦА С КАНТ ОТГОРЕ', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_С_КАНТ_ОТДОЛУ', label: 'ДЯСНА СТРАНИЦА С КАНТ ОТДОЛУ', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТГОРЕ',  label: 'ГРЪБ С КАНТ ОТГОРЕ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТДОЛУ',  label: 'ГРЪБ С КАНТ ОТДОЛУ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТЛЯВО',  label: 'ГРЪБ С КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТДЯСНО', label: 'ГРЪБ С КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
];

// ── Family registry ───────────────────────────────────────────────────────────

export const FAMILIES: FamilyDef[] = [
  // ── Ploskost ──────────────────────────────────────────────────────────────
  {
    id: 'ploskost',
    name: 'ПЛОСКОСТ',
    params: [
      { key: 'AB',           label: 'AB',             defaultValue: 600, min: 1,   step: 1,   unit: 'mm' },
      { key: 'BC',           label: 'BC',             defaultValue: 600, min: 1,   step: 1,   unit: 'mm' },
      { key: 'angle',        label: '∠ABC',           defaultValue: 90,  min: 1,   step: 1,   unit: '°'  },
      { key: 'thickness',    label: 'ДЕБЕЛИНА',       defaultValue: 18,  min: 1,   step: 1,   unit: 'mm' },
      { key: 'pvcAB',        label: 'PVC Кант AB',    defaultValue: 0,   min: 0,   step: 1,   unit: '',   type: 'toggle' },
      { key: 'pvcBC',        label: 'PVC Кант BC',    defaultValue: 0,   min: 0,   step: 1,   unit: '',   type: 'toggle' },
      { key: 'pvcCD',        label: 'PVC Кант CD',    defaultValue: 0,   min: 0,   step: 1,   unit: '',   type: 'toggle' },
      { key: 'pvcDA',        label: 'PVC Кант DA',    defaultValue: 0,   min: 0,   step: 1,   unit: '',   type: 'toggle' },
      { key: 'kantThickness', label: 'КАНТ ДЕБЕЛИНА', defaultValue: 1, min: 0.1, step: 0.1, unit: 'mm' },
    ],
    buildObject(p) {
      return makeMesh(
        p['AB'], p['BC'], p['angle'] ?? 90, p['thickness'],
        [Boolean(p['pvcAB']), Boolean(p['pvcBC']), Boolean(p['pvcCD']), Boolean(p['pvcDA'])],
        p['kantThickness'] ?? 1,
      );
    },
  },

  // ── КОРПУС С ВРАТА (carcass with a front door) ────────────────────────────────
  {
    id: 'cabinet-door',
    name: 'КОРПУС С ВРАТА',
    params: KORPUS_PARAMS,
    buildObject(p) { return buildKorpus(p, true); },
  },

  // ── СТЕНА (wall) — a vertical solid drawn as a POLYLINE on the ground. The whole
  // polyline is ONE instance: its vertices live in `inst.path` and the geometry is
  // built by buildWallPath (not buildObject). Created by the СТЕНА toolbar tool, not
  // the FAMILY picker, hence `hidden`. ВИСОЧИНА/ДЕБЕЛИНА are set on the tool.
  {
    id: 'wall',
    name: 'СТЕНА',
    hidden: true,
    params: [
      { key: 'ВИСОЧИНА', label: 'ВИСОЧИНА', defaultValue: 2600, min: 1, step: 1, unit: 'mm' },
      { key: 'ДЕБЕЛИНА', label: 'ДЕБЕЛИНА', defaultValue: 100,  min: 1, step: 1, unit: 'mm' },
    ],
    // Degenerate fallback (path-less wall): a single 1 m segment. Real walls go through
    // buildWallPath; this only fires if an instance somehow lacks a path.
    buildObject(p) { return buildWallPath([{ x: 0, z: 0 }, { x: 1000, z: 0 }], p['ВИСОЧИНА'], p['ДЕБЕЛИНА']); },
  },

  // ── ПЛОЧА (slab) — a flat solid of ДЕБЕЛИНА drawn as a CLOSED polygon on the ground.
  // The whole polygon is ONE instance: its vertices live in `inst.path` and the geometry
  // is built by buildSlabPath. Created by the ПЛОЧА toolbar tool, hence `hidden`.
  {
    id: 'slab',
    name: 'ПЛОЧА',
    hidden: true,
    params: [
      { key: 'ДЕБЕЛИНА', label: 'ДЕБЕЛИНА', defaultValue: 40, min: 1, step: 1, unit: 'mm' },
    ],
    // Degenerate fallback (path-less slab): a 600×600 square. Real slabs go through buildSlabPath.
    buildObject(p) { return buildSlabPath([{ x: 0, z: 0 }, { x: 600, z: 0 }, { x: 600, z: 600 }, { x: 0, z: 600 }], p['ДЕБЕЛИНА']); },
  },
];

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
function buildWallPath(pts: WallPoint[], height: number, thickness: number): THREE.Object3D {
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
function buildSlabPath(pts: WallPoint[], thickness: number): THREE.Object3D {
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

// ── Object3D helpers ──────────────────────────────────────────────────────────

function disposeObj(obj: THREE.Object3D) {
  obj.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const m = child.material;
      Array.isArray(m) ? m.forEach(x => x.dispose()) : (m as THREE.Material).dispose();
    }
  });
}

/** The centre {0,0,0} base point — used when an instance has no anchor set. */
const CENTRE_ANCHOR: BasePoint = { x: 0, y: 0, z: 0 };

/** Coerce an axis component from loaded JSON into a clamped -1 / 0 / +1. */
function clampAxis(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
}

/** Validate/clamp an anchor from untrusted JSON; falls back to the centre point. */
function normAnchor(a: unknown): BasePoint {
  if (!a || typeof a !== 'object') return { ...CENTRE_ANCHOR };
  const o = a as Record<string, unknown>;
  return { x: clampAxis(o['x']), y: clampAxis(o['y']), z: clampAxis(o['z']) };
}

/**
 * World-axis vector from the centre of the object's ROTATED axis-aligned bounding
 * box to the bbox point picked by `a`. The box is measured with `rotYDeg` applied,
 * so the base point is aligned to the WORLD X/Y/Z directions (not the object's local
 * axes) — e.g. a.x = −1 is always the world-min-X face regardless of rotation.
 */
function worldAnchorOffset(obj: THREE.Object3D, a: BasePoint, rotYDeg: number): THREE.Vector3 {
  const prevRot = obj.rotation.y;
  obj.rotation.y = rotYDeg * (Math.PI / 180);
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  obj.rotation.y = prevRot;
  obj.updateMatrixWorld(true);
  if (box.isEmpty()) return new THREE.Vector3();
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  return new THREE.Vector3(c.x + a.x * s.x / 2, c.y + a.y * s.y / 2, c.z + a.z * s.z / 2);
}

/**
 * Wrap a freshly-built object so its chosen (world-axis) base point lands on the
 * wrapper origin — which is where `obj.position` then places it. Because the anchor
 * is world-aligned, the geometry must be shifted by the INVERSE-rotated world offset
 * (`R⁻¹·(−worldOffset)`): once the wrapper re-applies `rotYDeg`, the world AABB point
 * picked by `anchor` sits exactly at `obj.position`. The centre anchor needs no shift.
 */
function anchorWrap(built: THREE.Object3D, anchor: BasePoint | undefined, rotYDeg: number): THREE.Object3D {
  const a = anchor ?? CENTRE_ANCHOR;
  if (a.x === 0 && a.y === 0 && a.z === 0) return built;
  const off = worldAnchorOffset(built, a, rotYDeg);
  built.position.copy(off.multiplyScalar(-1).applyEuler(new THREE.Euler(0, -rotYDeg * (Math.PI / 180), 0)));
  const wrap = new THREE.Group();
  wrap.add(built);
  return wrap;
}

function addEdges(obj: THREE.Object3D): void {
  obj.traverse(child => {
    if (child instanceof THREE.Mesh && !child.userData['isEdge']) {
      const lines = new THREE.LineSegments(
        new THREE.EdgesGeometry(child.geometry, 10),
        new THREE.LineBasicMaterial({ color: EDGE_NORMAL }),
      );
      lines.userData['isEdge'] = true;
      child.add(lines);
    }
  });
}

function colorObj(obj: THREE.Object3D, hex: number, transparent = false, opacity = 1) {
  obj.traverse(child => {
    if (child instanceof THREE.Mesh && !child.userData['isEdge']) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      (mats as THREE.MeshPhongMaterial[]).forEach(mat => {
        // Recolour only the laminate faces — never an edge band (chipboard has a
        // .map; PVC bands are tagged) so selecting/deselecting can't repaint them.
        if (!mat.map && !mat.userData['edgeBand']) mat.color.setHex(hex);
        mat.transparent = transparent;
        mat.opacity = opacity;
      });
    }
  });
}

function setEdgeColor(obj: THREE.Object3D, hex: number): void {
  obj.traverse(child => {
    if (child instanceof THREE.LineSegments && child.userData['isEdge']) {
      (child.material as THREE.LineBasicMaterial).color.setHex(hex);
    }
  });
}

function ghostify(obj: THREE.Object3D) {
  obj.traverse(child => {
    if (child instanceof THREE.Mesh && !child.userData['isEdge']) {
      const origMats = Array.isArray(child.material) ? child.material : [child.material];
      const ghostMats = (origMats as THREE.MeshPhongMaterial[]).map(m => {
        const g = m.clone(); g.color.setHex(0x4488ff); g.transparent = true; g.opacity = 0.35; return g;
      });
      child.material = ghostMats.length === 1 ? ghostMats[0] : ghostMats;
    }
  });
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-admin-page',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './admin-page.component.html',
  styleUrls: ['./admin-page.component.scss'],
})
export class AdminPageComponent implements OnInit, OnDestroy {
  @ViewChild('rendererCanvas', { static: true })
  canvasRef!: ElementRef<HTMLCanvasElement>;

  // ── UI state ───────────────────────────────────────────────────────────────
  families   = FAMILIES;
  selectedFamilyId = FAMILIES[0].id;
  currentParams: Record<string, number> = {};

  instances  = [] as SceneInstance[];
  selectedIds = new Set<number>();
  mode: InteractionMode = 'idle';
  modeLabel  = '';
  movePlane: MovePlane = 'XZ';
  isCopy  = false;  // active move-from/move-to op is a Copy
  isArray = false;  // active move-from/move-to op is an Array
  arrayCount = 3;   // number of copies the Array tool lays down
  itemize = false;  // schedule export: list every panel separately (drop БРОЙ) vs merged quantities
  fileMenuOpen = false;   // the sidebar File dropdown
  marqueeRect: { left: number; top: number; width: number; height: number } | null = null;
  // Distance editor shown next to the cursor during a move/copy/array.
  moveLabel: { x: number; y: number } | null = null;
  distanceStr = '';                 // value of the cursor distance input (mm)
  private distanceLocked = false;   // true once the user types — stop syncing it from the cursor
  private distFocusPending = false; // focus the distance input the first time it appears
  private moveDir = new THREE.Vector3();  // current in-plane direction moveFrom → cursor

  @ViewChild('distInput') private distInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('fileMenu') private fileMenuRef?: ElementRef<HTMLElement>;

  // Measurement tool: a dimension line from a start point to the cursor, with a
  // read-only distance label at its midpoint.
  measureLabel: { x: number; y: number; text: string } | null = null;
  private measureFrom = new THREE.Vector3();
  private measureLine!: THREE.Line;

  // Match tool: the source instance whose properties get applied to clicked targets.
  private matchSourceId: number | null = null;

  // СТЕНА (wall) draw tool — draws a multi-segment polyline as ONE instance.
  wallThickness = 100;        // mm, applies to the wall being drawn
  wallHeight    = 2600;       // mm
  private wallPath: THREE.Vector3[] = [];        // committed world vertices of the current polyline
  private wallInstanceId: number | null = null;  // the single instance growing as points are added

  // ПЛОЧА (slab) draw tool — draws a CLOSED polygon, finalised into ONE instance.
  slabThickness = 40;         // mm, applies to the slab being drawn
  private slabPath: THREE.Vector3[] = [];        // committed world vertices of the current polygon

  // TAB hover-cycle: highlight the hovered instance (index 0) then each sub-panel
  // under the cursor (1..N, nearest first), advancing on TAB.
  private hoverId: number | null = null;
  private hoverPanels: THREE.Object3D[] = [];
  private tabIndex = 0;

  // Sub-selection: a single panel of a family instance, shown read-only.
  selectedPanel: PanelInfo | null = null;
  private selectedPanelNode: THREE.Object3D | null = null;

  // ── Three.js ───────────────────────────────────────────────────────────────
  private scene!: THREE.Scene;
  private camera!: THREE.PerspectiveCamera;
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private animFrameId = 0;
  private resizeObserver!: ResizeObserver;
  private raycaster  = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private snapDot!: THREE.Mesh;
  private moveLine!: THREE.Line;   // 3D guide line drawn from moveFrom to the cursor during a move
  private ghost: THREE.Object3D | null = null;
  private objectMap = new Map<number, THREE.Object3D>();
  private nextId = 1;
  private moveFrom    = new THREE.Vector3();
  private moveOrigins = new Map<number, THREE.Vector3>(); // id → original world position
  private copyGhosts  = new Map<number, THREE.Object3D>(); // id → translucent preview during a Copy

  // Undo history (snapshots of the data model, most-recent last).
  private undoStack: SceneSnapshot[] = [];
  private pendingSnapshot: SceneSnapshot | null = null;   // captured at edit-start, recorded on first change
  private readonly UNDO_LIMIT = 50;

  private mouseDownAt  = { x: 0, y: 0 };
  private marqueeStart = { x: 0, y: 0 };
  private isMarqueeing = false;

  private boundClick!: (e: MouseEvent) => void;
  private boundMove!:  (e: MouseEvent) => void;
  private boundDown!:  (e: MouseEvent) => void;
  private boundUp!:    (e: MouseEvent) => void;

  constructor(private ngZone: NgZone) {}

  ngOnInit() {
    this.resetParams();
    this.ngZone.runOutsideAngular(() => this.initThree());
  }

  ngOnDestroy() {
    cancelAnimationFrame(this.animFrameId);
    this.resizeObserver?.disconnect();
    const cv = this.canvasRef.nativeElement;
    cv.removeEventListener('click',     this.boundClick);
    cv.removeEventListener('mousemove', this.boundMove);
    cv.removeEventListener('mousedown', this.boundDown);
    cv.removeEventListener('mouseup',   this.boundUp);
    this.moveLine?.geometry.dispose();
    (this.moveLine?.material as THREE.Material | undefined)?.dispose();
    this.measureLine?.geometry.dispose();
    (this.measureLine?.material as THREE.Material | undefined)?.dispose();
    this.renderer?.dispose();
    this.objectMap.forEach(o => disposeObj(o));
    this.copyGhosts.forEach(g => disposeObj(g));
  }

  toggleFileMenu() { this.fileMenuOpen = !this.fileMenuOpen; }

  /** Close the File menu when clicking anywhere outside it. */
  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent) {
    if (this.fileMenuOpen && this.fileMenuRef &&
        !this.fileMenuRef.nativeElement.contains(e.target as Node)) {
      this.fileMenuOpen = false;
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') { this.cancelMode(); this.fileMenuOpen = false; return; }

    const t = e.target as HTMLElement | null;
    const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    // Enter finishes an in-progress polyline tool (closes a slab / ends a wall run).
    if (e.key === 'Enter' && !inField &&
        (this.mode === 'slab-from' || this.mode === 'slab-to' || this.mode === 'wall-from' || this.mode === 'wall-to')) {
      e.preventDefault();
      this.cancelMode();
      return;
    }

    // Ctrl/Cmd+Z → undo (let inputs keep their own native text undo).
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      if (inField) return;
      e.preventDefault();
      this.undo();
      return;
    }

    // TAB → cycle the hover highlight (whole instance → each sub-panel under the cursor).
    if (e.key === 'Tab' && this.mode === 'idle' && this.hoverId !== null) {
      if (inField) return;
      e.preventDefault();
      this.cycleHover();
      return;
    }

    // Delete the selected object(s) with the Del key — but only while idle and
    // not while typing in one of the panel inputs.
    if ((e.key === 'Delete' || e.key === 'Del') && this.mode === 'idle' && this.selectedIds.size > 0) {
      if (inField) return;
      e.preventDefault();
      this.deleteSelected();
    }
  }

  // ── Computed getters ───────────────────────────────────────────────────────

  /** Families offered in the FAMILY dropdown (hidden ones are created by dedicated tools). */
  get pickableFamilies(): FamilyDef[] { return this.families.filter(f => !f.hidden); }

  get selectedFamily(): FamilyDef { return FAMILIES.find(f => f.id === this.selectedFamilyId)!; }

  get selectedId(): number | null { return this.selectedIds.size === 1 ? [...this.selectedIds][0] : null; }

  get selectedInstance(): SceneInstance | null {
    const id = this.selectedId;
    return id !== null ? (this.instances.find(i => i.id === id) ?? null) : null;
  }

  get selectedFamilyDef(): FamilyDef | null {
    const inst = this.selectedInstance;
    return inst ? (FAMILIES.find(f => f.id === inst.familyId) ?? null) : null;
  }

  /**
   * Live С КАНТ / БЕЗ КАНТ sizes for a selected Ploskost (null for other families).
   * A band reduces the dimension PERPENDICULAR to its edge: the AB/CD edges (which run
   * along РАЗМЕР 1) trim РАЗМЕР 2, and the BC/DA edges (along РАЗМЕР 2) trim РАЗМЕР 1.
   */
  get selectedPloskostSizes(): { size1: number; size2: number; core1: number; core2: number } | null {
    const inst = this.selectedInstance;
    if (!inst || inst.familyId !== 'ploskost') return null;
    const p = inst.params;
    const kant = p['kantThickness'] || 0;
    const ab = p['AB'] || 0, bc = p['BC'] || 0;
    return {
      size1: Math.round(ab),
      size2: Math.round(bc),
      core1: Math.round(ab - kant * ((p['pvcBC'] ? 1 : 0) + (p['pvcDA'] ? 1 : 0))),
      core2: Math.round(bc - kant * ((p['pvcAB'] ? 1 : 0) + (p['pvcCD'] ? 1 : 0))),
    };
  }

  getFamilyDef(id: string): FamilyDef { return FAMILIES.find(f => f.id === id) ?? FAMILIES[0]; }
  trackById(_: number, i: SceneInstance) { return i.id; }

  // ── Parameter grouping (collapsible sections in the panel) ───────────────────

  /** Params shown ungrouped at the top of the panel (matched by exact label). */
  private readonly UNGROUPED_PARAMS = new Set([
    'ШИРИНА', 'ВИСОЧИНА', 'ДЪЛБОЧИНА', 'ПЛОСКОСТ ДЕБЕЛИНА', 'ГРЪБ ДЕБЕЛИНА', 'КАНТ ДЕБЕЛИНА',
  ]);
  /** Remaining params fall into the first section whose prefix their label starts with. */
  private readonly PARAM_SECTIONS = [
    { title: 'С',              prefix: 'С ' },
    { title: 'ГРЪБ',           prefix: 'ГРЪБ' },
    { title: 'ТАВАН',          prefix: 'ТАВАН' },
    { title: 'ДЪНО',           prefix: 'ДЪНО' },
    { title: 'ЛЯВА СТРАНИЦА',  prefix: 'ЛЯВА СТРАНИЦА' },
    { title: 'ДЯСНА СТРАНИЦА', prefix: 'ДЯСНА СТРАНИЦА' },
    { title: 'ВРАТИЧКА',       prefix: 'ВРАТИЧКА' },
  ];
  private groupedCache = new Map<string, { top: ParamDef[]; sections: { title: string; params: ParamDef[] }[] }>();

  /**
   * Group a family's params into a flat `top` list plus collapsible `sections`.
   * Cached per family id so the returned object is reference-stable — the panel's
   * <details> open state then survives change detection.
   */
  grouped(fam: FamilyDef) {
    let g = this.groupedCache.get(fam.id);
    if (g) return g;
    const top: ParamDef[] = [];
    const byTitle = new Map<string, ParamDef[]>();
    for (const p of fam.params) {
      const sec = this.UNGROUPED_PARAMS.has(p.label)
        ? null
        : this.PARAM_SECTIONS.find(s => p.label.startsWith(s.prefix));
      if (!sec) { top.push(p); continue; }
      (byTitle.get(sec.title) ?? byTitle.set(sec.title, []).get(sec.title)!).push(p);
    }
    const sections = this.PARAM_SECTIONS
      .filter(s => byTitle.has(s.title))
      .map(s => ({ title: s.title, params: byTitle.get(s.title)! }));
    g = { top, sections };
    this.groupedCache.set(fam.id, g);
    return g;
  }

  // ── Family picker ──────────────────────────────────────────────────────────

  onFamilyChange() { this.resetParams(); }

  private resetParams() {
    this.currentParams = {};
    for (const p of this.selectedFamily.params) this.currentParams[p.key] = p.defaultValue;
  }

  // ── Placement ──────────────────────────────────────────────────────────────

  startPlacing() {
    this.cancelMode();
    this.mode = 'placing';
    this.modeLabel = 'Click viewport to place — Esc to cancel';
    const obj = this.selectedFamily.buildObject({ ...this.currentParams });
    ghostify(obj);
    this.ghost = obj;
    this.scene.add(this.ghost);
    this.controls.enabled = false;
  }

  private commitPlace(pos: THREE.Vector3) {
    this.pushHistory();
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    const id = this.nextId++;
    const inst: SceneInstance = {
      id, familyId: this.selectedFamilyId,
      label: `МОДУЛ ${id}`,
      params: { ...this.currentParams },
      material: '',
      x: pos.x, y: 0, z: pos.z, rotY: 0,
      anchor: { ...CENTRE_ANCHOR },
    };
    this.instances.push(inst);
    this.spawnObject(inst);
    this.applySelect([id]);
    this.mode = 'idle'; this.modeLabel = '';
    this.controls.enabled = true;
    this.snapDot.visible = false;
  }

  /** Build an instance's geometry — a wall from its polyline, any other family from params. */
  private buildInstanceObject(inst: SceneInstance): THREE.Object3D {
    if (inst.familyId === 'wall' && inst.path && inst.path.length >= 2) {
      return buildWallPath(inst.path, inst.params['ВИСОЧИНА'] ?? 2600, inst.params['ДЕБЕЛИНА'] ?? 100);
    }
    if (inst.familyId === 'slab' && inst.path && inst.path.length >= 3) {
      return buildSlabPath(inst.path, inst.params['ДЕБЕЛИНА'] ?? 40);
    }
    return this.getFamilyDef(inst.familyId).buildObject(inst.params);
  }

  private spawnObject(inst: SceneInstance) {
    this.backfillParams(inst);
    const built = this.buildInstanceObject(inst);
    addEdges(built);
    const obj = anchorWrap(built, inst.anchor, inst.rotY);
    obj.position.set(inst.x, inst.y, inst.z);
    obj.rotation.y = inst.rotY * (Math.PI / 180);
    this.objectMap.set(inst.id, obj);
    this.scene.add(obj);
  }

  /**
   * Fill in any params a family defines but this instance is missing (e.g. an
   * object placed before a new param was added). Returns true if anything was
   * added. Keeps the property panel's toggles in sync with the geometry so an
   * older instance still responds to newer parameters.
   */
  private backfillParams(inst: SceneInstance): boolean {
    let changed = false;
    for (const p of this.getFamilyDef(inst.familyId).params) {
      if (!(p.key in inst.params)) { inst.params[p.key] = p.defaultValue; changed = true; }
    }
    return changed;
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  applySelect(ids: number[]) {
    this.selectedIds.forEach(id => {
      const obj = this.objectMap.get(id);
      if (obj) { colorObj(obj, COLOR_NORMAL); setEdgeColor(obj, EDGE_NORMAL); }
    });
    this.selectedIds = new Set(ids);
    // Migrate any newly-selected instance whose params predate a family change,
    // rebuilding it so its geometry and the panel toggles agree.
    this.selectedIds.forEach(id => {
      const inst = this.instances.find(i => i.id === id);
      if (inst && this.backfillParams(inst) && this.objectMap.has(id)) {
        const old = this.objectMap.get(id)!;
        this.scene.remove(old); disposeObj(old); this.objectMap.delete(id);
        this.spawnObject(inst);
      }
    });
    this.selectedIds.forEach(id => {
      const obj = this.objectMap.get(id);
      if (obj) { colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED); }
    });
  }

  clickList(id: number) {
    this.cancelMode();
    this.applySelect(this.selectedIds.size === 1 && this.selectedIds.has(id) ? [] : [id]);
  }

  // ── Undo history ─────────────────────────────────────────────────────────────

  /** Deep copy of the data model (the source of truth — the 3D scene is derived). */
  private snapshot(): SceneSnapshot {
    return { instances: this.instances.map(i => ({ ...i, params: { ...i.params }, anchor: i.anchor ? { ...i.anchor } : undefined, path: i.path ? i.path.map(p => ({ ...p })) : undefined })), nextId: this.nextId };
  }

  private record(snap: SceneSnapshot) {
    this.undoStack.push(snap);
    if (this.undoStack.length > this.UNDO_LIMIT) this.undoStack.shift();
    this.pendingSnapshot = null;
  }

  /** Record the current state right before a discrete action (place/delete/move/copy). */
  private pushHistory() { this.record(this.snapshot()); }

  /** Capture state when a panel edit begins (input focus); recorded on the first change. */
  beginEdit() { this.pendingSnapshot = this.snapshot(); }

  /** Commit the edit-start snapshot to the stack once (coalesces a whole edit session). */
  commitPendingEdit() { if (this.pendingSnapshot) this.record(this.pendingSnapshot); }

  /** Rebuild the whole scene from a snapshot: dispose current objects, respawn from data. */
  private restoreScene(snap: SceneSnapshot) {
    this.cancelMode();
    this.clearSubSelection();
    this.objectMap.forEach(o => { this.scene.remove(o); disposeObj(o); });
    this.objectMap.clear();
    this.instances = snap.instances.map(i => ({ ...i, params: { ...i.params }, anchor: i.anchor ? { ...i.anchor } : undefined, path: i.path ? i.path.map(p => ({ ...p })) : undefined }));
    this.nextId = snap.nextId;
    this.instances.forEach(inst => this.spawnObject(inst));
    this.selectedIds = new Set();
    this.pendingSnapshot = null;
  }

  /** Ctrl/Cmd+Z — restore the most recent snapshot and rebuild the scene from it. */
  undo() {
    const snap = this.undoStack.pop();
    if (snap) this.restoreScene(snap);
  }

  // ── Save / Load scene (JSON) ─────────────────────────────────────────────────

  /** Download the current scene as a JSON file describing every instance and its props. */
  saveScene() {
    const doc = {
      format: 'webcad-scene',
      version: 1,
      savedAt: new Date().toISOString(),
      nextId: this.nextId,
      instances: this.instances,
    };
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scene.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Open a previously-saved scene JSON and recreate every object, coordinate and property. */
  loadScene(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const doc = JSON.parse(String(reader.result));
        const instances = Array.isArray(doc) ? doc : doc.instances;   // accept a bare array too
        if (!Array.isArray(instances)) throw new Error('no instances array');
        // Normalise + validate each instance; coerce missing fields to safe defaults.
        const clean: SceneInstance[] = instances.map((i: Partial<SceneInstance>) => ({
          id: Number(i.id),
          familyId: String(i.familyId),
          label: String(i.label ?? `МОДУЛ ${i.id}`),
          params: { ...(i.params ?? {}) },
          material: String(i.material ?? ''),
          x: Number(i.x) || 0, y: Number(i.y) || 0, z: Number(i.z) || 0,
          rotY: Number(i.rotY) || 0,
          anchor: normAnchor(i.anchor),
          path: Array.isArray(i.path)
            ? i.path.map((p: Partial<WallPoint>) => ({ x: Number(p?.x) || 0, z: Number(p?.z) || 0 }))
            : undefined,
        })).filter(i => Number.isFinite(i.id) && this.getFamilyDef(i.familyId));
        const maxId = clean.reduce((m, i) => Math.max(m, i.id), 0);
        const nextId = Number(doc.nextId) > maxId ? Number(doc.nextId) : maxId + 1;
        this.ngZone.run(() => {
          this.pushHistory();   // loading is undoable
          this.restoreScene({ instances: clean, nextId });
        });
      } catch {
        this.ngZone.run(() => alert('Invalid scene file — expected WebCAD scene JSON.'));
      }
    };
    reader.readAsText(file);
    input.value = '';   // allow re-loading the same file
  }

  // ── Property editing ───────────────────────────────────────────────────────

  updatePosition() {
    const inst = this.selectedInstance;
    if (!inst) return;
    this.commitPendingEdit();
    this.objectMap.get(inst.id)?.position.set(inst.x, inst.y, inst.z);
  }

  // ── Base point (insertion point) ─────────────────────────────────────────────
  // Base point pickers. ПЛАН (top-down) is a 3×3 grid setting the X column and Z row;
  // РАЗРЕЗ (front elevation) is a single column of three setting only the Y level
  // (X/Z come from ПЛАН). Cell→axis maps (grid row/col are 0..2):
  //   col → x = col − 1      (left/centre/right  → −1/0/+1)
  //   plan row → z = row − 1 (back/centre/front  → −1/0/+1)
  //   sect row → y = 1 − row (top/centre/bottom  → +1/0/−1)
  readonly cells = [0, 1, 2];

  /** This instance's base point, defaulting to the centre when unset. */
  anchorOf(inst: SceneInstance): BasePoint { return inst.anchor ?? CENTRE_ANCHOR; }

  planActive(row: number, col: number): boolean {
    const inst = this.selectedInstance; if (!inst) return false;
    const a = this.anchorOf(inst);
    return a.x === col - 1 && a.z === row - 1;
  }
  sectActive(row: number): boolean {
    const inst = this.selectedInstance; if (!inst) return false;
    return this.anchorOf(inst).y === 1 - row;
  }
  pickPlan(row: number, col: number) {
    const inst = this.selectedInstance; if (!inst) return;
    const a = this.anchorOf(inst);
    this.setSelectedAnchor({ x: col - 1, y: a.y, z: row - 1 });
  }
  pickSect(row: number) {
    const inst = this.selectedInstance; if (!inst) return;
    const a = this.anchorOf(inst);
    this.setSelectedAnchor({ x: a.x, y: 1 - row, z: a.z });
  }

  /**
   * Move the selected instance's base point to `next` WITHOUT moving the object:
   * x/y/z is re-expressed so it now locates the new point. Both points lie on the
   * same WORLD axis-aligned bounding box, so the shift is a pure world-axis vector
   * (no rotation): Δ = (next − cur) · worldSize / 2. The object is then rebuilt.
   */
  private setSelectedAnchor(next: BasePoint) {
    const inst = this.selectedInstance; if (!inst) return;
    const cur = this.anchorOf(inst);
    if (cur.x === next.x && cur.y === next.y && cur.z === next.z) return;
    this.pushHistory();
    const s = this.worldAabbSize(inst);
    inst.x += (next.x - cur.x) * s.x / 2;
    inst.y += (next.y - cur.y) * s.y / 2;
    inst.z += (next.z - cur.z) * s.z / 2;
    inst.anchor = { ...next };
    this.rebuildSelected();
  }

  /** Size of an instance's WORLD axis-aligned bounding box (its rotation applied). */
  private worldAabbSize(inst: SceneInstance): THREE.Vector3 {
    const probe = this.buildInstanceObject(inst);
    probe.rotation.y = inst.rotY * (Math.PI / 180);
    probe.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(probe);
    disposeObj(probe);
    return box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  }

  updateRotation() {
    const inst = this.selectedInstance;
    if (!inst) return;
    this.commitPendingEdit();
    // Magnetically snap to the cardinal angles (0/90/180/270/360) within a few degrees.
    const SNAP_DEG = 8;
    const nearest = Math.round(inst.rotY / 90) * 90;
    if (Math.abs(inst.rotY - nearest) <= SNAP_DEG) inst.rotY = nearest;
    // A world-aligned X/Z base point offset depends on rotation, so the geometry must
    // be re-baked to keep that point anchored. (A centre or pure-Y anchor is rotation-
    // invariant — just spin the existing object.)
    const a = this.anchorOf(inst);
    if (a.x !== 0 || a.z !== 0) {
      this.rebuildSelected();
    } else {
      const obj = this.objectMap.get(inst.id);
      if (obj) obj.rotation.y = inst.rotY * (Math.PI / 180);
    }
  }

  rebuildSelected() {
    const inst = this.selectedInstance;
    if (!inst) return;
    this.commitPendingEdit();
    const old = this.objectMap.get(inst.id);
    if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
    this.spawnObject(inst);
    const obj = this.objectMap.get(inst.id)!;
    colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED);
  }

  deleteSelected() {
    this.pushHistory();
    this.selectedIds.forEach(id => {
      const obj = this.objectMap.get(id);
      if (obj) { this.scene.remove(obj); disposeObj(obj); this.objectMap.delete(id); }
    });
    this.instances = this.instances.filter(i => !this.selectedIds.has(i.id));
    this.applySelect([]);
  }

  // ── Schedule export ──────────────────────────────────────────────────────────

  /**
   * Export a cut-list (schedule of quantities) as a tab-separated .txt, ready to
   * import into Excel. It lists every ploskost panel in the project — standalone
   * Ploskost objects AND each panel that composes a КОРПУС / КОРПУС С ВРАТА. The
   * ЕЛЕМЕНТ column names the source module each panel belongs to.
   *
   * Default: identical panels of the same ЕЛЕМЕНТ (same material, both sizes, all
   * four edge bands) collapse to one row, with БРОЙ as the quantity.
   * `itemize` on: every panel is listed on its own row and the БРОЙ column is
   * dropped (each row is a single piece).
   *
   * Column → edge mapping for a panel (sides AB, BC, CD, DA):
   *   РАЗМЕР 1 = AB,  its two parallel edges are AB (ОТПРЕД) and CD (ОТЗАД)
   *   РАЗМЕР 2 = BC,  its two parallel edges are BC (ОТПРЕД) and DA (ОТЗАД)
   * An edge cell holds the band thickness (mm) when banded, else blank.
   */
  exportSchedule() {
    interface Panel {
      element: string; material: string; size1: number; size2: number;
      pvc: boolean[]; kant: number;
    }
    const panels: Panel[] = [];
    // The cut (core) size is the nominal size minus the band thickness on each edge
    // PERPENDICULAR to that dimension: РАЗМЕР 1 (AB) shrinks for the BC/DA bands
    // (pvc[1], pvc[3]), РАЗМЕР 2 (BC) for the AB/CD bands (pvc[0], pvc[2]).
    const addPanel = (element: string, material: string, AB: number, BC: number, pvc: boolean[], kant: number) => {
      const r1 = kant * ((pvc[1] ? 1 : 0) + (pvc[3] ? 1 : 0));
      const r2 = kant * ((pvc[0] ? 1 : 0) + (pvc[2] ? 1 : 0));
      panels.push({ element, material, size1: Math.round(AB - r1), size2: Math.round(BC - r2), pvc, kant });
    };

    for (const inst of this.instances) {
      const material = inst.material.trim();
      if (inst.familyId === 'ploskost') {
        const p = inst.params;
        addPanel(inst.label, material, p['AB'], p['BC'],
          [!!p['pvcAB'], !!p['pvcBC'], !!p['pvcCD'], !!p['pvcDA']], p['kantThickness'] || 0);
      } else if (inst.familyId === 'cabinet-door') {
        const kant = inst.params['КАНТ_ДЕБЕЛИНА'] ?? KORPUS_KANT;
        for (const pan of korpusPanels(inst.params, true)) {
          addPanel(pan.name, material, pan.AB, pan.BC, pan.pvc, kant);
        }
      }
    }

    // Edge cells in column order: РАЗМЕР 1 ОТПРЕД/ОТЗАД (AB, CD), РАЗМЕР 2 ОТПРЕД/ОТЗАД (BC, DA).
    const band = (on: boolean, kant: number) => (on ? String(kant) : '');
    const edges = (p: Panel) =>
      [band(p.pvc[0], p.kant), band(p.pvc[2], p.kant), band(p.pvc[1], p.kant), band(p.pvc[3], p.kant)];

    const edgeHeaders = ['КАНТ РАЗМЕР 1 ОТПРЕД', 'КАНТ РАЗМЕР 1 ОТЗАД', 'КАНТ РАЗМЕР 2 ОТПРЕД', 'КАНТ РАЗМЕР 2 ОТЗАД'];
    const lines: string[] = [];

    if (this.itemize) {
      // One row per physical panel: ЕЛЕМЕНТ column present, no БРОЙ.
      lines.push(['ЕЛЕМЕНТ', 'МАТЕРИАЛ', 'РАЗМЕР 1', 'РАЗМЕР 2', ...edgeHeaders].join('\t'));
      for (const p of panels) {
        lines.push([p.element, p.material, p.size1, p.size2, ...edges(p)].join('\t'));
      }
    } else {
      // Merge identical panels across the whole project: БРОЙ column present, no ЕЛЕМЕНТ.
      lines.push(['МАТЕРИАЛ', 'РАЗМЕР 1', 'РАЗМЕР 2', 'БРОЙ', ...edgeHeaders].join('\t'));
      const rows = new Map<string, { p: Panel; count: number }>();
      for (const p of panels) {
        const key = [p.material, p.size1, p.size2, ...edges(p)].join('|');
        const ex = rows.get(key);
        if (ex) ex.count++;
        else rows.set(key, { p, count: 1 });
      }
      for (const { p, count } of rows.values()) {
        lines.push([p.material, p.size1, p.size2, count, ...edges(p)].join('\t'));
      }
    }

    // Prepend a UTF-8 BOM so Excel reads the Cyrillic headers correctly.
    const BOM = String.fromCharCode(0xFEFF);
    const blob = new Blob([BOM + lines.join('\r\n')], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'schedule.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Match tool ───────────────────────────────────────────────────────────────

  /** Available when idle with exactly one object selected (the source). */
  get canMatch(): boolean { return this.mode === 'idle' && this.selectedIds.size === 1; }

  /**
   * Enter Match mode: the single selected instance becomes the source. Every object
   * clicked afterwards takes the source's properties (params + material) if it is the
   * SAME family — you can't match a Ploskost onto a КОРПУС С ВРАТА. Placement
   * (position/rotation) is never copied. Esc finishes.
   */
  startMatch() {
    if (this.selectedIds.size !== 1) return;
    this.cancelMode();
    this.matchSourceId = [...this.selectedIds][0];
    this.applySelect([this.matchSourceId]);   // keep the source highlighted as reference
    this.mode = 'match';
    this.modeLabel = 'Click objects to copy the source properties onto — Esc to finish';
    // controls stay enabled: left-click picks targets, right-drag still orbits.
  }

  /** Apply the source's properties to the clicked target (same family only). */
  private applyMatchTo(id: number) {
    if (id === this.matchSourceId) return;
    const src = this.instances.find(i => i.id === this.matchSourceId);
    const tgt = this.instances.find(i => i.id === id);
    if (!src || !tgt || tgt.familyId !== src.familyId) return;   // different type → ignore
    this.pushHistory();
    tgt.params = { ...src.params };
    tgt.material = src.material;
    tgt.path = src.path ? src.path.map(p => ({ ...p })) : undefined;
    const old = this.objectMap.get(id);
    if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(id); }
    this.spawnObject(tgt);
  }

  // ── Measure tool ───────────────────────────────────────────────────────────

  /** Available whenever idle (no selection needed). */
  get canMeasure(): boolean { return this.mode === 'idle'; }

  /** Start the two-click measurement tool. */
  startMeasure() {
    this.cancelMode();
    this.movePlane = 'XZ';   // default construction plane for Shift-constrained measuring
    this.mode = 'measure-from';
    this.modeLabel = 'Click the first point — Esc to finish';
    this.controls.enabled = false;
  }

  /** Draw the dimension line from `measureFrom` to `to` and put the distance label at its midpoint. */
  private showMeasure(to: THREE.Vector3) {
    const attr = this.measureLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, this.measureFrom.x, this.measureFrom.y, this.measureFrom.z);
    attr.setXYZ(1, to.x, to.y, to.z);
    attr.needsUpdate = true;
    this.measureLine.visible = true;

    const dist = Math.round(this.measureFrom.distanceTo(to));
    const mid = this.measureFrom.clone().add(to).multiplyScalar(0.5);
    const canvas = this.canvasRef.nativeElement;
    const ndc = mid.project(this.camera);
    const x = ndc.x * canvas.clientWidth / 2 + canvas.clientWidth / 2;
    const y = canvas.clientHeight / 2 - ndc.y * canvas.clientHeight / 2;
    this.ngZone.run(() => { this.measureLabel = { x, y, text: `${dist} mm` }; });
  }

  private hideMeasure() {
    if (this.measureLine) this.measureLine.visible = false;
    this.measureLabel = null;
  }

  // ── СТЕНА (wall) tool ────────────────────────────────────────────────────────

  /** Available whenever idle (no selection needed). */
  get canWall(): boolean { return this.mode === 'idle'; }

  /** Start drawing a wall polyline on the ground (0x-0z) plane. */
  startWall() {
    this.cancelMode();
    this.wallPath = [];
    this.wallInstanceId = null;
    this.mode = 'wall-from';
    this.modeLabel = 'Click the wall start point — Esc to finish';
    this.controls.enabled = false;
  }

  /**
   * Shift-lock for the polyline tools: pin the point to the dominant ground axis from
   * `from`, so the segment lies in a vertical plane parallel to 0x-0y (z = from.z → runs
   * along X) or to 0z-0y (x = from.x → runs along Z). Shared by СТЕНА and ПЛОЧА.
   */
  private lockAxisXZ(to: THREE.Vector3, from: THREE.Vector3): THREE.Vector3 {
    const p = to.clone();
    if (Math.abs(p.x - from.x) >= Math.abs(p.z - from.z)) p.z = from.z;
    else p.x = from.x;
    return p;
  }

  /** Live translucent preview of the in-progress segment `from`→`to`, plus a length readout. */
  private updateWallGhost(from: THREE.Vector3, to: THREE.Vector3) {
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) { this.ngZone.run(() => { this.measureLabel = null; }); return; }
    const seg = makeMesh(len, this.wallHeight, 90, this.wallThickness, [false, false, false, false], 0.5, true);
    ghostify(seg);
    seg.rotation.y = Math.atan2(-dz, dx);
    seg.position.set((from.x + to.x) / 2, this.wallHeight / 2, (from.z + to.z) / 2);
    this.ghost = seg;
    this.scene.add(this.ghost);

    const canvas = this.canvasRef.nativeElement;
    const ndc = to.clone().project(this.camera);
    const x = ndc.x * canvas.clientWidth / 2 + canvas.clientWidth / 2;
    const y = canvas.clientHeight / 2 - ndc.y * canvas.clientHeight / 2;
    this.ngZone.run(() => { this.measureLabel = { x, y, text: `${Math.round(len)} mm` }; });
  }

  /** Append a vertex to the current polyline and create/grow the single wall instance. */
  private addWallPoint(p: THREE.Vector3) {
    this.wallPath.push(p.clone());
    if (this.wallPath.length < 2) return;
    this.pushHistory();
    const p0 = this.wallPath[0];
    const localPath: WallPoint[] = this.wallPath.map(v => ({ x: v.x - p0.x, z: v.z - p0.z }));
    if (this.wallInstanceId === null) {
      const id = this.nextId++;
      const inst: SceneInstance = {
        id, familyId: 'wall', label: `СТЕНА ${id}`,
        params: { 'ВИСОЧИНА': this.wallHeight, 'ДЕБЕЛИНА': this.wallThickness },
        material: '', path: localPath,
        x: p0.x, y: 0, z: p0.z, rotY: 0, anchor: { ...CENTRE_ANCHOR },
      };
      this.instances.push(inst);
      this.spawnObject(inst);
      this.wallInstanceId = id;
    } else {
      const inst = this.instances.find(i => i.id === this.wallInstanceId);
      if (!inst) return;
      inst.path = localPath;
      inst.params['ВИСОЧИНА'] = this.wallHeight;
      inst.params['ДЕБЕЛИНА'] = this.wallThickness;
      const old = this.objectMap.get(inst.id);
      if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
      this.spawnObject(inst);
    }
  }

  // ── ПЛОЧА (slab) tool ────────────────────────────────────────────────────────

  /** Available whenever idle (no selection needed). */
  get canSlab(): boolean { return this.mode === 'idle'; }

  /** Start drawing a slab polygon on the ground (0x-0z) plane. */
  startSlab() {
    this.cancelMode();
    this.slabPath = [];
    this.mode = 'slab-from';
    this.modeLabel = 'Click the first corner of the slab — Esc to finish';
    this.controls.enabled = false;
  }

  /** True when the cursor is within ~12 px of the polygon's first vertex (close gesture). */
  private nearFirstSlabVertex(e: MouseEvent): boolean {
    if (this.slabPath.length < 3) return false;
    const first = this.slabPath[0];
    const canvas = this.canvasRef.nativeElement;
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector3(first.x, 0, first.z).project(this.camera);
    const fx = ndc.x * canvas.clientWidth / 2 + canvas.clientWidth / 2;
    const fy = canvas.clientHeight / 2 - ndc.y * canvas.clientHeight / 2;
    return Math.hypot(fx - (e.clientX - r.left), fy - (e.clientY - r.top)) < 12;
  }

  /** Live translucent preview of the closed polygon formed by the path so far + the cursor. */
  private updateSlabGhost(cursor: THREE.Vector3) {
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    const pts: WallPoint[] = [...this.slabPath, cursor].map(p => ({ x: p.x, z: p.z }));
    if (pts.length < 3) { this.ngZone.run(() => { this.measureLabel = null; }); return; }
    const obj = buildSlabPath(pts, this.slabThickness);
    ghostify(obj);
    this.ghost = obj;
    this.scene.add(this.ghost);
    this.ngZone.run(() => { this.measureLabel = null; });
  }

  /** Append a vertex to the slab polygon (committed on click; finalised on close). */
  private addSlabPoint(p: THREE.Vector3) { this.slabPath.push(p.clone()); }

  /** Turn the committed polygon into one slab instance (≥3 vertices); returns its id or null. */
  private finalizeSlab(): number | null {
    if (this.slabPath.length < 3) return null;
    this.pushHistory();
    const p0 = this.slabPath[0];
    const localPath: WallPoint[] = this.slabPath.map(v => ({ x: v.x - p0.x, z: v.z - p0.z }));
    const id = this.nextId++;
    const inst: SceneInstance = {
      id, familyId: 'slab', label: `ПЛОЧА ${id}`,
      params: { 'ДЕБЕЛИНА': this.slabThickness },
      material: '', path: localPath,
      x: p0.x, y: 0, z: p0.z, rotY: 0, anchor: { ...CENTRE_ANCHOR },
    };
    this.instances.push(inst);
    this.spawnObject(inst);
    return id;
  }

  // ── Move / Copy / Array (two-step snap) ────────────────────────────────────

  /** Toolbar tools are available only when something is selected and nothing else is in progress. */
  get canEdit(): boolean { return this.mode === 'idle' && this.selectedIds.size > 0; }

  startMove()  { this.beginMoveOp('move'); }
  startCopy()  { this.beginMoveOp('copy'); }
  startArray() { this.beginMoveOp('array'); }

  private beginMoveOp(kind: 'move' | 'copy' | 'array') {
    if (this.selectedIds.size === 0) return;
    this.arrayCount = Math.max(1, Math.floor(Number(this.arrayCount) || 1));
    this.isCopy  = kind === 'copy';
    this.isArray = kind === 'array';
    this.movePlane = 'XZ';
    this.mode = 'move-from';
    this.modeLabel = 'Click reference point — Esc to cancel';
    this.distanceLocked = false;
    this.distanceStr = '';
    this.moveOrigins.clear();
    this.clearCopyGhosts();
    this.selectedIds.forEach(id => {
      const inst = this.instances.find(i => i.id === id);
      if (!inst) return;
      this.moveOrigins.set(id, new THREE.Vector3(inst.x, inst.y, inst.z));
      const makeGhost = (key: number) => {
        const ghost = anchorWrap(this.buildInstanceObject(inst), inst.anchor, inst.rotY);
        ghost.position.set(inst.x, inst.y, inst.z);
        ghost.rotation.y = inst.rotY * (Math.PI / 180);
        ghostify(ghost);
        ghost.visible = false;
        this.copyGhosts.set(key, ghost);
        this.scene.add(ghost);
      };
      if (this.isCopy) makeGhost(id);
      else if (this.isArray) for (let n = 1; n <= this.arrayCount; n++) makeGhost(this.arrayKey(id, n));
    });
    this.controls.enabled = false;
  }

  /** Finish a move-to: commit, reset state, leave idle. Used by both click and typed distance. */
  private finishMoveTo(pos: THREE.Vector3) {
    this.commitDisplacement(pos);
    this.isCopy = false; this.isArray = false;
    this.mode = 'idle'; this.modeLabel = '';
    this.controls.enabled = true;
    this.snapDot.visible = false;
    this.hideMoveMeasure();
    this.distanceLocked = false; this.distanceStr = '';
  }

  /** Cursor distance editor: the user typed → stop syncing the value from the cursor. */
  onDistanceTyped() { this.distanceLocked = true; }

  /** Enter in the distance input: commit the move/copy/array along the current direction. */
  commitTypedDistance() {
    if (this.mode !== 'move-to') return;
    const d = parseFloat(this.distanceStr);
    if (!isFinite(d) || d <= 0 || this.moveDir.lengthSq() < 1e-9) return;
    this.finishMoveTo(this.moveFrom.clone().addScaledVector(this.moveDir, d));
  }

  private clearCopyGhosts() {
    this.copyGhosts.forEach(g => { this.scene.remove(g); disposeObj(g); });
    this.copyGhosts.clear();
  }

  cancelMode() {
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    // Only a real Move shifts the originals (and so must restore them); Copy/Array don't.
    if (this.mode === 'move-to' && !this.isCopy && !this.isArray) {
      this.moveOrigins.forEach((origin, id) => {
        const inst = this.instances.find(i => i.id === id);
        const obj  = this.objectMap.get(id);
        if (inst && obj) { inst.x = origin.x; inst.y = origin.y; inst.z = origin.z; obj.position.copy(origin); }
      });
    }
    // Finishing a polyline tool keeps its result and selects it: walls already have a
    // live instance; a slab is finalised here from its committed polygon.
    const finishedWallId = (this.mode === 'wall-from' || this.mode === 'wall-to') ? this.wallInstanceId : null;
    const finishedSlabId = (this.mode === 'slab-from' || this.mode === 'slab-to') ? this.finalizeSlab() : null;
    this.wallPath = [];
    this.wallInstanceId = null;
    this.slabPath = [];
    this.clearCopyGhosts();
    this.clearHover();
    this.clearSubSelection();
    this.isCopy = false;
    this.isArray = false;
    this.matchSourceId = null;
    this.distanceLocked = false; this.distanceStr = '';
    this.isMarqueeing = false;
    this.marqueeRect  = null;
    this.snapDot.visible = false;
    this.hideMoveMeasure();
    this.hideMeasure();
    this.mode = 'idle'; this.modeLabel = '';
    this.controls.enabled = true;
    const finishedId = finishedWallId !== null ? finishedWallId : finishedSlabId;
    if (finishedId !== null) this.applySelect([finishedId]);
  }

  // ── Move plane helpers ─────────────────────────────────────────────────────

  /** The active construction plane (XZ/XY/YZ), passing through `anchor` (default: the move reference). */
  private getActivePlane(anchor: THREE.Vector3 = this.moveFrom): THREE.Plane {
    switch (this.movePlane) {
      case 'XZ': return new THREE.Plane(new THREE.Vector3(0, 1, 0),  -anchor.y);
      case 'XY': return new THREE.Plane(new THREE.Vector3(0, 0, 1),  -anchor.z);
      case 'YZ': return new THREE.Plane(new THREE.Vector3(1, 0, 0),  -anchor.x);
    }
  }

  /**
   * Shift-lock: constrain the destination to the dominant in-plane axis — the one
   * whose deviation from moveFrom is larger — so the other in-plane axis keeps its
   * starting value (zero movement on it). E.g. on the XY plane, if the cursor has
   * deviated more in Y than X, X is pinned to moveFrom.x and the move runs along Y.
   */
  private applyAxisLock(pos: THREE.Vector3): THREE.Vector3 {
    const p = pos.clone();
    const dx = Math.abs(p.x - this.moveFrom.x);
    const dy = Math.abs(p.y - this.moveFrom.y);
    const dz = Math.abs(p.z - this.moveFrom.z);
    switch (this.movePlane) {
      case 'XZ': if (dx >= dz) p.z = this.moveFrom.z; else p.x = this.moveFrom.x; break;
      case 'XY': if (dx >= dy) p.y = this.moveFrom.y; else p.x = this.moveFrom.x; break;
      case 'YZ': if (dy >= dz) p.z = this.moveFrom.z; else p.y = this.moveFrom.y; break;
    }
    return p;
  }

  /** New position for an object starting at `origin`, applying the plane-allowed delta. */
  private displaced(origin: THREE.Vector3, toPos: THREE.Vector3): THREE.Vector3 {
    const fx = this.moveFrom.x, fy = this.moveFrom.y, fz = this.moveFrom.z;
    switch (this.movePlane) {
      case 'XZ': return new THREE.Vector3(origin.x + toPos.x - fx, origin.y,                origin.z + toPos.z - fz);
      case 'XY': return new THREE.Vector3(origin.x + toPos.x - fx, origin.y + toPos.y - fy, origin.z);
      case 'YZ': return new THREE.Vector3(origin.x,                origin.y + toPos.y - fy, origin.z + toPos.z - fz);
    }
  }

  /**
   * Preview (no data write, runs outside Angular zone):
   * - Move:  shift the live objects to the destination.
   * - Copy:  show one ghost per object at the destination.
   * - Array: show `arrayCount` ghosts per object, stepped by the same delta.
   */
  private previewDisplacement(toPos: THREE.Vector3) {
    if (this.isArray) {
      // copyGhosts is keyed by a composite "id#step" for array previews.
      this.moveOrigins.forEach((origin, id) => {
        const dest = this.displaced(origin, toPos);
        const step = new THREE.Vector3().subVectors(dest, origin);
        for (let n = 1; n <= this.arrayCount; n++) {
          const g = this.copyGhosts.get(this.arrayKey(id, n));
          if (!g) continue;
          g.visible = true;
          g.position.copy(origin).addScaledVector(step, n);
        }
      });
      return;
    }
    this.moveOrigins.forEach((origin, id) => {
      const obj = this.isCopy ? this.copyGhosts.get(id) : this.objectMap.get(id);
      if (!obj) return;
      if (this.isCopy) obj.visible = true;
      obj.position.copy(this.displaced(origin, toPos));
    });
  }

  private arrayKey(id: number, step: number) { return id * 1000 + step; }

  /** Spawn a duplicate of `src` at (x,y,z), select-tracked via its returned id. */
  private spawnCopyAt(src: SceneInstance, x: number, y: number, z: number): number {
    const nid = this.nextId++;
    const inst: SceneInstance = {
      id: nid, familyId: src.familyId, label: `МОДУЛ ${nid}`,
      params: { ...src.params }, material: src.material, x, y, z, rotY: src.rotY,
      anchor: src.anchor ? { ...src.anchor } : { ...CENTRE_ANCHOR },
      path: src.path ? src.path.map(p => ({ ...p })) : undefined,
    };
    this.instances.push(inst);
    this.spawnObject(inst);
    return nid;
  }

  /** Commit: Move writes positions; Copy spawns one duplicate; Array spawns N stepped duplicates. */
  private commitDisplacement(toPos: THREE.Vector3) {
    this.pushHistory();
    if (this.isArray) {
      const newIds: number[] = [];
      this.moveOrigins.forEach((origin, id) => {
        const src = this.instances.find(i => i.id === id);
        if (!src) return;
        const step = new THREE.Vector3().subVectors(this.displaced(origin, toPos), origin);
        for (let n = 1; n <= this.arrayCount; n++) {
          newIds.push(this.spawnCopyAt(src, origin.x + step.x * n, origin.y + step.y * n, origin.z + step.z * n));
        }
      });
      this.clearCopyGhosts();
      this.applySelect(newIds);
      return;
    }
    if (this.isCopy) {
      const newIds: number[] = [];
      this.moveOrigins.forEach((origin, id) => {
        const src = this.instances.find(i => i.id === id);
        if (!src) return;
        const p = this.displaced(origin, toPos);
        newIds.push(this.spawnCopyAt(src, p.x, p.y, p.z));
      });
      this.clearCopyGhosts();
      this.applySelect(newIds);
      return;
    }
    this.moveOrigins.forEach((origin, id) => {
      const inst = this.instances.find(i => i.id === id);
      const obj  = this.objectMap.get(id);
      if (!inst || !obj) return;
      const p = this.displaced(origin, toPos);
      inst.x = p.x; inst.y = p.y; inst.z = p.z;
      obj.position.copy(p);
    });
  }

  // ── Revit-style snap ──────────────────────────────────────────────────────

  /**
   * Collect endpoint and midpoint snap candidates from the EdgesGeometry
   * LineSegments attached to every mesh in the scene.
   * skipId: object to exclude (the one being moved).
   */
  private collectSnapCandidates(skip: Set<number> | null): Array<{
    world: THREE.Vector3;
    px: { x: number; y: number };     // canvas pixel coords (top-left origin, y-down)
    type: 'endpoint' | 'midpoint' | 'origin';
  }> {
    const canvas = this.canvasRef.nativeElement;
    const halfW  = canvas.clientWidth  / 2;
    const halfH  = canvas.clientHeight / 2;
    const out: ReturnType<typeof this.collectSnapCandidates> = [];
    const seenEP  = new Set<string>();
    const seenMID = new Set<string>();
    const vA = new THREE.Vector3(), vB = new THREE.Vector3();

    const addPoint = (
      world: THREE.Vector3,
      type: 'endpoint' | 'midpoint' | 'origin',
      seen: Set<string>,
    ) => {
      const key = `${Math.round(world.x)},${Math.round(world.y)},${Math.round(world.z)}`;
      if (seen.has(key)) return;
      seen.add(key);
      const ndc = world.clone().project(this.camera);
      if (ndc.z > 1) return; // behind camera
      // NDC → canvas pixels: x right, y down
      out.push({ world: world.clone(), px: { x: ndc.x * halfW + halfW, y: halfH - ndc.y * halfH }, type });
    };

    // The workspace origin (0,0,0) is always snappable, so you can align objects
    // to the scene centre while moving.
    addPoint(new THREE.Vector3(0, 0, 0), 'origin', new Set<string>());

    this.objectMap.forEach((obj, id) => {
      if (skip?.has(id)) return;
      obj.updateMatrixWorld(false);
      obj.traverse(child => {
        // The EdgesGeometry LineSegments are children of each Mesh
        if (!(child instanceof THREE.LineSegments) || !child.userData['isEdge']) return;
        const pos = child.geometry.attributes['position'];
        if (!pos) return;
        // pairs: (0,1), (2,3), …
        for (let i = 0; i < pos.count - 1; i += 2) {
          vA.fromBufferAttribute(pos, i    ).applyMatrix4(child.matrixWorld);
          vB.fromBufferAttribute(pos, i + 1).applyMatrix4(child.matrixWorld);
          addPoint(vA, 'endpoint', seenEP);
          addPoint(vB, 'endpoint', seenEP);
          const mid = vA.clone().add(vB).multiplyScalar(0.5);
          addPoint(mid, 'midpoint', seenMID);
        }
      });
    });

    return out;
  }

  /**
   * Find the nearest snap candidate (endpoint or midpoint) within pxRadius of
   * the mouse cursor.  Returns null when the cursor is too far from any snap point.
   */
  private findObjectSnap(
    e: MouseEvent,
    skip: Set<number> | null,
    pxRadius = 18,
  ): { world: THREE.Vector3; type: 'endpoint' | 'midpoint' | 'origin' } | null {
    const canvas  = this.canvasRef.nativeElement;
    const r       = canvas.getBoundingClientRect();
    const mousePx = { x: e.clientX - r.left, y: e.clientY - r.top };

    const cands = this.collectSnapCandidates(skip);
    // Priority on a tie: origin > endpoint > midpoint
    const rank = (t: 'endpoint' | 'midpoint' | 'origin') => (t === 'origin' ? 0 : t === 'endpoint' ? 1 : 2);
    cands.sort((a, b) => rank(a.type) - rank(b.type));

    let best: { world: THREE.Vector3; type: 'endpoint' | 'midpoint' | 'origin' } | null = null;
    let bestDist = Infinity;

    for (const c of cands) {
      const dx = c.px.x - mousePx.x;
      const dy = c.px.y - mousePx.y;
      const d  = Math.sqrt(dx * dx + dy * dy);
      if (d < pxRadius && d < bestDist) { bestDist = d; best = { world: c.world, type: c.type }; }
    }

    return best;
  }

  /**
   * Unified snap: object-snap first, then 1mm grid on the given plane.
   * skip: set of object ids to ignore for snapping (the objects being moved).
   * plane: the constraint plane for the snap. When provided, object-snap points
   *        are projected onto it. When null (move-from / placing), the raw 3D
   *        snap point is returned and the caller enforces any y-constraint itself.
   */
  private getSnap(
    e: MouseEvent,
    plane: THREE.Plane | null,
    skip: Set<number> | null,
  ): { pos: THREE.Vector3; type: 'endpoint' | 'midpoint' | 'origin' | 'axis' | 'grid' } | null {
    const objSnap = this.findObjectSnap(e, skip);
    if (objSnap) {
      if (plane) {
        const pos = new THREE.Vector3();
        plane.projectPoint(objSnap.world, pos);
        return { pos, type: objSnap.type };
      }
      // No plane → return the actual 3D snap position
      return { pos: objSnap.world.clone(), type: objSnap.type };
    }

    // Grid snap
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const target = plane ?? this.groundPlane;
    const pos    = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(target, pos)) return null;
    pos.x = Math.round(pos.x);
    pos.y = Math.round(pos.y);
    pos.z = Math.round(pos.z);
    // Snap onto a main coordinate axis when the cursor is within a few px of one.
    const onAxis = this.applyAxisSnap(pos);
    return { pos, type: onAxis ? 'axis' : 'grid' };
  }

  /** Screen-space pixel position of a world point. */
  private worldToPx(v: THREE.Vector3): { x: number; y: number } {
    const canvas = this.canvasRef.nativeElement;
    const ndc = v.clone().project(this.camera);
    return { x: ndc.x * canvas.clientWidth / 2 + canvas.clientWidth / 2, y: canvas.clientHeight / 2 - ndc.y * canvas.clientHeight / 2 };
  }

  /**
   * Pin any coordinate of `pos` to 0 when, on screen, the point is within AXIS_PX of
   * that coordinate being zero. On the ground plane (y = 0) this lands the point exactly
   * on the world X axis (z→0) or Z axis (x→0); the screen-space test self-disables when
   * the active plane is far from that axis. Mutates `pos`; returns true if anything snapped.
   */
  private applyAxisSnap(pos: THREE.Vector3): boolean {
    const AXIS_PX = 10;
    const here = this.worldToPx(pos);
    let snapped = false;
    (['x', 'y', 'z'] as const).forEach(ax => {
      if (Math.abs(pos[ax]) < 1e-6) return;
      const alt = pos.clone(); alt[ax] = 0;
      const p = this.worldToPx(alt);
      if (Math.hypot(p.x - here.x, p.y - here.y) < AXIS_PX) { pos[ax] = 0; snapped = true; }
    });
    return snapped;
  }

  private showSnap(pos: THREE.Vector3, type: 'endpoint' | 'midpoint' | 'origin' | 'axis' | 'grid') {
    this.snapDot.visible = true;
    this.snapDot.position.copy(pos);
    const hex = type === 'origin'   ? 0xff44dd
              : type === 'endpoint' ? 0x00e5ff
              : type === 'midpoint' ? 0x76ff03
              : type === 'axis'     ? 0xffd400
              :                       0xffffff;
    (this.snapDot.material as THREE.MeshBasicMaterial).color.setHex(hex);
  }

  /**
   * Draw the move guide line (moveFrom → cursor), keep the in-plane direction for
   * typed-distance commits, position the distance editor by the cursor, and (unless
   * the user has typed a value) reflect the live cursor distance into the input.
   */
  private showMoveMeasure(e: MouseEvent, toPos: THREE.Vector3) {
    const attr = this.moveLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.setXYZ(0, this.moveFrom.x, this.moveFrom.y, this.moveFrom.z);
    attr.setXYZ(1, toPos.x, toPos.y, toPos.z);
    attr.needsUpdate = true;
    this.moveLine.visible = true;

    const dist = this.moveFrom.distanceTo(toPos);
    this.moveDir.subVectors(toPos, this.moveFrom);
    if (this.moveDir.lengthSq() > 1e-9) this.moveDir.normalize();

    const r = this.canvasRef.nativeElement.getBoundingClientRect();
    const x = e.clientX - r.left + 16;
    const y = e.clientY - r.top + 16;
    this.ngZone.run(() => {
      this.moveLabel = { x, y };
      if (!this.distanceLocked) this.distanceStr = String(Math.round(dist));
      if (this.distFocusPending) {
        this.distFocusPending = false;
        setTimeout(() => this.distInputRef?.nativeElement.focus());
      }
    });
  }

  private hideMoveMeasure() {
    if (this.moveLine) this.moveLine.visible = false;
    this.moveLabel = null;
  }

  // ── Three.js setup ─────────────────────────────────────────────────────────

  /** A camera-facing text label (sprite) for an axis arrow tip. */
  private makeAxisLabel(text: string, color: number, pos: THREE.Vector3): THREE.Sprite {
    const size = 128;
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const ctx = cv.getContext('2d')!;
    ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
    ctx.font = 'bold 90px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
    sprite.position.copy(pos);
    sprite.scale.set(120, 120, 1);
    sprite.renderOrder = 999;
    return sprite;
  }

  private initThree() {
    const canvas = this.canvasRef.nativeElement;
    const w = canvas.clientWidth || 800;
    const h = canvas.clientHeight || 600;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e0e0e);

    this.camera = new THREE.PerspectiveCamera(55, w / h, 1, 100000);
    this.camera.position.set(1500, 1200, 1500);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.45));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3000, 5000, 3000);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 10; key.shadow.camera.far = 30000;
    key.shadow.camera.left = key.shadow.camera.bottom = -8000;
    key.shadow.camera.right = key.shadow.camera.top   =  8000;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8899ff, 0.3);
    fill.position.set(-3000, -2000, -3000);
    this.scene.add(fill);

    this.scene.add(new THREE.GridHelper(5000, 500, 0x2a2a2a, 0x1a1a1a));
    const axisLen = 500;
    this.scene.add(new THREE.AxesHelper(axisLen));
    // X/Y/Z labels at the tip of each axis arrow
    this.scene.add(this.makeAxisLabel('X', 0xff5555, new THREE.Vector3(axisLen + 70, 0, 0)));
    this.scene.add(this.makeAxisLabel('Y', 0x55ff55, new THREE.Vector3(0, axisLen + 70, 0)));
    this.scene.add(this.makeAxisLabel('Z', 0x5588ff, new THREE.Vector3(0, 0, axisLen + 70)));

    this.snapDot = new THREE.Mesh(
      new THREE.SphereGeometry(8, 8, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    this.snapDot.visible = false;
    this.scene.add(this.snapDot);

    // Guide line + distance readout for moves (hidden until move-to)
    const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.moveLine = new THREE.Line(lineGeo, new THREE.LineBasicMaterial({ color: 0xffcc33 }));
    this.moveLine.visible = false;
    this.moveLine.renderOrder = 998;
    this.scene.add(this.moveLine);

    // Dimension line for the Measure tool (hidden until measuring)
    const measGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.measureLine = new THREE.Line(measGeo, new THREE.LineBasicMaterial({ color: 0x00e5ff }));
    this.measureLine.visible = false;
    this.measureLine.renderOrder = 998;
    this.scene.add(this.measureLine);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.mouseButtons.LEFT   = null as any; // left-drag reserved for selection/marquee
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT  = THREE.MOUSE.ROTATE;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.minDistance = 50;
    this.controls.maxDistance = 50000;

    this.boundDown  = (e) => this.onCanvasDown(e);
    this.boundClick = (e) => this.onCanvasClick(e);
    this.boundMove  = (e) => this.onCanvasMove(e);
    this.boundUp    = (e) => this.onCanvasUp(e);
    canvas.addEventListener('mousedown', this.boundDown);
    canvas.addEventListener('click',     this.boundClick);
    canvas.addEventListener('mousemove', this.boundMove);
    canvas.addEventListener('mouseup',   this.boundUp);

    this.resizeObserver = new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    this.resizeObserver.observe(canvas.parentElement!);

    this.animate();
  }

  private animate() {
    this.animFrameId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ── Input helpers ──────────────────────────────────────────────────────────

  private ndc(e: MouseEvent): THREE.Vector2 {
    const r = this.canvasRef.nativeElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width)  *  2 - 1,
      ((e.clientY - r.top)  / r.height) * -2 + 1,
    );
  }

  private clientToNDC(clientX: number, clientY: number): THREE.Vector2 {
    const r = this.canvasRef.nativeElement.getBoundingClientRect();
    return new THREE.Vector2(
      ((clientX - r.left) / r.width)  *  2 - 1,
      ((clientY - r.top)  / r.height) * -2 + 1,
    );
  }

  private isDrag(e: MouseEvent): boolean {
    return Math.abs(e.clientX - this.mouseDownAt.x) > 5 ||
           Math.abs(e.clientY - this.mouseDownAt.y) > 5;
  }

  // ── Canvas event handlers ──────────────────────────────────────────────────

  private onCanvasDown(e: MouseEvent) {
    this.mouseDownAt  = { x: e.clientX, y: e.clientY };
    this.marqueeStart = { x: e.clientX, y: e.clientY };
    this.isMarqueeing = false;
  }

  private onCanvasMove(e: MouseEvent) {
    if (this.mode === 'placing') {
      const snap = this.getSnap(e, null, null);
      if (!snap) return;
      if (this.ghost) this.ghost.position.set(snap.pos.x, 0, snap.pos.z);
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'move-from' || this.mode === 'measure-from') {
      const snap = this.getSnap(e, null, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'wall-from') {
      const snap = this.getSnap(e, this.groundPlane, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'wall-to') {
      const snap = this.getSnap(e, this.groundPlane, null);
      if (!snap) return;
      const last = this.wallPath[this.wallPath.length - 1];
      const pos = e.shiftKey ? this.lockAxisXZ(snap.pos, last) : snap.pos;
      this.showSnap(pos, snap.type);
      this.updateWallGhost(last, pos);
      return;
    }

    if (this.mode === 'slab-from') {
      const snap = this.getSnap(e, this.groundPlane, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'slab-to') {
      const snap = this.getSnap(e, this.groundPlane, null);
      if (!snap) return;
      const last = this.slabPath[this.slabPath.length - 1];
      const pos = e.shiftKey ? this.lockAxisXZ(snap.pos, last) : snap.pos;
      this.showSnap(pos, snap.type);
      this.updateSlabGhost(pos);
      return;
    }

    if (this.mode === 'measure-to') {
      // Shift constrains the second point to the active plane through the first point.
      const plane = e.shiftKey ? this.getActivePlane(this.measureFrom) : null;
      const snap = this.getSnap(e, plane, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      this.showMeasure(snap.pos);
      return;
    }

    if (this.mode === 'move-to') {
      const snap = this.getSnap(e, this.getActivePlane(), this.selectedIds);
      if (!snap) return;
      const pos = e.shiftKey ? this.applyAxisLock(snap.pos) : snap.pos;
      this.showSnap(pos, snap.type);
      this.previewDisplacement(pos);
      this.showMoveMeasure(e, pos);
      return;
    }

    // Marquee box update (left button held in idle mode)
    if (e.buttons === 1) {
      const dx = e.clientX - this.marqueeStart.x;
      const dy = e.clientY - this.marqueeStart.y;
      if (!this.isMarqueeing && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        this.isMarqueeing = true;
        this.clearHover();
      }
      if (this.isMarqueeing) {
        const r = this.canvasRef.nativeElement.getBoundingClientRect();
        const left  = Math.min(this.marqueeStart.x, e.clientX) - r.left;
        const top   = Math.min(this.marqueeStart.y, e.clientY) - r.top;
        this.ngZone.run(() => {
          this.marqueeRect = { left, top, width: Math.abs(dx), height: Math.abs(dy) };
        });
      }
      return;
    }

    // Idle, no button held → track the TAB hover-cycle candidate.
    this.updateHover(e);
  }

  private onCanvasUp(e: MouseEvent) {
    if (e.button !== 0) return;
    if (this.isMarqueeing && this.mode === 'idle') {
      this.isMarqueeing = false;
      this.performMarqueeSelect(this.marqueeStart, { x: e.clientX, y: e.clientY });
      this.ngZone.run(() => { this.marqueeRect = null; });
    } else {
      this.isMarqueeing = false;
    }
  }

  private performMarqueeSelect(start: { x: number; y: number }, end: { x: number; y: number }) {
    const s = this.clientToNDC(start.x, start.y);
    const f = this.clientToNDC(end.x,   end.y);
    const minX = Math.min(s.x, f.x), maxX = Math.max(s.x, f.x);
    const minY = Math.min(s.y, f.y), maxY = Math.max(s.y, f.y);

    const selected: number[] = [];
    this.objectMap.forEach((obj, id) => {
      obj.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(obj);
      if (box.isEmpty()) return;
      let oMinX = Infinity, oMaxX = -Infinity, oMinY = Infinity, oMaxY = -Infinity;
      const { min: mn, max: mx } = box;
      for (const cx of [mn.x, mx.x]) for (const cy of [mn.y, mx.y]) for (const cz of [mn.z, mx.z]) {
        const v = new THREE.Vector3(cx, cy, cz).project(this.camera);
        if (v.x < oMinX) oMinX = v.x; if (v.x > oMaxX) oMaxX = v.x;
        if (v.y < oMinY) oMinY = v.y; if (v.y > oMaxY) oMaxY = v.y;
      }
      if (oMaxX >= minX && oMinX <= maxX && oMaxY >= minY && oMinY <= maxY) selected.push(id);
    });

    this.ngZone.run(() => this.applySelect(selected));
  }

  /** Raycast the cursor against object faces; returns the nearest instance id or null. */
  private pickInstance(e: MouseEvent): number | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const meshes: THREE.Mesh[] = [];
    this.objectMap.forEach((obj, id) => {
      obj.traverse(child => {
        if (child instanceof THREE.Mesh && !child.userData['isEdge']) {
          child.userData['iid'] = id; meshes.push(child);
        }
      });
    });
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.length > 0 ? (hits[0].object.userData['iid'] as number) : null;
  }

  // ── TAB hover-cycle highlight ────────────────────────────────────────────────

  private baseEdgeColor(id: number) { return this.selectedIds.has(id) ? EDGE_SELECTED : EDGE_NORMAL; }

  /**
   * Tagged panel nodes (`userData['panel']`) of instance `id` hit by the cursor ray,
   * nearest first. Families that aren't composed of panels (e.g. Ploskost) return [].
   */
  private panelsUnderCursor(e: MouseEvent, id: number): THREE.Object3D[] {
    const group = this.objectMap.get(id);
    if (!group) return [];
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const faces: THREE.Mesh[] = [];
    group.traverse(c => { if (c instanceof THREE.Mesh && !c.userData['isEdge']) faces.push(c); });
    const hits = this.raycaster.intersectObjects(faces, false);
    const seen = new Set<THREE.Object3D>();
    const out: THREE.Object3D[] = [];
    for (const h of hits) {
      let n: THREE.Object3D | null = h.object;
      while (n && n !== group && !n.userData['panel']) n = n.parent;
      if (n && n !== group && n.userData['panel'] && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
  }

  /** Paint the current TAB candidate: index 0 = whole instance, 1..N = one panel. */
  private applyHoverHighlight() {
    if (this.hoverId === null) return;
    const group = this.objectMap.get(this.hoverId);
    if (!group) return;
    setEdgeColor(group, this.baseEdgeColor(this.hoverId));   // reset the instance first
    if (this.tabIndex === 0) setEdgeColor(group, EDGE_HOVER);
    else { const n = this.hoverPanels[this.tabIndex - 1]; if (n) setEdgeColor(n, EDGE_HOVER); }
  }

  /** Restore the hovered instance's edges and drop the hover state. */
  private clearHover() {
    if (this.hoverId !== null) {
      const g = this.objectMap.get(this.hoverId);
      if (g) setEdgeColor(g, this.baseEdgeColor(this.hoverId));
      // keep a persistently sub-selected panel highlighted
      if (this.selectedPanelNode) setEdgeColor(this.selectedPanelNode, EDGE_SELECTED);
    }
    this.hoverId = null; this.hoverPanels = []; this.tabIndex = 0;
  }

  /** Track what's under the cursor while idle (drives the TAB cycle). */
  private updateHover(e: MouseEvent) {
    const id = this.pickInstance(e);
    if (id !== this.hoverId) { this.clearHover(); this.hoverId = id; this.tabIndex = 0; }
    if (id === null) return;
    this.hoverPanels = this.panelsUnderCursor(e, id);
    if (this.tabIndex > this.hoverPanels.length) this.tabIndex = 0;   // clamp if the stack shrank
    this.applyHoverHighlight();
  }

  /** TAB: advance the hover cycle (instance → each panel under the cursor → instance …). */
  cycleHover() {
    if (this.mode !== 'idle' || this.hoverId === null) return;
    this.tabIndex = (this.tabIndex + 1) % (this.hoverPanels.length + 1);
    this.applyHoverHighlight();
  }

  /** Sub-select one panel of a family instance: highlight it and show its info read-only. */
  private selectSubPanel(instanceId: number, node: THREE.Object3D) {
    const d = node.userData['panel'] as Omit<PanelInfo, 'instanceId' | 'material' | 'core1' | 'core2'>;
    const inst = this.instances.find(i => i.id === instanceId);
    // БЕЗ КАНТ (cut size): a band trims the dimension PERPENDICULAR to its edge — the
    // BC/DA edges trim РАЗМЕР 1 (AB), the AB/CD edges trim РАЗМЕР 2 (BC).
    const core1 = d.size1 - d.kant * ((d.pvc[1] ? 1 : 0) + (d.pvc[3] ? 1 : 0));
    const core2 = d.size2 - d.kant * ((d.pvc[0] ? 1 : 0) + (d.pvc[2] ? 1 : 0));
    this.selectedPanelNode = node;
    this.selectedPanel = { instanceId, material: inst?.material ?? '', core1, core2, ...d };
    setEdgeColor(node, EDGE_SELECTED);
  }

  /** Drop any panel sub-selection and restore its edges. */
  private clearSubSelection() {
    if (this.selectedPanelNode) setEdgeColor(this.selectedPanelNode, EDGE_NORMAL);
    this.selectedPanelNode = null;
    this.selectedPanel = null;
  }

  private onCanvasClick(e: MouseEvent) {
    if (this.isDrag(e)) return;

    if (this.mode === 'placing') {
      const snap = this.getSnap(e, null, null);
      if (snap) this.ngZone.run(() => this.commitPlace(snap.pos));
      return;
    }

    if (this.mode === 'wall-from') {
      const snap = this.getSnap(e, this.groundPlane, null);
      if (snap) {
        this.wallPath = [snap.pos.clone()];
        this.wallInstanceId = null;
        this.ngZone.run(() => {
          this.mode = 'wall-to';
          this.modeLabel = 'Click the next corner — hold Shift to lock to X/Z — Esc to finish';
        });
      }
      return;
    }

    if (this.mode === 'wall-to') {
      const snap = this.getSnap(e, this.groundPlane, null);
      if (!snap) return;
      const last = this.wallPath[this.wallPath.length - 1];
      const pos = e.shiftKey ? this.lockAxisXZ(snap.pos, last) : snap.pos;
      if (Math.hypot(pos.x - last.x, pos.z - last.z) >= 1) {
        this.ngZone.run(() => this.addWallPoint(pos));
      }
      return;
    }

    if (this.mode === 'slab-from') {
      const snap = this.getSnap(e, this.groundPlane, null);
      if (snap) {
        this.slabPath = [snap.pos.clone()];
        this.ngZone.run(() => {
          this.mode = 'slab-to';
          this.modeLabel = 'Click corners — Shift locks X/Z — click the first point or Enter to close';
        });
      }
      return;
    }

    if (this.mode === 'slab-to') {
      // Clicking back on the first vertex closes and finalises the polygon.
      if (this.nearFirstSlabVertex(e)) { this.ngZone.run(() => this.cancelMode()); return; }
      const snap = this.getSnap(e, this.groundPlane, null);
      if (!snap) return;
      const last = this.slabPath[this.slabPath.length - 1];
      const pos = e.shiftKey ? this.lockAxisXZ(snap.pos, last) : snap.pos;
      if (Math.hypot(pos.x - last.x, pos.z - last.z) >= 1) this.addSlabPoint(pos);
      return;
    }

    if (this.mode === 'measure-from') {
      const snap = this.getSnap(e, null, null);
      if (snap) {
        this.measureFrom.copy(snap.pos);
        this.hideMeasure();   // clear any previous frozen measurement
        this.ngZone.run(() => {
          this.mode = 'measure-to';
          this.modeLabel = 'Click the second point — hold Shift to measure in a plane — Esc to finish';
        });
      }
      return;
    }

    if (this.mode === 'measure-to') {
      const plane = e.shiftKey ? this.getActivePlane(this.measureFrom) : null;
      const snap = this.getSnap(e, plane, null);
      if (snap) {
        this.showMeasure(snap.pos);   // freeze the dimension at the clicked point
        this.ngZone.run(() => {
          this.mode = 'measure-from';   // ready for the next measurement (a new first click clears this one)
          this.modeLabel = 'Click the first point — Esc to finish';
        });
      }
      return;
    }

    if (this.mode === 'move-from') {
      const snap = this.getSnap(e, null, null);
      if (snap) {
        this.moveFrom.copy(snap.pos);
        this.distFocusPending = true;
        this.ngZone.run(() => {
          this.mode = 'move-to';
          this.modeLabel = 'Click destination or type distance — Shift locks to one axis — Esc to cancel';
        });
      }
      return;
    }

    if (this.mode === 'move-to') {
      const snap = this.getSnap(e, this.getActivePlane(), this.selectedIds);
      if (snap) {
        let pos = e.shiftKey ? this.applyAxisLock(snap.pos) : snap.pos;
        // If a distance was typed, honour it along the current cursor direction.
        const typed = parseFloat(this.distanceStr);
        if (this.distanceLocked && isFinite(typed) && typed > 0 && this.moveDir.lengthSq() > 1e-9) {
          pos = this.moveFrom.clone().addScaledVector(this.moveDir, typed);
        }
        this.ngZone.run(() => this.finishMoveTo(pos));   // don't cancelMode() — it would restore origins
      }
      return;
    }

    // ── match: click a target to copy the source's properties onto it ───────
    if (this.mode === 'match') {
      const id = this.pickInstance(e);
      if (id !== null) this.ngZone.run(() => this.applyMatchTo(id));
      return;
    }

    // ── idle: select a sub-panel (TAB-focused) or the whole instance ────────
    const hitId = this.pickInstance(e);
    // Capture the TAB-focused panel before clearing the hover state.
    const panelNode = this.tabIndex >= 1 ? this.hoverPanels[this.tabIndex - 1] : null;
    const panelInstanceId = this.hoverId;
    this.clearHover();   // selection takes over the edge colours
    this.ngZone.run(() => {
      this.clearSubSelection();
      if (panelNode && panelInstanceId !== null) {
        this.applySelect([]);   // a panel isn't an instance — no instance selection
        this.selectSubPanel(panelInstanceId, panelNode);
      } else if (hitId !== null) {
        this.applySelect(this.selectedIds.size === 1 && this.selectedIds.has(hitId) ? [] : [hitId]);
      } else {
        this.applySelect([]);
      }
    });
  }
}
