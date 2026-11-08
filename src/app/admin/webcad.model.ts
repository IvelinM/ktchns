/**
 * WebCAD — data model & shared constants (the project's vocabulary; read this first).
 *
 * The whole tool is data-driven: the scene is an array of `SceneInstance` (the source of
 * truth) and the 3D objects are derived from it. A `FamilyDef` describes a parametric
 * object type and knows how to build its geometry. Everything else (geometry builders,
 * the family catalog, Object3D utilities, the schedule export, and the Angular component)
 * imports the types and constants defined here.
 */
import * as THREE from 'three';

// ── Family / parameter definitions ──────────────────────────────────────────────

/** One editable parameter of a family (a number field or a 0/1 toggle). */
export interface ParamDef {
  key: string;
  label: string;
  defaultValue: number;
  min: number;
  step: number;
  unit: string;
  type?: 'number' | 'toggle' | 'slider';
  max?: number;   // upper bound for a 'slider' param (ignored otherwise)
}

/** A per-panel material choice — `default` is a `MaterialDef.id` (a stable identity
 *  ref, not a display name — see MaterialDef's own doc comment for why). */
export interface MaterialParamDef {
  key: string;
  label: string;
  default: string;
}

/**
 * A named material in the scene's library, editable from the Materials dialog. The
 * visual properties drive the photoreal Render mode (PBR): `color` is the base hex,
 * `transparency`/`reflection`/`glossiness` are 0–100 % and map to MeshStandard
 * opacity (1 − t/100), metalness (r/100) and roughness (1 − g/100) respectively.
 *
 * An optional JPG `texture` (stored as a data URL so it round-trips in save/load) is
 * mapped at real-world scale: `textureW`/`textureH` are the physical size in mm that
 * one tile of the image covers (e.g. a 1200×800 mm tile → 1200/800), so the texture
 * repeats correctly across a panel regardless of its dimensions.
 *
 * `id` is the stable identity every reference (SceneInstance.materials[key],
 * MaterialParamDef.default) actually points at — `name` is purely the editable display
 * label shown in the Materials dialog and every export. Renaming a material (editing
 * `name` in place, same object) is instant and free precisely BECAUSE nothing else ever
 * stores a copy of `name` — every lookup is `materialDefs.find(m => m.id === ref)`,
 * resolved fresh at read time, so a rename is visible everywhere on the very next read
 * with no propagation step. Before this field existed, every reference WAS a name
 * string, which a rename silently orphaned (the instance kept pointing at a name that no
 * longer existed) — `id` is what this was added specifically to fix. Built-in materials
 * (DEFAULT_MATERIALS, admin-page.component.ts) use fixed, human-readable slugs
 * ('gladko-byalo', …) so a fresh scene's default material-param picks are deterministic
 * across sessions; a material added from the Materials dialog gets a fresh
 * `crypto.randomUUID()`. A material loaded from a save made before this field existed
 * gets one assigned on load (restoreMaterialLibrary), with every instance reference that
 * used to be its NAME rewritten to the new id in the same pass (see its own doc comment).
 */
export interface MaterialDef {
  id: string;
  name: string;
  color: string;          // '#rrggbb' (tint; ignored where a texture covers the face)
  transparency: number;   // 0–100 %
  reflection: number;     // 0–100 %
  glossiness: number;     // 0–100 %
  bump?: number;          // 0–100 %: bump/relief strength (V-Ray "Bump" slot equivalent — a
                          // height map perturbing the shading normal, not true geometry), Render only
  bumpSize?: number;      // real-world tile size of the bump map, in mm (square); default 24
  bumpTexture?: string;   // data URL of a grayscale (or any) image used as the bump map's
                          // height source — absent means the built-in procedural noise instead
                          // (see resolveBumpTexture, admin-page.component.ts)
  texture?: string;        // data URL of a JPG/PNG, or absent for a plain colour
  textureW?: number;       // real-world tile width  (mm) — one image tile spans this
  textureH?: number;       // real-world tile height (mm)
  textureRotation?: number; // degrees; rotates the texture about the tile centre
  // Which of a panel's own two dimensions (РАЗМЕР 1/Ш or РАЗМЕР 2/В — see
  // webcad-schedule.ts's own АB/BC doc comment) the wood grain runs parallel to by
  // default (i.e. with that panel's own ЗАВЪРТЯН_ФЛАДЕР toggle unchecked) — undefined
  // means the default, 'В'. Used ONLY by the cut-list exports, to report whichever
  // dimension the grain actually runs along as "РАЗМЕР 1" (shops cut along the grain
  // first) — never changes the panel's own geometry/banding, just how the schedule
  // labels its two numbers. Checking that panel's ЗАВЪРТЯН_ФЛАДЕР flips the EFFECTIVE
  // axis (Ш↔В) for both the schedule swap and the Render-mode texture's own 90°
  // rotation (see panelGrainRotation, admin-page.component.ts) — same toggle drives both.
  grainAxis?: 'Ш' | 'В';
}

