import {
  Component, ElementRef, ViewChild, OnInit, OnDestroy, NgZone, HostListener,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
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
}

export interface SceneInstance {
  id: number;
  familyId: string;
  label: string;
  params: Record<string, number>;
  x: number;
  y: number;
  z: number;
  rotY: number;
}

export type InteractionMode = 'idle' | 'placing' | 'move-from' | 'move-to';
export type MovePlane      = 'XZ' | 'XY' | 'YZ';

// ── Colors ────────────────────────────────────────────────────────────────────

const COLOR_NORMAL   = 0xc8a87a;
const COLOR_SELECTED = 0x4a9cd4;
const EDGE_NORMAL    = 0x333333;
const EDGE_SELECTED  = 0xffffff;
const EDGE_PVC       = 0x888888;   // slightly lighter edge for PVC faces

// Enable Three.js asset cache so the same URL is only fetched once even when
// each material loads the texture independently.
THREE.Cache.enabled = true;

const CHIPBOARD_URL = 'assets/images/3D/chipboard-texture.jpg';

// ── Geometry helpers ──────────────────────────────────────────────────────────

function buildPloskostGeo(AB: number, BC: number, angleDeg: number, thickness: number): THREE.BufferGeometry {
  const a = angleDeg * (Math.PI / 180);
  const shape = new THREE.Shape();
  shape.moveTo(0, 0);
  shape.lineTo(AB, 0);
  shape.lineTo(AB + BC * Math.cos(a), BC * Math.sin(a));
  shape.lineTo(BC * Math.cos(a),      BC * Math.sin(a));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.computeBoundingBox();
  const c = new THREE.Vector3();
  geo.boundingBox!.getCenter(c);
  geo.translate(-c.x, -c.y, -c.z);
  return geo;
}

/**
 * Group 0 = caps (front/back large faces)  ← faceMat
 * Group 1 = side walls (18mm edge faces)   ← edgeMat (chipboard texture)
 */
