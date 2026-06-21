/**
 * WebCAD — Three.js Object3D utilities. Small, pure helpers the component uses to put a
 * freshly-built family object into the scene and manipulate it: dispose its GPU
 * resources, place it on its base point, add selectable edge lines, recolour faces or
 * edges (for selection/hover), and make a translucent "ghost" for move/copy previews.
 */
import * as THREE from 'three';
import { BasePoint, CENTRE_ANCHOR, EDGE_NORMAL } from './webcad.model';

/** Free the geometry + material(s) of every mesh/line under `obj`. */
export function disposeObj(obj: THREE.Object3D) {
  obj.traverse(child => {
    if (child instanceof THREE.Mesh || child instanceof THREE.LineSegments) {
      child.geometry.dispose();
      const m = child.material;
      if (Array.isArray(m)) m.forEach(x => x.dispose());
      else (m as THREE.Material).dispose();
    }
  });
}

/** Coerce an axis component from loaded JSON into a clamped -1 / 0 / +1. */
function clampAxis(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : 0;
}

/** Validate/clamp an anchor from untrusted JSON; falls back to the centre point. */
export function normAnchor(a: unknown): BasePoint {
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
export function anchorWrap(built: THREE.Object3D, anchor: BasePoint | undefined, rotYDeg: number): THREE.Object3D {
  const a = anchor ?? CENTRE_ANCHOR;
  if (a.x === 0 && a.y === 0 && a.z === 0) return built;
  const off = worldAnchorOffset(built, a, rotYDeg);
  built.position.copy(off.multiplyScalar(-1).applyEuler(new THREE.Euler(0, -rotYDeg * (Math.PI / 180), 0)));
  const wrap = new THREE.Group();
  wrap.add(built);
  return wrap;
}

/** Attach an EdgesGeometry outline to every mesh (tagged `isEdge` for snap/selection). */
export function addEdges(obj: THREE.Object3D): void {
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

/** Recolour the laminate FACES of `obj` (never edge bands), optionally making them translucent. */
export function colorObj(obj: THREE.Object3D, hex: number, transparent = false, opacity = 1) {
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

/** Recolour the edge LINES of `obj` (used for selection / hover highlight). */
export function setEdgeColor(obj: THREE.Object3D, hex: number): void {
  obj.traverse(child => {
    if (child instanceof THREE.LineSegments && child.userData['isEdge']) {
      (child.material as THREE.LineBasicMaterial).color.setHex(hex);
    }
  });
}

/** Turn `obj` into a translucent blue ghost (move/copy/array placement preview). */
export function ghostify(obj: THREE.Object3D) {
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
