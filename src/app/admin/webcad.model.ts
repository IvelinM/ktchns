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
  type?: 'number' | 'toggle';
}

/** A per-panel material choice (a string picked from the scene's material list). */
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
 */
export interface MaterialDef {
  name: string;
  color: string;          // '#rrggbb' (tint; ignored where a texture covers the face)
  transparency: number;   // 0–100 %
  reflection: number;     // 0–100 %
  glossiness: number;     // 0–100 %
  texture?: string;        // data URL of a JPG/PNG, or absent for a plain colour
  textureW?: number;       // real-world tile width  (mm) — one image tile spans this
  textureH?: number;       // real-world tile height (mm)
  textureRotation?: number; // degrees; rotates the texture about the tile centre
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

/** A ground-plane vertex of a wall polyline, in the instance's LOCAL frame (mm). */
export interface WallPoint { x: number; z: number; }

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
  anchor?: BasePoint;  // which bbox point x/y/z refers to; absent ⇒ centre {0,0,0}
  path?: WallPoint[];  // СТЕНА / ПЛОЧА only: the polyline (local coords, first vertex at origin)
  materials?: Record<string, string>;  // per-panel material choices (МАТЕРИАЛИ section)
}

/** A restorable copy of the scene's data model for the undo history. */
export interface SceneSnapshot { instances: SceneInstance[]; nextId: number; }

/** Read-only info shown when a single panel of a family instance is sub-selected. */
export interface PanelInfo {
  instanceId: number; name: string; material: string;
  size1: number; size2: number;          // С КАНТ — built/nominal size
  core1: number; core2: number;          // БЕЗ КАНТ — cut size (band thickness removed per banded edge)
  thickness: number; pvc: boolean[]; kant: number;
}

/** The viewport interaction state machine (drives canvas handlers + the mode overlay). */
export type InteractionMode = 'idle' | 'placing' | 'move-from' | 'move-to' | 'measure-from' | 'measure-to' | 'match' | 'wall-from' | 'wall-to' | 'slab-from' | 'slab-to';
export type MovePlane      = 'XZ' | 'XY' | 'YZ';

// ── Colours ─────────────────────────────────────────────────────────────────────

export const COLOR_NORMAL   = 0xc8a87a;
export const COLOR_SELECTED = 0x4a9cd4;
export const EDGE_NORMAL    = 0x333333;
export const EDGE_SELECTED  = 0xffffff;
export const EDGE_HOVER     = 0xffaa00;   // TAB hover-cycle highlight (orange)
export const EDGE_PVC       = 0x888888;   // slightly lighter edge for PVC faces

// ── Anchors ─────────────────────────────────────────────────────────────────────

/** The centre {0,0,0} base point — used when an instance has no anchor set. */
export const CENTRE_ANCHOR: BasePoint = { x: 0, y: 0, z: 0 };

/** Up axis for wall local↔world rotation (walls only rotate about Y). */
export const WALL_Y = new THREE.Vector3(0, 1, 0);