/** A parametric object type. `buildObject(params)` returns its 3D geometry. */
export interface FamilyDef {
  id: string;
  name: string;
  params: ParamDef[];
  buildObject(p: Record<string, number>): THREE.Object3D;
  hidden?: boolean;   // not offered in the FAMILY picker — created by a dedicated tool (e.g. СТЕНА)
  materialParams?: MaterialParamDef[];   // shown in the МАТЕРИАЛИ section (string selects)
}

// ── Scene instances ─────────────────────────────────────────────────────────────

/**
 * The base (insertion) point of an instance, as a bounding-box anchor. Each axis is
 * -1 / 0 / +1 = the min face / centre / max face of the object's local bounding box.
 * The instance's stored x/y/z is the world location of THIS point (default centre).
 */
export interface BasePoint { x: number; y: number; z: number; }

/** A ground-plane vertex of a wall polyline, in the instance's LOCAL frame (mm).
 *  Reused by СТЕНА/ПЛОЧА/Line as a generic (a, b) in-plane pair — not necessarily
 *  literal world x/z (see `PlaneDesc`, used by Line/SOLID). `r` is an optional corner
 *  fillet radius (mm) — СТЕНА/ПЛОЧА never set it. */
export interface WallPoint {
  x: number; z: number;
  r?: number;   // corner fillet radius (mm) — mutually exclusive with `arc` on the same vertex
  arc?: { x: number; z: number };   // local point the segment to the NEXT vertex curves through (3-point arc); absent = straight
}

/**
 * A construction plane: an origin point + unit normal + an in-plane "u" axis
 * (⟂ normal) — together these fully pin down how a Line/SOLID's local (a, b) path
 * points map onto world 3D. The "v" axis is always DERIVED as `uAxis × normal` at the
 * point of use, never stored, so a loaded/edited save can't drift out of
 * orthonormality (re-normalise/re-orthogonalise on load regardless — see
 * `parseSceneJson`).
 */
export interface PlaneDesc {
  origin: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  uAxis:  { x: number; y: number; z: number };
}