function makeMesh(
  AB: number, BC: number, angleDeg: number, thickness: number,
  pvcEdge = false, pvcThickness = 0.5,
): THREE.Mesh {
  const geo = buildPloskostGeo(AB, BC, angleDeg, thickness);

  const faceMat = new THREE.MeshPhongMaterial({
    color: COLOR_NORMAL, shininess: 30, specular: new THREE.Color(0x111111),
  });

  let edgeMat: THREE.MeshPhongMaterial;
  if (pvcEdge) {
    // PVC banding: smooth bright surface; shininess scales subtly with thickness
    const s = Math.min(120, 60 + pvcThickness * 20);
    edgeMat = new THREE.MeshPhongMaterial({
      color: 0xfcf9f5, shininess: s, specular: new THREE.Color(0x333333),
    });
  } else {
    // Chipboard cross-section texture loaded per-material.
    // THREE.Cache.enabled above means the image is only fetched once.
    const loader = new THREE.TextureLoader();
    const tex = loader.load(CHIPBOARD_URL);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    // ExtrudeGeometry emits side-wall UVs in MODEL-SPACE MILLIMETRES (one axis
    // runs along the perimeter, the other across the thickness), not normalised
    // 0–1. So a repeat of 1/TILE_MM makes one texture tile span TILE_MM of real
    // material — identical scale on both axes, so the speckle stays proportional.
    const TILE_MM = 220;
    tex.repeat.set(1 / TILE_MM, 1 / TILE_MM);
    tex.colorSpace = THREE.SRGBColorSpace;
    edgeMat = new THREE.MeshPhongMaterial({ map: tex, shininess: 5 });
  }

  const mesh = new THREE.Mesh(geo, [faceMat, edgeMat]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

// ── Family registry ───────────────────────────────────────────────────────────

export const FAMILIES: FamilyDef[] = [
  // ── Ploskost ──────────────────────────────────────────────────────────────
  {
    id: 'ploskost',
    name: 'Ploskost',
    params: [
      { key: 'AB',           label: 'AB',             defaultValue: 600, min: 1,   step: 1,   unit: 'mm' },
      { key: 'BC',           label: 'BC',             defaultValue: 600, min: 1,   step: 1,   unit: 'mm' },
      { key: 'angle',        label: '∠ABC',           defaultValue: 90,  min: 1,   step: 1,   unit: '°'  },
      { key: 'thickness',    label: 'ДЕБЕЛИНА',       defaultValue: 18,  min: 1,   step: 1,   unit: 'mm' },
      { key: 'pvcEdge',      label: 'PVC Кант',       defaultValue: 0,   min: 0,   step: 1,   unit: '',   type: 'toggle' },
      { key: 'kantThickness', label: 'КАНТ ДЕБЕЛИНА', defaultValue: 0.5, min: 0.1, step: 0.1, unit: 'mm' },
    ],
    buildObject(p) {
      return makeMesh(
        p['AB'], p['BC'], p['angle'] ?? 90, p['thickness'],
        Boolean(p['pvcEdge']), p['kantThickness'] ?? 0.5,
      );
    },
  },

  // ── Cabinet ───────────────────────────────────────────────────────────────
  {
    id: 'cabinet',
    name: 'Cabinet',
    params: [
      { key: 'ШИРИНА',    label: 'ШИРИНА',    defaultValue: 800, min: 37, step: 1, unit: 'mm' },
      { key: 'ВИСОЧИНА',  label: 'ВИСОЧИНА',  defaultValue: 720, min: 37, step: 1, unit: 'mm' },
      { key: 'ДЪЛБОЧИНА', label: 'ДЪЛБОЧИНА', defaultValue: 550, min: 19, step: 1, unit: 'mm' },
    ],
    buildObject(p) {
      const W = p['ШИРИНА']    ?? 800;
      const H = p['ВИСОЧИНА']  ?? 720;
      const D = p['ДЪЛБОЧИНА'] ?? 550;
      const t = 18;
      const group = new THREE.Group();
      const addPanel = (AB: number, BC: number, rx: number, ry: number, rz: number,
                        px: number, py: number, pz: number) => {
        const mesh = makeMesh(AB, BC, 90, t);
        mesh.rotation.set(rx, ry, rz);
        mesh.position.set(px, py, pz);
        group.add(mesh);
      };
      addPanel(D, H, 0, Math.PI / 2, 0, -(W / 2 - t / 2), 0, 0);
      addPanel(D, H, 0, Math.PI / 2, 0,  (W / 2 - t / 2), 0, 0);
      addPanel(W - 2 * t, D, -Math.PI / 2, 0, 0, 0, -(H / 2 - t / 2), 0);
      addPanel(W - 2 * t, D, -Math.PI / 2, 0, 0, 0,  (H / 2 - t / 2), 0);
      addPanel(W, H, 0, 0, 0, 0, 0, -(D / 2 + t / 2));
      return group;
    },
  },
];

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
        if (!mat.map) mat.color.setHex(hex); // skip textured (chipboard) faces
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
  imports: [CommonModule, FormsModule, RouterLink],
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
  marqueeRect: { left: number; top: number; width: number; height: number } | null = null;

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
  private ghost: THREE.Object3D | null = null;
  private objectMap = new Map<number, THREE.Object3D>();
  private nextId = 1;
  private moveFrom    = new THREE.Vector3();
  private moveOrigins = new Map<number, THREE.Vector3>(); // id → original world position

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
    this.renderer?.dispose();
    this.objectMap.forEach(o => disposeObj(o));
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) { if (e.key === 'Escape') this.cancelMode(); }

  // ── Computed getters ───────────────────────────────────────────────────────

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

  getFamilyDef(id: string): FamilyDef { return FAMILIES.find(f => f.id === id) ?? FAMILIES[0]; }
  trackById(_: number, i: SceneInstance) { return i.id; }

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
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    const id = this.nextId++;
    const inst: SceneInstance = {
      id, familyId: this.selectedFamilyId,
      label: `${this.selectedFamily.name} ${id}`,
      params: { ...this.currentParams },
      x: pos.x, y: 0, z: pos.z, rotY: 0,
    };
    this.instances.push(inst);
    this.spawnObject(inst);
    this.applySelect([id]);
    this.mode = 'idle'; this.modeLabel = '';
    this.controls.enabled = true;
    this.snapDot.visible = false;
  }

  private spawnObject(inst: SceneInstance) {
    const obj = this.getFamilyDef(inst.familyId).buildObject(inst.params);
    addEdges(obj);
    obj.position.set(inst.x, inst.y, inst.z);
    obj.rotation.y = inst.rotY * (Math.PI / 180);
    this.objectMap.set(inst.id, obj);
    this.scene.add(obj);
  }

  // ── Selection ──────────────────────────────────────────────────────────────

  applySelect(ids: number[]) {
    this.selectedIds.forEach(id => {
      const obj = this.objectMap.get(id);
      if (obj) { colorObj(obj, COLOR_NORMAL); setEdgeColor(obj, EDGE_NORMAL); }
    });
    this.selectedIds = new Set(ids);
    this.selectedIds.forEach(id => {
      const obj = this.objectMap.get(id);
      if (obj) { colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED); }
    });
  }

  clickList(id: number) {
    this.cancelMode();
    this.applySelect(this.selectedIds.size === 1 && this.selectedIds.has(id) ? [] : [id]);
  }

  // ── Property editing ───────────────────────────────────────────────────────

  updatePosition() {
    const inst = this.selectedInstance;
    if (!inst) return;
    this.objectMap.get(inst.id)?.position.set(inst.x, inst.y, inst.z);
  }

  updateRotation() {
    const inst = this.selectedInstance;
    if (!inst) return;
    const obj = this.objectMap.get(inst.id);
    if (obj) obj.rotation.y = inst.rotY * (Math.PI / 180);
  }

  rebuildSelected() {
    const inst = this.selectedInstance;
    if (!inst) return;
    const old = this.objectMap.get(inst.id);
    if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
    this.spawnObject(inst);
    const obj = this.objectMap.get(inst.id)!;
    colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED);
  }

  deleteSelected() {
    this.selectedIds.forEach(id => {
      const obj = this.objectMap.get(id);
      if (obj) { this.scene.remove(obj); disposeObj(obj); this.objectMap.delete(id); }
    });
    this.instances = this.instances.filter(i => !this.selectedIds.has(i.id));
    this.applySelect([]);
  }

  // ── Move (two-step snap) ───────────────────────────────────────────────────

  startMove() {
    if (this.selectedIds.size === 0) return;
    this.movePlane = 'XZ';
    this.mode = 'move-from';
    this.modeLabel = 'Click reference point — Esc to cancel';
    this.moveOrigins.clear();
    this.selectedIds.forEach(id => {
      const inst = this.instances.find(i => i.id === id);
      if (inst) this.moveOrigins.set(id, new THREE.Vector3(inst.x, inst.y, inst.z));
    });
    this.controls.enabled = false;
  }

  cancelMode() {
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    if (this.mode === 'move-to') {
      this.moveOrigins.forEach((origin, id) => {
        const inst = this.instances.find(i => i.id === id);
        const obj  = this.objectMap.get(id);
        if (inst && obj) { inst.x = origin.x; inst.y = origin.y; inst.z = origin.z; obj.position.copy(origin); }
      });
    }
    this.isMarqueeing = false;
    this.marqueeRect  = null;
    this.snapDot.visible = false;
    this.mode = 'idle'; this.modeLabel = '';
    this.controls.enabled = true;
  }

  // ── Move plane helpers ─────────────────────────────────────────────────────

  private getActivePlane(): THREE.Plane {
    switch (this.movePlane) {
      case 'XZ': return new THREE.Plane(new THREE.Vector3(0, 1, 0),  -this.moveFrom.y);
      case 'XY': return new THREE.Plane(new THREE.Vector3(0, 0, 1),  -this.moveFrom.z);
      case 'YZ': return new THREE.Plane(new THREE.Vector3(1, 0, 0),  -this.moveFrom.x);
    }
  }

  /** Preview: moves all selected 3D objects (no data model update, called outside Angular zone). */
  private previewDisplacement(toPos: THREE.Vector3) {
    const fx = this.moveFrom.x, fy = this.moveFrom.y, fz = this.moveFrom.z;
    this.moveOrigins.forEach((origin, id) => {
      const obj = this.objectMap.get(id);
      if (!obj) return;
      switch (this.movePlane) {
        case 'XZ': obj.position.set(origin.x + toPos.x - fx, origin.y,                   origin.z + toPos.z - fz); break;
        case 'XY': obj.position.set(origin.x + toPos.x - fx, origin.y + toPos.y - fy,    origin.z              ); break;
        case 'YZ': obj.position.set(origin.x,                 origin.y + toPos.y - fy,    origin.z + toPos.z - fz); break;
      }
    });
  }

  /** Commit: updates data model + 3D for all selected objects (must run inside Angular zone). */
  private commitDisplacement(toPos: THREE.Vector3) {
    const fx = this.moveFrom.x, fy = this.moveFrom.y, fz = this.moveFrom.z;
    this.moveOrigins.forEach((origin, id) => {
      const inst = this.instances.find(i => i.id === id);
      const obj  = this.objectMap.get(id);
      if (!inst || !obj) return;
      switch (this.movePlane) {
        case 'XZ': inst.x = origin.x + toPos.x - fx; inst.z = origin.z + toPos.z - fz; break;
        case 'XY': inst.x = origin.x + toPos.x - fx; inst.y = origin.y + toPos.y - fy; break;
        case 'YZ': inst.y = origin.y + toPos.y - fy; inst.z = origin.z + toPos.z - fz; break;
      }
      obj.position.set(inst.x, inst.y, inst.z);
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
    type: 'endpoint' | 'midpoint';
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
      type: 'endpoint' | 'midpoint',
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
  ): { world: THREE.Vector3; type: 'endpoint' | 'midpoint' } | null {
    const canvas  = this.canvasRef.nativeElement;
    const r       = canvas.getBoundingClientRect();
    const mousePx = { x: e.clientX - r.left, y: e.clientY - r.top };

    const cands = this.collectSnapCandidates(skip);
    // Endpoints take priority over midpoints — sort endpoints first
    cands.sort((a, b) => (a.type === b.type ? 0 : a.type === 'endpoint' ? -1 : 1));

    let best: { world: THREE.Vector3; type: 'endpoint' | 'midpoint' } | null = null;
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
  ): { pos: THREE.Vector3; type: 'endpoint' | 'midpoint' | 'grid' } | null {
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
    return { pos, type: 'grid' };
  }

  private showSnap(pos: THREE.Vector3, type: 'endpoint' | 'midpoint' | 'grid') {
    this.snapDot.visible = true;
    this.snapDot.position.copy(pos);
    const hex = type === 'endpoint' ? 0x00e5ff : type === 'midpoint' ? 0x76ff03 : 0xffffff;
    (this.snapDot.material as THREE.MeshBasicMaterial).color.setHex(hex);
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

    if (this.mode === 'move-from') {
      const snap = this.getSnap(e, null, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'move-to') {
      const snap = this.getSnap(e, this.getActivePlane(), this.selectedIds);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      this.previewDisplacement(snap.pos);
      return;
    }

    // Marquee box update (left button held in idle mode)
    if (e.buttons === 1) {
      const dx = e.clientX - this.marqueeStart.x;
      const dy = e.clientY - this.marqueeStart.y;
      if (!this.isMarqueeing && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
        this.isMarqueeing = true;
      }
      if (this.isMarqueeing) {
        const r = this.canvasRef.nativeElement.getBoundingClientRect();
        const left  = Math.min(this.marqueeStart.x, e.clientX) - r.left;
        const top   = Math.min(this.marqueeStart.y, e.clientY) - r.top;
        this.ngZone.run(() => {
          this.marqueeRect = { left, top, width: Math.abs(dx), height: Math.abs(dy) };
        });
      }
    }
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

  private onCanvasClick(e: MouseEvent) {
    if (this.isDrag(e)) return;

    if (this.mode === 'placing') {
      const snap = this.getSnap(e, null, null);
      if (snap) this.ngZone.run(() => this.commitPlace(snap.pos));
      return;
    }

    if (this.mode === 'move-from') {
      const snap = this.getSnap(e, null, null);
      if (snap) {
        this.moveFrom.copy(snap.pos);
        this.ngZone.run(() => {
          this.mode = 'move-to';
          this.modeLabel = 'Click destination — Esc to cancel';
        });
      }
      return;
    }

    if (this.mode === 'move-to') {
      const snap = this.getSnap(e, this.getActivePlane(), this.selectedIds);
      if (snap) {
        this.ngZone.run(() => {
          this.commitDisplacement(snap.pos);
          // Don't call cancelMode() — it would restore to moveOrigin
          this.mode = 'idle';
          this.modeLabel = '';
          this.controls.enabled = true;
          this.snapDot.visible = false;
        });
      }
      return;
    }

    // ── idle: point raycast select ─────────────────────────────────────────
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
    this.ngZone.run(() => {
      if (hits.length > 0) {
        const id = hits[0].object.userData['iid'] as number;
        this.applySelect(this.selectedIds.size === 1 && this.selectedIds.has(id) ? [] : [id]);
      } else {
        this.applySelect([]);
      }
    });
  }
}
