/**
 * WebCAD — IsVoid boolean cutting. `applyVoidCuts` is the only export: given a
 * freshly-built, still-unplaced instance Object3D (see the call site in
 * admin-page.component.ts's spawnObject for the exact timing requirement) and the
 * full instance list, it subtracts every applicable void SOLID's geometry from the
 * object's own meshes, in place.
 */
import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import type { SceneInstance } from './webcad.model';
import { buildSolidExtrude, buildSolidSweep } from './webcad-geometry';

const evaluator = new Evaluator();

/** The world-placement matrix spawnObject is about to apply to an instance (translation + Y rotation). */
function instanceMatrix(inst: SceneInstance): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(inst.x, inst.y, inst.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), inst.rotY * (Math.PI / 180)),
    new THREE.Vector3(1, 1, 1),
  );
}

/** A void SOLID's raw LOCAL geometry — the same extrude/sweep dispatch
 *  `buildInstanceObject` uses for any other SOLID. */
function buildVoidSolidGeometry(inst: SceneInstance): THREE.Object3D | null {
  if (inst.solidOp === 'sweep' && inst.path && inst.path.length >= 3 &&
      inst.pathPoints && inst.pathPoints.length >= 2 && inst.pathPlane) {
    return buildSolidSweep(inst.path, inst.pathPoints, inst.pathPlane, inst.closed ?? false,
      inst.params['ПРОФИЛ_ЗАВЪРТАНЕ'] ?? 0, inst.params['ПРОФИЛ_ОТСТЪП_ХОРИЗ'] ?? 0, inst.params['ПРОФИЛ_ОТСТЪП_ВЕРТ'] ?? 0);
  }
  if (inst.path && inst.path.length >= 3 && inst.plane) {
    return buildSolidExtrude(inst.path, inst.params['ДЪЛБОЧИНА'] ?? 18, inst.plane);
  }
  return null;
}

/**
 * Subtract every void SOLID (`familyId === 'solid' && isVoid`) in `instances` from
 * `obj`'s own mesh geometries, IN PLACE — `obj`'s own transform and every mesh's
 * local transform are left untouched; only `.geometry` is replaced, still expressed
 * in that same local frame, so nothing downstream (move, copy, measure, anchoring)
 * needs to know this instance was ever cut. Lines and other void SOLIDs are never
 * themselves cut (skipped entirely, by the caller and by the `v.id !== inst.id` guard
 * below respectively). A void whose own `voidExcludeIds` lists `inst.id` (the "Cuts"
 * list's eye icons, toggled in admin-page.component.ts) is skipped for THIS target
 * only — it still cuts everything else.
 *
 * MUST run on `obj` while it is still at its pre-placement identity transform — i.e.
 * right after `anchorWrap`, before spawnObject applies `inst.x/y/z/rotY` to it. At
 * that moment each mesh's own `matrixWorld` IS its transform relative to `obj`'s root
 * (obj has no parent and no transform yet), which combined with `instanceMatrix(inst)`
 * (replicating the placement spawnObject is about to apply) gives the exact same
 * world frame every void below is independently placed in via its own x/y/z/rotY —
 * letting the cut be computed in world space without obj ever actually being there.
 */
export function applyVoidCuts(obj: THREE.Object3D, inst: SceneInstance, instances: SceneInstance[]): void {
  const voids = instances.filter(v =>
    v.familyId === 'solid' && v.isVoid && v.id !== inst.id && !v.voidExcludeIds?.includes(inst.id));
  if (voids.length === 0) return;

  obj.updateMatrixWorld(true);
  const trueObjMatrix = instanceMatrix(inst);

  const cutterGeos: THREE.BufferGeometry[] = [];
  for (const v of voids) {
    const built = buildVoidSolidGeometry(v);
    if (!built) continue;
    const voidMatrix = instanceMatrix(v);
    built.traverse(child => {
      if (child instanceof THREE.Mesh) cutterGeos.push(child.geometry.clone().applyMatrix4(voidMatrix));
    });
  }
  if (cutterGeos.length === 0) return;

  obj.traverse(child => {
    if (!(child instanceof THREE.Mesh) || child.userData['isEdge'] || child.userData['isLinePickTarget']) return;
    // child.matrixWorld (obj is at identity) = child's transform relative to obj-root;
    // combined with trueObjMatrix that's child's transform in the SAME world space the
    // cutters above were baked into.
    const toWorld = trueObjMatrix.clone().multiply(child.matrixWorld);
    const toLocal = toWorld.clone().invert();
    let geo: THREE.BufferGeometry = child.geometry.clone().applyMatrix4(toWorld);

    // Brush's `material` (NOT just the geometry's `.groups`) is what the Evaluator
    // uses to understand how many distinct materials a multi-group mesh actually
    // has (`getMaterialList` in three-bvh-csg) — omitting it (as earlier code did)
    // makes every group silently collapse onto the one default material, which for
    // a 2-material panel (painted face + chipboard edge-band) meant the chipboard
    // group vanished and the cut face rendered with the wrong material (confirmed
    // live). The newly-exposed cut surface should look like the target's own
    // innermost material (exposed chipboard core, same as any other routed edge) —
    // reusing that EXACT material reference (not a copy) for the cutter brush lets
    // three-bvh-csg's `useCommonMaterials` (which matches by `indexOf`, i.e. by
    // reference) fold the cutter into the target's own existing slot instead of
    // inventing a spurious third material.
    const cutterMat = Array.isArray(child.material) ? child.material[child.material.length - 1] : child.material;
    let currentMat: THREE.Material | THREE.Material[] = child.material;
    for (const cutterGeo of cutterGeos) {
      try {
        const a = new Brush(geo, currentMat);
        const b = new Brush(cutterGeo, cutterMat);
        a.updateMatrixWorld(); b.updateMatrixWorld();
        const result = evaluator.evaluate(a, b, SUBTRACTION);
        geo = result.geometry;
        currentMat = result.material as THREE.Material | THREE.Material[];
      } catch (err) {
        console.warn('[VOID] cut failed on one mesh — leaving that cut out', err);
      }
    }
    geo.applyMatrix4(toLocal);
    child.geometry.dispose();
    child.geometry = geo;
    child.material = currentMat;
  });
}