/** One placed object: a family id + its parameter/material values + world transform. */
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
  mirrored?: boolean; // true ⇒ a true geometric mirror (local-X flip, obj.scale.x = -1),
                      // set by the Mirror tool. Pure shape handedness flip only — it does
                      // NOT swap handedness-specific params (e.g. ЛЯВА_*/ДЯСНА_* coverage
                      // toggles); same limitation Revit's own Mirror has, adjust those
                      // manually afterward if a mirrored cabinet needs them swapped.
  anchor?: BasePoint;  // which bbox point x/y/z refers to; absent ⇒ centre {0,0,0}
  path?: WallPoint[];  // СТЕНА / ПЛОЧА / Line / SOLID: the polyline (local coords, first vertex at origin)
  materials?: Record<string, string>;  // per-panel material choices (МАТЕРИАЛИ section)
  hidden?: boolean;    // toggled from the scene list's eye icon; hides it from the viewport and picking
  plane?: PlaneDesc;   // Line / SOLID only: the construction plane `path` is drawn/extruded on
  // Line: whether the polyline loops back to its first vertex. SOLID: depends on
  // `solidOp` — 'extrude' (or absent): always true, `path`/`plane` describe the
  // (closed) profile being extruded. 'sweep': whether the PATH loops (`pathPoints`/
  // `pathPlane`), not the profile (a sweep's profile — `path`/`plane` — is always closed).
  closed?: boolean;
  // Line only: extra disjoint point-runs on the SAME `plane`, beyond `path` (the
  // "main" run) — created by the Delete-segment panel's Copy action (a copied
  // segment duplicates in place, parallel to the original, as its own run of the
  // same instance, rather than a separate top-level Line). Each run is always open
  // (a copied segment is just 2 points) — `closed` above only ever describes `path`'s
  // own closedness, never one of these. A Line with any extra runs is "disjoined":
  // Extrude/Mirror refuse it (see `canExtrudeLine`/`MIRROR_EXCLUDED_FAMILIES`) since
  // neither operation has a sensible single-shape meaning for disconnected pieces.
  extraPaths?: { pts: WallPoint[]; closed: boolean }[];
  solidOp?: 'extrude' | 'sweep';   // SOLID only: which operation produced it (absent ⇒ 'extrude')
  pathPlane?: PlaneDesc;    // SOLID (sweep only): the PATH's own construction plane
  pathPoints?: WallPoint[]; // SOLID (sweep only): the PATH's local (u, v) points on pathPlane
  isVoid?: boolean;         // SOLID only: when true, this solid is a boolean cutter —
                            // subtracted from every other instance it overlaps instead
                            // of being a normal visible solid (invisible except while
                            // hovered/selected; see applyVoidCuts in webcad-csg.ts).
  voidExcludeIds?: number[]; // SOLID+isVoid only: ids of instances this void must NOT
                             // cut, even though they overlap it (the "Cuts" list's eye
                             // icons in the void's detail panel toggle membership here).
  fbxData?: string;         // 'fbx-import' only: the imported .fbx file's raw bytes as
                            // a base64 data URL — embedded (not just referenced) so a
                            // saved scene stays one self-contained JSON file, the same
                            // convention MaterialDef.texture already uses for a JPG.
                            // Re-parsed back into a THREE.Group on every spawn by
                            // parseFbxDataUrl (webcad-fbx.ts) — there is no separate
                            // cached geometry to keep in sync.
}

/** A restorable copy of the scene's data model for the undo history. */
export interface SceneSnapshot { instances: SceneInstance[]; nextId: number; nextSolidNum: number; }

/** Read-only info shown when a single panel of a family instance is sub-selected. */
export interface PanelInfo {
  instanceId: number; name: string; material: string;
  size1: number; size2: number;          // С КАНТ — built/nominal size
  core1: number; core2: number;          // БЕЗ КАНТ — cut size (band thickness removed per banded edge)
  thickness: number; pvc: boolean[]; kant: number;
}

/** The viewport interaction state machine (drives canvas handlers + the mode overlay). */
export type InteractionMode = 'idle' | 'placing' | 'move-from' | 'move-to' | 'measure-from' | 'measure-to' | 'match' | 'wall-from' | 'wall-to' | 'slab-from' | 'slab-to' | 'line-plane' | 'line-session' | 'line-from' | 'line-to' | 'pick-plane' | 'circle-center' | 'circle-radius' | 'line-arc-mid' | 'copy-seg-from' | 'copy-seg-to';
export type MovePlane      = 'XZ' | 'XY' | 'YZ';

// ── Colours ─────────────────────────────────────────────────────────────────────

export const COLOR_NORMAL   = 0xc8a87a;
export const COLOR_SELECTED = 0x4a9cd4;
export const EDGE_NORMAL    = 0x333333;
export const EDGE_SELECTED  = 0xffffff;
export const EDGE_HOVER     = 0xffaa00;   // TAB hover-cycle highlight (orange)
export const EDGE_PVC       = 0x888888;   // slightly lighter edge for PVC faces
// Line's own idle edge colour: EDGE_NORMAL (0x333333) is deliberately subtle because
// every other family's edges sit ON a visible, lit face that provides the real
// contrast — a Line has no face at all, so that same dark grey is nearly invisible
// against this app's near-black canvas (confirmed live). Selected/hovering states
// still use the ordinary EDGE_SELECTED/EDGE_HOVER, exactly like every other family.
export const LINE_IDLE_COLOR = 0x7ecbff;

// ── Anchors ─────────────────────────────────────────────────────────────────────

/** The centre {0,0,0} base point — used when an instance has no anchor set. */
export const CENTRE_ANCHOR: BasePoint = { x: 0, y: 0, z: 0 };

/** Up axis for wall local↔world rotation (walls only rotate about Y). */
export const WALL_Y = new THREE.Vector3(0, 1, 0);
