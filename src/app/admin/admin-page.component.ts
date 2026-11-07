import {
  Component, ElementRef, ViewChild, OnInit, OnDestroy, NgZone, HostListener, HostBinding,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import type { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';
import type { Reflector } from 'three/examples/jsm/objects/Reflector.js';
import type { SSAOPass } from 'three/examples/jsm/postprocessing/SSAOPass.js';

// The CAD engine is split into focused modules (see each file's header):
//   webcad.model     — data model & shared constants (the vocabulary; read first)
//   webcad-geometry  — pure solid builders (ploskost, korpus, wall, slab)
//   webcad-families  — the catalog of parametric object types (FAMILIES)
//   webcad-object3d  — Three.js object utilities (dispose, anchor, edges, colours, ghost)
//   webcad-schedule  — cut-list (Спецификация) text generation
// This component is the Angular *interaction controller*: it owns the viewport, the
// scene<->data sync, the toolbar/panel UI, and every mouse/keyboard tool.
import {
  ParamDef, MaterialParamDef, MaterialDef, FamilyDef, BasePoint, WallPoint,
  SceneInstance, SceneSnapshot, PanelInfo, InteractionMode, MovePlane, PlaneDesc,
  COLOR_NORMAL, COLOR_SELECTED, EDGE_NORMAL, EDGE_SELECTED, EDGE_HOVER, LINE_IDLE_COLOR,
  CENTRE_ANCHOR, WALL_Y,
} from './webcad.model';
import {
  makeMesh, buildWallPath, buildSlabPath, buildLinePath, buildSolidExtrude, buildSolidSweep,
  planePointToWorld, normalizePlaneDesc, planeBasis, setRenderBevel, circlePoints,
  filletedPolylineShape, panelMaterialGroup, panelGrainParamKey,
} from './webcad-geometry';
import { FAMILIES } from './webcad-families';
import { disposeObj, normAnchor, anchorWrap, addEdges, colorObj, setEdgeColor, ghostify } from './webcad-object3d';
import { buildScheduleText } from './webcad-schedule';
import { buildHoseWorkbook, buildMayaWorkbook } from './webcad-export-xlsx';
import type ExcelJS from 'exceljs';
import { applyVoidCuts } from './webcad-csg';
import { parseFbxDataUrl } from './webcad-fbx';

// Minimal File System Access API typings — not yet in this project's configured TS/DOM
// lib, and only used for Save/Save as/Open (see the "Save / Load scene" section below).
declare global {
  interface FileSystemFileHandle {
    readonly name: string;
    getFile(): Promise<File>;
    createWritable(): Promise<FileSystemWritableFileStream>;
  }
  interface FileSystemWritableFileStream {
    write(data: BlobPart): Promise<void>;
    close(): Promise<void>;
  }
  interface FilePickerAcceptType { description?: string; accept: Record<string, string[]>; }
  interface Window {
    showSaveFilePicker?(options?: {
      suggestedName?: string; types?: FilePickerAcceptType[];
    }): Promise<FileSystemFileHandle>;
    showOpenFilePicker?(options?: {
      types?: FilePickerAcceptType[];
    }): Promise<FileSystemFileHandle[]>;
  }
}

/**
 * Default base point (БАЗОВА ТОЧКА) for a newly placed family instance: ПЛАН centred
 * (x/z = 0) and РАЗРЕЗ at the **bottom** (y = -1). With the instance placed at y = 0 the
 * object therefore rests on the ground rather than being half-buried.
 */
const PLACE_ANCHOR: BasePoint = { x: 0, y: -1, z: 0 };

/** Max search radius (mm) for the "nearest parallel wall surface" temporary dimension. */
const WALL_DIM_MAX = 15000;

/**
 * Built-in material library. New scenes start with these; loaded scenes keep their own
 * library but have any of these they're MISSING (matched by name) merged in, so the standard
 * finishes are always available. ГЛАДКО БЯЛО is first — it's the family default every
 * materialParam references.
 */
const DEFAULT_MATERIALS: MaterialDef[] = [
  { name: 'ГЛАДКО БЯЛО',    color: '#f0f0f0', transparency: 0,  reflection: 8,  glossiness: 50 },
  { name: 'БЯЛО ГЛАНЦ',     color: '#f4f4f4', transparency: 0,  reflection: 6,  glossiness: 92 },
  { name: 'БЯЛО МАТ',       color: '#ececec', transparency: 0,  reflection: 2,  glossiness: 14 },
  { name: 'БЯЛО ШАГРЕ',     color: '#eeeeee', transparency: 0,  reflection: 3,  glossiness: 32, bump: 55 },
  { name: 'ЧЕРНО ГЛАНЦ',    color: '#0c0c0c', transparency: 0,  reflection: 8,  glossiness: 93 },
  { name: 'ЧЕРНО МАТ',      color: '#141414', transparency: 0,  reflection: 2,  glossiness: 12 },
  { name: 'СТЪКЛО',         color: '#d3e2e8', transparency: 85, reflection: 6,  glossiness: 96 },
  { name: 'ОПУШЕНО СТЪКЛО', color: '#2f3437', transparency: 62, reflection: 6,  glossiness: 95 },
  { name: 'НЕРЪЖДАВЕЙКА',   color: '#babec2', transparency: 0,  reflection: 85, glossiness: 58 },
  { name: 'ХРОМ',           color: '#dfe4e9', transparency: 0,  reflection: 98, glossiness: 97 },
];

/** Families the Mirror tool refuses to touch: wall/slab/line are path-based geometry the
 *  tool doesn't transform (see startMirror's own doc comment); module (МОДУЛ) is excluded
 *  because a geometric mirror would flip its carcass without swapping handedness-specific
 *  left/right coverage params, which would be silently wrong. `solid` IS mirrorable — its
 *  own plane/path are mirrored as data (see mirrorPlane/mirrorWallPoints), not via a
 *  cosmetic scale flip. */
const MIRROR_EXCLUDED_FAMILIES = ['wall', 'slab', 'line', 'module'];

/** localStorage key the in-progress scene is autosaved under, so a refresh doesn't lose it. */
const AUTOSAVE_KEY = 'webcad-autosave-v1';
/** How often the autosave safety-net timer writes, in ms (also saved on `beforeunload`). */
const AUTOSAVE_INTERVAL_MS = 5000;
/** localStorage key the last opened/saved-as file's NAME is remembered under — unlike
 *  `savedFileHandle` itself (a live FileSystemFileHandle, which the browser never lets
 *  survive a reload — there is no API to persist or restore one), a plain string can,
 *  so the sidebar header and the За Хосе/За Мая export filenames keep using the right
 *  project name across a refresh instead of silently reverting to "scene". See
 *  `openedFileName`. */
const LAST_FILENAME_KEY = 'webcad-last-filename';
/** localStorage key the sidebar's collapsed/expanded state is remembered under — a pure
 *  workspace preference (not part of any one scene), so it lives alongside the other
 *  plain-string UI-state keys above rather than in buildSceneDoc/parseSceneJson. */
const SIDEBAR_COLLAPSED_KEY = 'webcad-sidebar-collapsed';
/** localStorage key the floating tool-button bar's collapsed/expanded state is
 *  remembered under — same rationale as SIDEBAR_COLLAPSED_KEY (a workspace preference,
 *  not scene content). */
const TOOLBAR_COLLAPSED_KEY = 'webcad-toolbar-collapsed';

/**
 * A Revit-style "temporary dimension" shown after clicking a wall's vertical face: the
 * live distance from that face to the nearest OTHER instance's surface along its
 * outward normal (`axis`), editable inline. Never touches ДЕБЕЛИНА (thickness) — the
 * search excludes the clicked wall's own geometry, so a self-hit (which would only ever
 * measure thickness) simply isn't found/shown at all.
 *  - 'translate' (a side face) — moves the WHOLE wall along `axis` so the gap becomes
 *    the typed value; the wall's own path/thickness are untouched.
 *  - 'vertex' (an end-cap face) — moves that one polyline endpoint along `axis`,
 *    shortening/extending the wall from that end.
 */
interface WallDim {
  instId: number;
  editKind: 'translate' | 'vertex';
  axis: THREE.Vector3;         // world unit vector, points from the clicked face toward the hit
  originPoint: THREE.Vector3;
  hitPoint: THREE.Vector3;
  dist: number;                // current mm distance (also the pre-edit value of valueStr)
  vertexIndex?: number;        // editKind === 'vertex': which path index to move
  screen: { x: number; y: number };
  valueStr: string;
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

  @ViewChild('navCubeCanvas', { static: true })
  navCubeCanvasRef!: ElementRef<HTMLCanvasElement>;

  // ── UI state ───────────────────────────────────────────────────────────────
  families   = FAMILIES;
  selectedFamilyId = FAMILIES[0].id;
  currentParams: Record<string, number> = {};
  currentMaterials: Record<string, string> = {};   // material picks for the "place new" panel

  /**
   * The scene's material library — the per-panel selects choose by name, and the
   * Materials dialog edits each one's look (color/transparency/reflection/glossiness),
   * which Render mode applies as PBR.
   */
  materialDefs: MaterialDef[] = DEFAULT_MATERIALS.map(m => ({ ...m }));

  // ── Materials dialog ──────────────────────────────────────────────────────────
  materialsDialogOpen = false;
  editingMaterialIndex = 0;

  // ── Schedule (Спецификация) preview dialog ───────────────────────────────────
  scheduleDialogOpen = false;

  // ── 2D plan/elevation view ──────────────────────────────────────────────────────
  /** '3D' = the normal perspective CAD view. Any other value is a true flattened 2D
   *  line drawing (orthographic camera locked to that plane, faces hidden, only the
   *  existing isEdge wireframe shown) — see setViewPlane. 'current' uses whatever
   *  Line/SOLID is selected's own construction plane. */
  viewPlane: MovePlane | '3D' | 'current' = '3D';

  // ── Visualisation menu / theme / settings ────────────────────────────────────
  /** Light vs dark UI theme; bound to the host so the SCSS variable overrides apply. */
  @HostBinding('class.light') lightTheme = false;
  visMenuOpen = false;            // the toolbar "Visualisation" dropdown
  settingsDialogOpen = false;     // the Settings dialog (camera brightness)
  cameraBrightness = 1.0;         // global light/exposure multiplier (0.2–2.0)
  /** Render lighting: true = directional key + soft shadows + ray-cast AO; false = flat,
   *  shadowless diffuse light from the environment only (no directional light). */
  directLight = true;
  bloomStrength = 0.35;           // glow strength on bright highlights, Render mode only (0–1)
  /** Escape hatch for the reflective floor (an extra scene render/frame) — off falls back to
   *  the plain matte floor at zero rebuild cost, in case it's too slow on a given GPU. */
  floorReflections = true;

  instances  = [] as SceneInstance[];
  selectedIds = new Set<number>();
  hoveredInst: SceneInstance | null = null;   // instance under the cursor in the 3D viewport — drives the bottom-left ТИП readout
  mode: InteractionMode = 'idle';
  modeLabel  = '';
  movePlane: MovePlane = 'XZ';
  isCopy  = false;  // active move-from/move-to op is a Copy
  isArray = false;  // active move-from/move-to op is an Array
  isMirror = false; // active move-from/move-to op is a Mirror
  arrayCount = 3;   // number of copies the Array tool lays down
  mirrorKeepOriginal = true;  // Mirror: add a mirrored copy (true) vs flip in place (false)
  itemize = false;  // schedule export: list every panel separately (drop БРОЙ) vs merged quantities
  fileMenuOpen = false;   // the sidebar File dropdown
  sceneSectionCollapsed = true;   // the sidebar "SCENE CONTENT" list — collapsed by default
  // The file this scene was last saved to (or opened from) via the File System Access
  // API — lets "Save" overwrite it silently. Null until a "Save as…"/Open succeeds with
  // that API, or in browsers that lack it (Firefox/Safari), where "Save" always falls
  // back to "Save as…" (a fresh download) since the page can't get write access otherwise.
  private savedFileHandle: FileSystemFileHandle | null = null;
  /** The last opened/saved-as file's NAME, independent of `savedFileHandle` — a plain
   *  string, so (unlike the handle itself) it survives a page reload via
   *  `LAST_FILENAME_KEY` (loaded once in `ngOnInit`). Set by `rememberFileName`
   *  whenever we genuinely learn a real file name: `loadSceneFile` (covers BOTH the
   *  File System Access open path and the classic `<input type=file>` fallback — both
   *  route through it) and `saveSceneAs`'s own success path. */
  private lastFileName: string | null = null;
  /** The currently tracked file's name, for the sidebar header AND for naming the
   *  За Хосе/За Мая exports (`projectBaseName`) — `savedFileHandle`'s own name when we
   *  still have live write access, else whatever `lastFileName` remembers (e.g. right
   *  after a reload, where the handle itself can never survive but the name can), else
   *  null for a scene that's never been opened or saved-as at all. A getter, not a
   *  parallel field, so there's nothing to keep in sync by hand at every assignment site. */
  get openedFileName(): string | null { return this.savedFileHandle?.name ?? this.lastFileName; }

  /** Remember a file name across reloads (see `lastFileName`'s own doc comment).
   *  `localStorage.setItem` can throw (storage full/disabled/private browsing) — this is
   *  a display nicety, not scene data, so just skip persisting it rather than fail the
   *  open/save it's attached to. */
  private rememberFileName(name: string) {
    this.lastFileName = name;
    try { localStorage.setItem(LAST_FILENAME_KEY, name); } catch { /* see doc comment */ }
  }
  /** Delivery address (sidebar field, under the project name) — free text, persisted
   *  in the scene JSON (see buildSceneDoc/parseSceneJson) and picked up by the Хосе
   *  .xlsx export's own "Адрес за доставка:" line (webcad-export-xlsx.ts). This app has
   *  no other client/project field, so it's entered here per project, once. */
  deliveryAddress = '';
  /** Sidebar collapsed (hidden entirely, viewport takes the full window width) — a
   *  workspace preference, not scene data, so it's remembered in localStorage
   *  (SIDEBAR_COLLAPSED_KEY, loaded once in ngOnInit) rather than the scene JSON. */
  sidebarCollapsed = false;
  toggleSidebar() {
    this.sidebarCollapsed = !this.sidebarCollapsed;
    try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, this.sidebarCollapsed ? '1' : '0'); } catch { /* display nicety only */ }
  }
  /** The floating tool-button bar (Move/Copy/Array/.../theme toggle, overlaying the top
   *  of the viewport) — same "workspace chrome, not scene data" rationale as
   *  sidebarCollapsed, so it's also localStorage-only. Minimizing it frees the top of
   *  the canvas for an unobstructed Render preview, same goal as the sidebar toggle. */
  toolbarCollapsed = false;
  toggleToolbar() {
    this.toolbarCollapsed = !this.toolbarCollapsed;
    try { localStorage.setItem(TOOLBAR_COLLAPSED_KEY, this.toolbarCollapsed ? '1' : '0'); } catch { /* display nicety only */ }
  }
  marqueeRect: { left: number; top: number; width: number; height: number } | null = null;
  // Distance editor shown next to the cursor during a move/copy/array.
  moveLabel: { x: number; y: number } | null = null;
  distanceStr = '';                 // value of the cursor distance input (mm)
  private distanceLocked = false;   // true once the user types — stop syncing it from the cursor
  private distFocusPending = false; // focus the distance input the first time it appears
  private moveDir = new THREE.Vector3();  // current in-plane direction moveFrom → cursor

  @ViewChild('distInput') private distInputRef?: ElementRef<HTMLInputElement>;
  @ViewChild('fileMenu') private fileMenuRef?: ElementRef<HTMLElement>;
  @ViewChild('visMenu') private visMenuRef?: ElementRef<HTMLElement>;
  @ViewChild('sceneFileInput') private sceneFileInputRef?: ElementRef<HTMLInputElement>;

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

  // Editing a finished wall: draggable vertex + segment handles on the selected wall.
  private wallHandleGroup: THREE.Group | null = null;
  private wallEdit: { instId: number; kind: 'vertex' | 'edge'; index: number } | null = null;
  private wallEditOrig: WallPoint[] | null = null;
  private readonly vtxHandleGeo  = new THREE.SphereGeometry(70, 16, 12);
  private readonly edgeHandleGeo = new THREE.SphereGeometry(48, 12, 10);
  private readonly vtxHandleMat  = new THREE.MeshBasicMaterial({ color: 0xffd400, depthTest: false, transparent: true, opacity: 0.95 });
  private readonly edgeHandleMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff, depthTest: false, transparent: true, opacity: 0.9 });

  // Temporary dimensions: click a selected wall's vertical face to see (and edit) its
  // live distance to the nearest OTHER instance's parallel surface — see WallDim above.
  wallDims: WallDim[] = [];
  private wallDimLine!: THREE.LineSegments;

  // ПЛОЧА (slab) draw tool — draws a CLOSED polygon, finalised into ONE instance.
  slabThickness = 40;         // mm, applies to the slab being drawn
  private slabPath: THREE.Vector3[] = [];        // committed world vertices of the current polygon

  // Line draw tool — generalises wall/slab to an arbitrary construction plane (picked
  // by hovering any existing surface, or a quick XZ/XY/YZ axis pick), drawing a
  // multi-segment polyline as ONE live-growing instance (wall's pattern, not slab's —
  // a Line can stay open indefinitely). Closing the loop (click back on the first
  // vertex) sets `closed = true` on that same instance; see `closeLine()`.
  lineExtrudeDepth = 18;       // mm, used when Extrude is clicked on a selected closed Line
  private linePath: THREE.Vector3[] = [];        // committed world vertices of the current polyline
  // Parallel to linePath (same indices): the world-space arc-mid-point for the segment
  // STARTING at that index, or null for a straight segment — kept alongside linePath
  // (not just folded into inst.path's local `arc` once) because addLinePoint rebuilds
  // `localPath` fresh from linePath on every call, same as it always has for x/z; this
  // is that same rebuild's source of truth for `arc`, not a one-off side effect.
  private lineArcMids: (THREE.Vector3 | null)[] = [];
  private lineInstanceId: number | null = null;  // the single instance growing as points are added
  private linePlane: PlaneDesc | null = null;    // committed once the plane-pick step finishes
  private linePlanePreview: PlaneDesc | null = null;  // live candidate while in 'line-plane' mode
  private planeGhost: THREE.Object3D | null = null;   // the translucent plane-pick indicator quad
  /** True from the single merged "Line"/"Edit" toolbar button's click until Esc (or
   *  re-clicking that same button) ends the whole session — covers every sub-mode
   *  ('line-plane', 'line-session', 'line-from', 'line-to', 'line-arc-mid',
   *  'circle-center', 'circle-radius'). The persistent Line/Circle/Curve/Delete panel
   *  (the Revit-"Draw"-panel-style UI) shows whenever this is true. Not `private`: the
   *  template reads it for the panel's `*ngIf` and the toolbar button's active state. */
  lineSessionActive = false;
  /** The existing Line instance this session is editing (segment select/delete
   *  target, AND the instance the panel's Line/Curve tools continue appending to — see
   *  `seedFromEditTarget`), or `null` for a fresh session with nothing to edit — set
   *  once by `startEditSession()`, read by `canDeleteSelectedSegments`/
   *  `deleteSelectedSegments` and by the mode-pill's Line/Edit label. Circle is the one
   *  exception: it's always a brand-new separate instance even during an Edit session
   *  (a closed shape has nothing to "continue" into — see `beginDrawCircle`). */
  lineSessionEditId: number | null = null;
  /** Segment indices of `lineSessionEditId`'s instance currently toggled on by
   *  clicking them in the viewport (while `mode === 'line-session'`) — removed
   *  together by the panel's Delete button (`deleteSelectedSegments`). */
  private selectedSegmentIndices = new Set<number>();
  /** The segment index currently under the cursor (while `mode === 'line-session'`),
   *  or `null` — a transient hover highlight, distinct from `selectedSegmentIndices`. */
  private hoverSegIndex: number | null = null;
  /** The point clicked first after the panel's Copy button starts a 2-click
   *  translate-copy ('copy-seg-from' → 'copy-seg-to') — the point FROM which the
   *  move is measured; the second click's point minus this one is the vector the
   *  duplicate segments translate by. `null` outside that flow. */
  private segmentCopyFrom: THREE.Vector3 | null = null;
  /** Live preview of the translated duplicate(s) while in 'copy-seg-to' — built fresh
   *  each mousemove by `updateSegmentCopyGhost`, same "transient, mode-scoped, cleaned
   *  up by cancelMode" pattern as `ghost`/`planeGhost`. */
  private segmentCopyGhost: THREE.Object3D | null = null;
  /** Degrees the panel's Rotate button swings a selected segment by per click, and
   *  which of its two endpoints stays fixed — both user-adjustable next to the
   *  button. See `rotateSelectedSegment`. */
  segmentRotateAngle = 15;
  segmentRotatePivot: 'start' | 'end' = 'end';
  /** Panel's Offset button — perpendicular distance (mm), which side, and whether to
   *  keep the original (new parallel run, like Copy) or move it in place. See
   *  `offsetSelectedSegment`. */
  segmentOffsetDistance = 50;
  segmentOffsetSide: 'left' | 'right' = 'right';
  segmentOffsetCopy = true;
  /** Panel's Trim button — optional fillet radius (mm) for the corner the two
   *  selected segments get trimmed/extended to meet at; 0 (or left blank) is a sharp
   *  corner. See `trimSelectedSegments`. */
  segmentTrimRadius = 0;
  /** Transient per-segment pick+highlight overlay for `lineSessionEditId`'s instance,
   *  built only while a line session with an edit target is active — see
   *  `buildSegmentOverlay`'s own doc comment. Cleaned up by `cancelMode`. */
  private segmentOverlay: THREE.Group | null = null;
  /** True while the Circle sub-tool (not plain Line) is running — set by startCircle(),
   *  read by commitLinePlane() to decide 'circle-center' vs 'line-from' next. Not
   *  `private`: the template reads it directly for the button's active/disabled state
   *  and the mode-pill label. */
  isDrawingCircle = false;
  private circleCenter: THREE.Vector3 | null = null;  // world point, set once 'circle-radius' begins
  /** True while the Curve sub-tool is running — every segment of THIS session is a
   *  3-point arc (no mixing within one Curve sketch). Also not `private`, same reason
   *  as `isDrawingCircle` above. */
  isDrawingCurve = false;
  private pendingArcMid: THREE.Vector3 | null = null;   // world point, set once 'line-arc-mid' begins
  /** "Edit"/append-while-drawing's next-segment toggle — shown whenever `mode ===
   *  'line-to'` (covers a fresh Curve draw AND a resumed Edit alike, since both use
   *  that same mode): true means the NEXT click pair draws a 3-point arc regardless of
   *  which tool started the session, independent of `isDrawingCurve`. This is what
   *  actually lets a gap left by Delete Segment be refilled with either kind. */
  lineNextSegmentCurved = false;
  /** Explicitly picked via "Select Current Plane" — drives the view-plane dropdown's
   *  'current' option. Falls back to the selected Line/SOLID's own `.plane` when null
   *  (setViewPlane), so picking one is additive, not a replacement for that. */
  currentPlane: PlaneDesc | null = null;
  private pickPlanePreview: PlaneDesc | null = null;  // live candidate while in 'pick-plane' mode

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
  // Widened from a strict PerspectiveCamera to support the 2D plan/elevation views
  // (viewPlane) below — the ~48 other reads of `this.camera` in this file only ever
  // touch base Camera/Object3D members (position/up/lookAt/project, and
  // THREE.Raycaster.setFromCamera, which already branches on camera type internally),
  // so only the handful of PerspectiveCamera-only reads (`.fov`, `.aspect`) need an
  // `instanceof THREE.PerspectiveCamera` guard — see setViewPlane/toggleRender/the
  // canvas ResizeObserver.
  private camera!: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private perspectiveCamera!: THREE.PerspectiveCamera;   // the one true 3D camera, never disposed
  private orthoCamera: THREE.OrthographicCamera | null = null;   // lazily built, reused/reconfigured
  private renderer!: THREE.WebGLRenderer;
  private controls!: OrbitControls;
  private animFrameId = 0;
  private resizeObserver!: ResizeObserver;
  private raycaster  = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private snapDot!: THREE.Mesh;
  private moveLine!: THREE.Line;   // 3D guide line drawn from moveFrom to the cursor during a move
  private ghost: THREE.Object3D | null = null;

  // ── Navigation cube (Revit-style view-align gizmo, top-right) ────────────────
  private navScene!: THREE.Scene;
  private navCamera!: THREE.OrthographicCamera;
  private navRenderer!: THREE.WebGLRenderer;
  private navCube!: THREE.Mesh;
  private navHoverFace = -1;
  private navTween: {
    target: THREE.Vector3; fromDir: THREE.Vector3; toDir: THREE.Vector3;
    quat: THREE.Quaternion; dist: number; start: number; dur: number;
  } | null = null;
  private boundNavMove!:  (e: MouseEvent) => void;
  private boundNavClick!: (e: MouseEvent) => void;
  private boundNavLeave!: () => void;
  // BoxGeometry's default material-group order is [+X, -X, +Y, -Y, +Z, -Z]
  private readonly NAV_FACE_DIRS = [
    new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0),
    new THREE.Vector3(0, 1, -0.02).normalize(), new THREE.Vector3(0, -1, -0.02).normalize(),
    new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, -1),
  ];
  private readonly NAV_FACE_LABELS = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'];

  // ── Render (photoreal preview) mode ──────────────────────────────────────────
  renderMode = false;
  private viewHelpers: THREE.Object3D[] = [];     // grid/axes/labels — hidden while rendering
  private ambientLight!: THREE.AmbientLight;
  private keyLight!: THREE.DirectionalLight;
  private fillLight!: THREE.DirectionalLight;
  private envTexture: THREE.Texture | null = null;  // cached PMREM environment (lazy)
  private renderFloor: THREE.Mesh | null = null;    // shadow-catching ground, only in render mode
  // Progressive-accumulation pipeline for Render mode: when the view is idle we average many
  // frames, jittering the camera sub-pixel (clean anti-aliasing) and the key light on a disc
  // (soft, realistic shadows). Uses only ordinary scene renders + HalfFloat targets — no
  // depth-texture sampling — so it's robust on integrated GPUs where screen-space AO silently
  // fails. Targets/quads are lazy-built (kept out of the initial bundle) and only run while
  // renderMode is on.
  private accumA: THREE.WebGLRenderTarget | null = null;   // running average (ping)
  private accumB: THREE.WebGLRenderTarget | null = null;   // running average (pong)
  private frameRT: THREE.WebGLRenderTarget | null = null;  // one jittered sample (MSAA)
  private accumBlendQuad: FullScreenQuad | null = null;    // accum = mix(accum, frame, 1/(n+1))
  private accumShowQuad: FullScreenQuad | null = null;     // tone-map + sRGB to screen
  private accumN = 0;                                       // samples accumulated for this view
  private readonly accumMax = 64;                           // stop refining after this many
  private accumDirty = true;                                // view/scene changed → restart
  private ppLoading = false;
  // Bloom: a quarter-res bright-pass + 2-tap-direction Gaussian blur, composited into
  // accumShowQuad's display shader (once per shown frame, not once per accumulated sample —
  // it runs on the already-averaged accumA). bloomBlurQuad is also reused, unmodified, by
  // the floor-reflection blur below (it's just a full-screen quad; only its uniforms/target
  // change between the two uses, both within the same synchronous frame).
  private bloomBright: THREE.WebGLRenderTarget | null = null;
  private bloomA: THREE.WebGLRenderTarget | null = null;
  private bloomB: THREE.WebGLRenderTarget | null = null;
  private bloomExtractQuad: FullScreenQuad | null = null;
  private bloomBlurQuad: FullScreenQuad | null = null;
  // Reflective floor (Render mode): THREE.Reflector does the proven, hard part (mirrored
  // camera, self-visibility hiding, oblique clip plane); only its shader is swapped for one
  // that blends a pre-blurred copy of its reflection (softer, satin look, not a sharp mirror)
  // with a dark base tint via a view-angle Fresnel term. floorShadowCatcher is a second,
  // coplanar THREE.ShadowMaterial mesh that composites the existing per-sample shadow-mapped
  // AO/contact-shadow look on top, since a raw custom ShaderMaterial doesn't receive shadows.
  private floorReflector: Reflector | null = null;
  private floorShadowCatcher: THREE.Mesh | null = null;
  private floorBlurA: THREE.WebGLRenderTarget | null = null;
  private floorBlurB: THREE.WebGLRenderTarget | null = null;
  private floorLoading = false;
  private keyLightBase = new THREE.Vector3();               // un-jittered key-light position
  private sunDir = new THREE.Vector3();                     // normalised sun direction (direct mode)
  private sunPerpA = new THREE.Vector3();                   // + two tangents, for the soft-sun cone
  private sunPerpB = new THREE.Vector3();
  private _sampleDir = new THREE.Vector3();                 // scratch
  // HDRI environment: PMREM env map drives reflections (envTexture); the raw float equirect is
  // kept for CPU direction sampling, so each accumulation frame can light the scene from one
  // hemisphere direction coloured by the HDRI and shadow-mapped — averaged, that is ray-cast
  // ambient occlusion + accurate image-based lighting, using only shadow maps (Iris-Xe-safe).
  private hdriData: { data: Float32Array; w: number; h: number } | null = null;
  private hdriLoading = false;
  // Screen-space ambient occlusion (Render mode): the one thing the sampled-shadow AO
  // above can't do — darken a lone convex edge/corner that has nothing nearby to
  // geometrically occlude it, the way a real render reads extra contrast right at a
  // seam between two faces. Built from Three's own maintained SSAOPass/SSAOShader
  // (lazy-imported, same convention as Reflector/HDRLoader above), computed once per
  // SHOWN frame (unlike the per-sample hemisphere lights — AO only depends on camera +
  // geometry, not on which light direction renderAccum is sampling) and fed into
  // accumShowQuad as a multiplicative `tAO` term.
  //
  // This is the one place in this whole pipeline that samples a depth texture —
  // deliberately avoided everywhere else (see the accumulation-pipeline comment above)
  // because it can silently misbehave on some integrated GPUs. So it's gated behind a
  // runtime smoke test (ensureSSAO/verifySSAO): WebGL2-only up front (depth textures are
  // core spec there, not the flakier optional WebGL1 extension), then real passes against
  // the actual scene are read back — a uniformly flat result (every sampled texel
  // identical, what a broken depth read tends to produce, since the shader's per-sample
  // occlusion test then fails the same way everywhere) counts as a failed attempt;
  // several in a row and SSAO quietly turns itself off for the rest of the session,
  // falling back to exactly today's no-SSAO look. A single real success locks it on.
  ssaoEnabled = true;                            // user-facing checkbox (Settings dialog)
  private ssaoPass: SSAOPass | null = null;
  private ssaoSupported: boolean | null = null;  // null = not yet confirmed; see verifySSAO
  private ssaoFailCount = 0;
  private ssaoLoading = false;
  private ssaoReadbackRT: THREE.WebGLRenderTarget | null = null;  // tiny UnsignedByte copy target, for both
                                                                    // the pass's own unused "output" copy and
                                                                    // the smoke-test readback (see verifySSAO)
  private ssaoCopyQuad: FullScreenQuad | null = null;
  private whiteTex: THREE.DataTexture | null = null;   // accumShowQuad's tAO default — a no-op "no AO" map
  private objectMap = new Map<number, THREE.Object3D>();
  private nextId = 1;
  private nextSolidNum = 1;   // drives generic "SOLID N" labeling — separate from nextId (see webcad.model.ts's SceneSnapshot doc)
  private moveFrom    = new THREE.Vector3();
  private moveOrigins = new Map<number, THREE.Vector3>(); // id → original world position
  private moveOriginRot = new Map<number, number>();       // id → original rotY (Mirror's cancel-restore)
  private moveOriginMirrored = new Map<number, boolean>(); // id → original `mirrored` flag (ditto)
  private copyGhosts  = new Map<number, THREE.Object3D>(); // id → translucent preview during a Copy/Mirror

  // Undo history (snapshots of the data model, most-recent last).
  private undoStack: SceneSnapshot[] = [];
  private pendingSnapshot: SceneSnapshot | null = null;   // captured at edit-start, recorded on first change
  private readonly UNDO_LIMIT = 50;

  private mouseDownAt  = { x: 0, y: 0 };
  private marqueeStart = { x: 0, y: 0 };
  private isMarqueeing = false;
  private orbiting = false;                 // Shift + middle-drag orbit while a tool is active
  private orbitPrev = { x: 0, y: 0 };
  private customOrbiting = false;           // idle right-drag orbit pivoting on the selection's centre
  private customOrbitPrev = { x: 0, y: 0 };
  private readonly customOrbitPivot = new THREE.Vector3();
  private customOrbitPhi = 0;               // tracks tilt-from-pivot this drag, to clamp like OrbitControls does

  private boundClick!: (e: MouseEvent) => void;
  private boundMove!:  (e: MouseEvent) => void;
  private boundDown!:  (e: MouseEvent) => void;
  private boundUp!:    (e: MouseEvent) => void;
  private boundWheel!: (e: WheelEvent) => void;
  private boundCanvasLeave!: () => void;

  // Autosave: keeps the in-progress scene alive across an accidental refresh/tab close.
  // Independent of Save/Save as/Open — it just mirrors whatever is currently on screen.
  private boundBeforeUnload!: () => void;
  private autosaveIntervalId = 0;
  private autosaveDebounceId = 0;   // short debounce after each change — see pushHistory

  constructor(private ngZone: NgZone) {}

  ngOnInit() {
    this.resetParams();
    try { this.lastFileName = localStorage.getItem(LAST_FILENAME_KEY); } catch { /* see rememberFileName's doc comment */ }
    try { this.sidebarCollapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1'; } catch { /* display nicety only */ }
    try { this.toolbarCollapsed = localStorage.getItem(TOOLBAR_COLLAPSED_KEY) === '1'; } catch { /* display nicety only */ }
    this.ngZone.runOutsideAngular(() => this.initThree());
    this.restoreAutosave();
    this.boundBeforeUnload = () => this.persistAutosave();
    window.addEventListener('beforeunload', this.boundBeforeUnload);
    this.ngZone.runOutsideAngular(() => {
      this.autosaveIntervalId = window.setInterval(() => this.persistAutosave(), AUTOSAVE_INTERVAL_MS);
    });
  }

  ngOnDestroy() {
    window.removeEventListener('beforeunload', this.boundBeforeUnload);
    clearInterval(this.autosaveIntervalId);
    cancelAnimationFrame(this.animFrameId);
    this.resizeObserver?.disconnect();
    const cv = this.canvasRef.nativeElement;
    cv.removeEventListener('click',     this.boundClick);
    cv.removeEventListener('mousemove', this.boundMove);
    cv.removeEventListener('mousedown', this.boundDown);
    cv.removeEventListener('mouseup',   this.boundUp);
    cv.removeEventListener('wheel',     this.boundWheel);
    cv.removeEventListener('mouseleave', this.boundCanvasLeave);
    const navCv = this.navCubeCanvasRef?.nativeElement;
    navCv?.removeEventListener('mousemove',  this.boundNavMove);
    navCv?.removeEventListener('click',      this.boundNavClick);
    navCv?.removeEventListener('mouseleave', this.boundNavLeave);
    this.navCube?.geometry.dispose();
    (this.navCube?.material as THREE.MeshBasicMaterial[] | undefined)?.forEach(m => { m.map?.dispose(); m.dispose(); });
    this.navRenderer?.dispose();
    this.accumA?.dispose(); this.accumB?.dispose(); this.frameRT?.dispose();
    this.accumBlendQuad?.dispose(); this.accumShowQuad?.dispose();
    this.bloomBright?.dispose(); this.bloomA?.dispose(); this.bloomB?.dispose();
    this.bloomExtractQuad?.dispose(); this.bloomBlurQuad?.dispose();
    this.floorReflector?.dispose();
    this.floorBlurA?.dispose(); this.floorBlurB?.dispose();
    this.ssaoPass?.dispose();
    this.ssaoReadbackRT?.dispose(); this.ssaoCopyQuad?.dispose(); this.whiteTex?.dispose();
    if (this.floorShadowCatcher) { this.floorShadowCatcher.geometry.dispose(); (this.floorShadowCatcher.material as THREE.Material).dispose(); }
    this.bumpTexBySize.forEach(t => t.dispose());
    this.customBumpCache.forEach(t => t.dispose());
    this.moveLine?.geometry.dispose();
    (this.moveLine?.material as THREE.Material | undefined)?.dispose();
    this.measureLine?.geometry.dispose();
    (this.measureLine?.material as THREE.Material | undefined)?.dispose();
    this.wallDimLine?.geometry.dispose();
    (this.wallDimLine?.material as THREE.Material | undefined)?.dispose();
    this.renderer?.dispose();
    this.envTexture?.dispose();
    if (this.renderFloor) { this.renderFloor.geometry.dispose(); (this.renderFloor.material as THREE.Material).dispose(); }
    this.objectMap.forEach(o => disposeObj(o));
    this.copyGhosts.forEach(g => disposeObj(g));
    this.removeWallHandles();
    this.vtxHandleGeo.dispose(); this.edgeHandleGeo.dispose();
    this.vtxHandleMat.dispose(); this.edgeHandleMat.dispose();
    this.clearTextureCache();
  }

  toggleFileMenu() { this.fileMenuOpen = !this.fileMenuOpen; }

  /** Close the File / Visualisation menus when clicking anywhere outside them. */
  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent) {
    if (this.fileMenuOpen && this.fileMenuRef &&
        !this.fileMenuRef.nativeElement.contains(e.target as Node)) {
      this.fileMenuOpen = false;
    }
    if (this.visMenuOpen && this.visMenuRef &&
        !this.visMenuRef.nativeElement.contains(e.target as Node)) {
      this.visMenuOpen = false;
    }
  }

  @HostListener('document:keydown', ['$event'])
  onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      this.cancelMode(); this.fileMenuOpen = false; this.visMenuOpen = false;
      this.materialsDialogOpen = false; this.settingsDialogOpen = false; this.scheduleDialogOpen = false; return;
    }

    const t = e.target as HTMLElement | null;
    const inField = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);

    // Enter finishes an in-progress polyline tool (closes a slab / ends a wall or
    // line run — 'line-plane' is excluded, Enter means nothing before a plane exists).
    if (e.key === 'Enter' && !inField &&
        (this.mode === 'slab-from' || this.mode === 'slab-to' || this.mode === 'wall-from' || this.mode === 'wall-to' ||
         this.mode === 'line-from' || this.mode === 'line-to')) {
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

  /** Live instance objects for the current multi-selection (in no particular order). */
  private get multiSelectedInstances(): SceneInstance[] {
    const out: SceneInstance[] = [];
    this.selectedIds.forEach(id => {
      const inst = this.instances.find(i => i.id === id);
      if (inst) out.push(inst);
    });
    return out;
  }

  /**
   * When 2+ instances are selected and they're ALL the same family, that family's def —
   * drives the "common parameters" grid, letting one edit apply to every selected
   * instance at once. Null (no grid shown) for a mixed-family selection, since params
   * differ per family.
   */
  get multiSelectFamilyDef(): FamilyDef | null {
    const insts = this.multiSelectedInstances;
    if (insts.length < 2) return null;
    const familyId = insts[0].familyId;
    return insts.every(i => i.familyId === familyId) ? this.getFamilyDef(familyId) : null;
  }

  /** This param's shared value across the whole multi-selection, or null if they differ (shown as an empty input). */
  multiParamValue(key: string): number | null {
    const insts = this.multiSelectedInstances;
    if (insts.length === 0) return null;
    const first = insts[0].params[key];
    return insts.every(i => i.params[key] === first) ? first : null;
  }

  /** This toggle param's shared state across the whole multi-selection — 'mixed' shows an indeterminate checkbox. */
  multiToggleState(key: string): 'on' | 'off' | 'mixed' {
    const insts = this.multiSelectedInstances;
    if (insts.length === 0) return 'off';
    const first = insts[0].params[key] === 1;
    return insts.every(i => (i.params[key] === 1) === first) ? (first ? 'on' : 'off') : 'mixed';
  }

  /** Rebuild one instance in place, keeping its selection highlight (CAD mode). */
  private rebuildInstanceKeepingSelection(inst: SceneInstance) {
    const old = this.objectMap.get(inst.id);
    if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
    this.spawnObject(inst);
    if (!this.renderMode) {
      const obj = this.objectMap.get(inst.id)!;
      colorObj(obj, COLOR_SELECTED);
      setEdgeColor(obj, EDGE_SELECTED);
    }
  }

  /** Multi-select number input: apply one value to this param on every selected instance. */
  setMultiParam(key: string, value: number | null) {
    if (value === null || !Number.isFinite(value)) return;   // cleared/invalid while typing — wait for a real number
    this.commitPendingEdit();
    this.multiSelectedInstances.forEach(inst => {
      inst.params[key] = value;
      this.rebuildInstanceKeepingSelection(inst);
    });
    this.accumDirty = true;
  }

  /** Multi-select checkbox: apply the same checked state to this toggle on every selected instance. */
  setMultiToggleParam(key: string, checked: boolean) {
    this.commitPendingEdit();
    this.multiSelectedInstances.forEach(inst => {
      this.setToggleParam(inst.params, key, checked);
      this.rebuildInstanceKeepingSelection(inst);
    });
    this.accumDirty = true;
  }

  /** This МАТЕРИАЛИ key's shared value across the whole multi-selection, or null if they differ. */
  multiMaterialValue(key: string): string | null {
    const insts = this.multiSelectedInstances;
    if (insts.length === 0) return null;
    const first = this.materialOf(insts[0], key);
    return insts.every(i => this.materialOf(i, key) === first) ? first : null;
  }

  /** Multi-select material picker: apply one material to this key on every selected instance. */
  setMultiMaterial(key: string, value: string) {
    this.commitPendingEdit();
    this.multiSelectedInstances.forEach(inst => {
      if (!inst.materials) inst.materials = {};
      inst.materials[key] = value;
      if (this.renderMode) {
        const obj = this.objectMap.get(inst.id);
        if (obj) this.applyRenderMaterials(obj, inst);
      }
    });
    if (this.renderMode) this.accumDirty = true;
  }

  /** Like materialParamVisible, but for a multi-selection: shown only while EVERY selected
   *  instance has that ПОЛИЦА's toggle checked (mirrors multiToggleState's 'on' semantics). */
  multiMaterialParamVisible(mp: MaterialParamDef): boolean {
    const shelf = /^ПОЛИЦА_(\d+)_(?:КАНТ_)?МАТЕРИАЛ$/.exec(mp.key);
    return !shelf || this.multiToggleState(`С_ПОЛИЦА_${shelf[1]}`) === 'on';
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
    { title: 'ПОЛИЦИ',         prefix: 'ПОЛИЦА' },
  ];
  /** Params forced into a specific section by exact label, overriding prefix matching
   *  — РЕБРА ШИРИНА and the ТАВАН-vs-РЕБРА-shared edge-band toggles all belong with
   *  ТАВАН even though their own labels don't start with that prefix; the С ПОЛИЦА n
   *  toggles would otherwise match the generic 'С ' section ahead of 'ПОЛИЦИ'. */
  private readonly SECTION_OVERRIDE = new Map<string, string>([
    ['РЕБРА ШИРИНА', 'ТАВАН'],
    ['РЕБРО ТАВАН 1 С КАНТ ОТПРЕД', 'ТАВАН'],
    ['РЕБРО ТАВАН 2 С КАНТ ОТПРЕД', 'ТАВАН'],
    ['ДВОЙНА ВРАТИЧКА', 'ВРАТИЧКА'],
    ['ДВОЙНА ВРАТИЧКА С ВЕРТИКАЛНА ФУГА', 'ВРАТИЧКА'],
    ['ЛЯВА ВРАТИЧКА ШИРИНА', 'ВРАТИЧКА'],
    ['ФУГА МЕЖДУ ВРАТИЧКИ', 'ВРАТИЧКА'],
    ['ДВОЕН ГРЪБ', 'ГРЪБ'],
    ['ВИСОЧИНА ГОРЕН ГРЪБ', 'ГРЪБ'],
    ['ШИРИНА ЛЯВ ГРЪБ', 'ГРЪБ'],
    ...Array.from({ length: 10 }, (_, i) => [`С ПОЛИЦА ${i + 1}`, 'ПОЛИЦИ'] as [string, string]),
  ]);
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
      const overrideTitle = this.SECTION_OVERRIDE.get(p.label);
      const sec = this.UNGROUPED_PARAMS.has(p.label)
        ? null
        : overrideTitle
        ? this.PARAM_SECTIONS.find(s => s.title === overrideTitle)
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

  /**
   * The ТАВАН section mixes params for the full-panel mode with ones for the mutually-
   * exclusive ribs mode (РЕБРА_ШИРИНА, РЕБРО ТАВАН 1/2 С КАНТ ОТПРЕД) — split it into
   * two sub-groups (divided by a line in the template) so the two modes read as
   * distinct, instead of one undifferentiated list.
   */
  tavanSplit(params: ParamDef[]): { tavan: ParamDef[]; rebra: ParamDef[] } {
    return {
      tavan: params.filter(p => p.label.startsWith('ТАВАН')),
      rebra: params.filter(p => !p.label.startsWith('ТАВАН')),
    };
  }

  /**
   * ПОЛИЦА n's МАТЕРИАЛ/КАНТ МАТЕРИАЛ only make sense once that shelf exists — hide
   * the pair in the МАТЕРИАЛИ section until the matching С_ПОЛИЦА_n toggle is checked.
   * Every other material param (no shelf involved) is always shown.
   */
  materialParamVisible(mp: MaterialParamDef, params: Record<string, number>): boolean {
    const shelf = /^ПОЛИЦА_(\d+)_(?:КАНТ_)?МАТЕРИАЛ$/.exec(mp.key);
    return !shelf || params[`С_ПОЛИЦА_${shelf[1]}`] === 1;
  }

  /**
   * ЛЯВА ВРАТИЧКА ШИРИНА, ДВОЙНА ВРАТИЧКА С ВЕРТИКАЛНА ФУГА and ФУГА МЕЖДУ ВРАТИЧКИ only
   * matter once ДВОЙНА ВРАТИЧКА is checked; ГРЪБ С ХОРИЗОНТАЛНА ФУГА only matters once
   * ДВОЕН ГРЪБ is checked — same reasoning, same pattern, independent "double" toggle
   * (the second leaf always takes whatever space is left over, and there's no second
   * leaf — so no fugue orientation/width — otherwise). Every other param is always shown.
   */
  private static readonly DOUBLE_LEAF_GATE = new Map<string, string>([
    ['ЛЯВА_ВРАТИЧКА_ШИРИНА', 'ДВОЙНА_ВРАТИЧКА'],
    ['ДВОЙНА_ВРАТИЧКА_С_ВЕРТИКАЛНА_ФУГА', 'ДВОЙНА_ВРАТИЧКА'],
    ['ФУГА_МЕЖДУ_ВРАТИЧКИ', 'ДВОЙНА_ВРАТИЧКА'],
    ['ГРЪБ_С_ХОРИЗОНТАЛНА_ФУГА', 'ДВОЕН_ГРЪБ'],
  ]);

  paramRowVisible(p: ParamDef, params: Record<string, number>): boolean {
    // ВИСОЧИНА_ГОРЕН_ГРЪБ/ШИРИНА_ЛЯВ_ГРЪБ (unlike ЛЯВА_ВРАТИЧКА_ШИРИНА, which is reused
    // and relabelled for either orientation — see paramLabel below) are each their OWN
    // dedicated size param, so only the one matching the CURRENT split direction is
    // shown — the other would size a leaf that doesn't exist in that orientation.
    if (p.key === 'ВИСОЧИНА_ГОРЕН_ГРЪБ') return params['ДВОЕН_ГРЪБ'] === 1 && params['ГРЪБ_С_ХОРИЗОНТАЛНА_ФУГА'] === 1;
    if (p.key === 'ШИРИНА_ЛЯВ_ГРЪБ')     return params['ДВОЕН_ГРЪБ'] === 1 && params['ГРЪБ_С_ХОРИЗОНТАЛНА_ФУГА'] !== 1;
    const gate = AdminPageComponent.DOUBLE_LEAF_GATE.get(p.key);
    return !gate || params[gate] === 1;
  }

  /** Multi-select version: visible only while EVERY selected instance agrees on the relevant toggle(s). */
  multiParamRowVisible(p: ParamDef): boolean {
    if (p.key === 'ВИСОЧИНА_ГОРЕН_ГРЪБ') return this.multiToggleState('ДВОЕН_ГРЪБ') === 'on' && this.multiToggleState('ГРЪБ_С_ХОРИЗОНТАЛНА_ФУГА') === 'on';
    if (p.key === 'ШИРИНА_ЛЯВ_ГРЪБ')     return this.multiToggleState('ДВОЕН_ГРЪБ') === 'on' && this.multiToggleState('ГРЪБ_С_ХОРИЗОНТАЛНА_ФУГА') !== 'on';
    const gate = AdminPageComponent.DOUBLE_LEAF_GATE.get(p.key);
    return !gate || this.multiToggleState(gate) === 'on';
  }

  /**
   * ЛЯВА ВРАТИЧКА ШИРИНА sizes whichever leaf comes first in ДВОЙНА_ВРАТИЧКА's split —
   * the LEFT leaf when the fugue is vertical (default), the TOP leaf when it's
   * horizontal (see korpusPanels, webcad-geometry.ts) — relabel the row so it reads as
   * a height, not a width, once ДВОЙНА_ВРАТИЧКА_С_ВЕРТИКАЛНА_ФУГА is unchecked.
   */
  paramLabel(p: ParamDef, params: Record<string, number>): string {
    return p.key === 'ЛЯВА_ВРАТИЧКА_ШИРИНА' && params['ДВОЙНА_ВРАТИЧКА_С_ВЕРТИКАЛНА_ФУГА'] === 0
      ? 'ГОРНА ВРАТИЧКА ВИСОЧИНА' : p.label;
  }

  /** Multi-select version: relabels only while EVERY selected instance has the horizontal fugue. */
  multiParamLabel(p: ParamDef): string {
    return p.key === 'ЛЯВА_ВРАТИЧКА_ШИРИНА' && this.multiToggleState('ДВОЙНА_ВРАТИЧКА_С_ВЕРТИКАЛНА_ФУГА') === 'off'
      ? 'ГОРНА ВРАТИЧКА ВИСОЧИНА' : p.label;
  }

  /**
   * Set a toggle param, enforcing the С_РЕБРА / С_ТАВАН mutual exclusivity (МОДУЛ
   * builds either a full ТАВАН panel or ribs, never both — checking one unchecks the
   * other). A no-op pass-through for every other toggle key.
   */
  setToggleParam(params: Record<string, number>, key: string, checked: boolean) {
    params[key] = checked ? 1 : 0;
    if (checked && key === 'С_РЕБРА') params['С_ТАВАН'] = 0;
    if (checked && key === 'С_ТАВАН') params['С_РЕБРА'] = 0;
  }

  // ── Family picker ──────────────────────────────────────────────────────────

  onFamilyChange() { this.resetParams(); }

  private resetParams() {
    this.currentParams = {};
    for (const p of this.selectedFamily.params) this.currentParams[p.key] = p.defaultValue;
    this.currentMaterials = {};
    for (const mp of this.selectedFamily.materialParams ?? []) this.currentMaterials[mp.key] = mp.default;
  }

  // ── Materials (МАТЕРИАЛИ section) ────────────────────────────────────────────

  /** Every material name selectable in the scene: the library plus any already in use. */
  get availableMaterials(): string[] {
    const set = new Set<string>(this.materialDefs.map(m => m.name));
    for (const inst of this.instances) {
      if (inst.material && inst.material.trim()) set.add(inst.material.trim());
      if (inst.materials) for (const v of Object.values(inst.materials)) if (v) set.add(v);
    }
    return [...set];
  }

  /** Look up a library material by name (used by Render mode to read its look). */
  private materialDef(name: string | undefined): MaterialDef | undefined {
    return name ? this.materialDefs.find(m => m.name === name) : undefined;
  }

  // Cache the loaded THREE.Texture per (image + tile size) so all faces using a material
  // share one GPU texture; cleared (and disposed) whenever a material is edited.
  private textureCache = new Map<string, THREE.Texture>();

  /**
   * The repeating THREE.Texture for a material, scaled so one image tile spans
   * `textureW × textureH` mm (panel UVs from ExtrudeGeometry are in model-space mm).
   * `extraRotationDeg` adds to the material's own ЗАВЪРТАНЕ НА ТЕКСТУРАТА (Materials
   * dialog) — used by a panel's own *_ЗАВЪРТЯН_ФЛАДЕР toggle (see `panelGrainRotation`) so one
   * specific panel's wood grain can run the other way without affecting every other
   * panel sharing that material. Returns null when the material has no texture.
   */
  private materialTexture(def: MaterialDef | undefined, extraRotationDeg = 0): THREE.Texture | null {
    if (!def?.texture) return null;
    const w = def.textureW && def.textureW > 0 ? def.textureW : 1000;
    const h = def.textureH && def.textureH > 0 ? def.textureH : 1000;
    const rot = (((def.textureRotation ?? 0) + extraRotationDeg) * Math.PI) / 180;
    const key = `${w}x${h}@${rot}|${def.texture}`;
    let tex = this.textureCache.get(key);
    if (!tex) {
      tex = new THREE.TextureLoader().load(def.texture);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.repeat.set(1 / w, 1 / h);
      tex.center.set(0.5, 0.5);   // rotate about the tile centre, not the corner
      tex.rotation = rot;
      this.textureCache.set(key, tex);
    }
    return tex;
  }

  private clearTextureCache() {
    this.textureCache.forEach(t => t.dispose());
    this.textureCache.clear();
    // Custom bump images too (a replaced/removed one would otherwise leak its old GPU
    // texture for the rest of the session) — NOT the procedural noise cache
    // (bumpTexBySize/bumpCanvas): that one is generic, not tied to any one material, so
    // it has nothing to go stale.
    this.customBumpCache.forEach(t => t.dispose());
    this.customBumpCache.clear();
  }

  // ── Materials dialog ──────────────────────────────────────────────────────────

  toggleMaterials() { this.materialsDialogOpen = !this.materialsDialogOpen; }
  closeMaterials() { this.materialsDialogOpen = false; }

  get editingMaterial(): MaterialDef | undefined { return this.materialDefs[this.editingMaterialIndex]; }
  selectEditingMaterial(i: number) { this.editingMaterialIndex = i; }

  /** Re-skin the scene live while editing a material: full PBR rebuild in Render mode, or
   *  just the flat colour indication in CAD mode. */
  onMaterialEdited() {
    this.clearTextureCache();   // a texture/tile change must rebuild the GPU texture
    if (this.renderMode) { this.refreshAllObjects(); return; }
    this.objectMap.forEach((obj, id) => {
      const inst = this.instances.find(i => i.id === id);
      if (inst && !this.selectedIds.has(id)) this.cadColorObj(obj, inst);   // keep selected ones blue
    });
  }

  /** Add a fresh material to the library (unique name) and select it for editing. */
  addMaterial() {
    let n = 1, name = 'НОВ МАТЕРИАЛ';
    const names = new Set(this.materialDefs.map(m => m.name));
    while (names.has(name)) name = `НОВ МАТЕРИАЛ ${++n}`;
    this.materialDefs.push({ name, color: '#cccccc', transparency: 0, reflection: 10, glossiness: 50 });
    this.editingMaterialIndex = this.materialDefs.length - 1;
  }

  /** Load a chosen image file as the editing material's texture (read as a data URL). */
  onTextureFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const def = this.editingMaterial;
    if (!file || !def) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.ngZone.run(() => {
        def.texture = String(reader.result);
        if (!def.textureW) def.textureW = 1000;   // sensible default tile size (mm)
        if (!def.textureH) def.textureH = 1000;
        this.onMaterialEdited();
      });
    };
    reader.readAsDataURL(file);
    input.value = '';   // allow re-picking the same file
  }

  /** Remove the editing material's texture (back to a plain colour). */
  clearMaterialTexture() {
    const def = this.editingMaterial;
    if (!def) return;
    def.texture = undefined;
    this.onMaterialEdited();
  }

  /** Load a chosen image file as the editing material's bump map (Релеф текстура — see
   *  `resolveBumpTexture`'s own doc comment). Any image works (only its red channel is
   *  sampled), but a true grayscale height map is the convention. Replacing the built-in
   *  procedural noise is optional — `bump` (the intensity slider) still has to be above
   *  0 for this to show at all, same as the noise it replaces. */
  onBumpTextureFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    const def = this.editingMaterial;
    if (!file || !def) return;
    const reader = new FileReader();
    reader.onload = () => {
      this.ngZone.run(() => {
        def.bumpTexture = String(reader.result);
        this.onMaterialEdited();
      });
    };
    reader.readAsDataURL(file);
    input.value = '';   // allow re-picking the same file
  }

  /** Remove the editing material's custom bump image — falls back to the built-in
   *  procedural noise, not to no relief at all (see `resolveBumpTexture`). */
  clearMaterialBumpTexture() {
    const def = this.editingMaterial;
    if (!def) return;
    def.bumpTexture = undefined;
    this.onMaterialEdited();
  }

  /** Snap the texture-rotation slider to the nearest 45° increment when within 6°. */
  snapTextureRotation(deg: number): number {
    const nearest = Math.round(deg / 45) * 45;
    return Math.abs(deg - nearest) <= 6 ? nearest : deg;
  }

  /**
   * Pixel size of the texture preview frame, matching the Ш×В tile aspect ratio and
   * fitted inside a fixed max box so it never overflows the dialog. The rotating inner
   * image is sized to the box diagonal (`texPreviewInner`) so it always covers the frame.
   */
  private readonly TEX_PREVIEW_MAX = { w: 200, h: 150 };
  texPreviewSize(def: MaterialDef): { w: number; h: number } {
    const tw = def.textureW && def.textureW > 0 ? def.textureW : 1000;
    const th = def.textureH && def.textureH > 0 ? def.textureH : 1000;
    const { w: maxW, h: maxH } = this.TEX_PREVIEW_MAX;
    const ratio = tw / th;
    let w = maxW, h = maxW / ratio;
    if (h > maxH) { h = maxH; w = maxH * ratio; }
    return { w: Math.round(w), h: Math.round(h) };
  }
  /** Inner-image side ≥ the max frame diagonal, so it covers the frame at any rotation. */
  get texPreviewInner(): number {
    const { w, h } = this.TEX_PREVIEW_MAX;
    return Math.ceil(Math.hypot(w, h));
  }

  /** Remove a material from the library (keeps at least one); instances keep their name. */
  deleteMaterial(i: number) {
    if (this.materialDefs.length <= 1) return;
    this.materialDefs.splice(i, 1);
    this.editingMaterialIndex = Math.min(this.editingMaterialIndex, this.materialDefs.length - 1);
    this.onMaterialEdited();
  }

  /** The current material chosen for `key` on an instance (defaults to blank). */
  materialOf(inst: SceneInstance, key: string): string { return inst.materials?.[key] ?? ''; }

  /** Assign a per-panel material on the selected instance, and (in Render mode) show it at once. */
  setMaterial(key: string, value: string) {
    const inst = this.selectedInstance;
    if (!inst) return;
    if (!inst.materials) inst.materials = {};
    inst.materials[key] = value;
    this.commitPendingEdit();
    if (this.renderMode) {
      const obj = this.objectMap.get(inst.id);
      if (obj) { this.applyRenderMaterials(obj, inst); this.accumDirty = true; }  // re-skin live
    }
    // In CAD mode the edited object is selected (blue); its new material colour shows on
    // deselect, when applySelect re-tints it via cadColorObj.
  }

  /** Fill in any МАТЕРИАЛИ keys this instance is missing (from the family defaults). */
  private backfillMaterials(inst: SceneInstance): boolean {
    const mps = this.getFamilyDef(inst.familyId).materialParams;
    if (!mps) return false;
    if (!inst.materials) inst.materials = {};
    let changed = false;
    for (const mp of mps) if (!(mp.key in inst.materials)) { inst.materials[mp.key] = mp.default; changed = true; }
    return changed;
  }

  // ── Placement ──────────────────────────────────────────────────────────────

  startPlacing() {
    this.cancelMode();
    this.removeWallHandles();
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
      materials: { ...this.currentMaterials },
      x: pos.x, y: 0, z: pos.z, rotY: 0,
      anchor: { ...PLACE_ANCHOR },   // РАЗРЕЗ = bottom → the object rests on the ground at y=0
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
    if (inst.familyId === 'line' && inst.path && inst.path.length >= 2 && inst.plane) {
      if (!inst.extraPaths || inst.extraPaths.length === 0) {
        return buildLinePath(inst.path, inst.closed ?? false, inst.plane);
      }
      // "Disjoined" Line (has extra runs from a segment Copy) — render the main path
      // plus every extra run, all on the same shared plane, grouped as one object so
      // the whole thing still moves/selects/highlights as a single instance.
      const group = new THREE.Group();
      group.add(buildLinePath(inst.path, inst.closed ?? false, inst.plane));
      for (const run of inst.extraPaths) {
        if (run.pts.length >= 2) group.add(buildLinePath(run.pts, run.closed, inst.plane));
      }
      return group;
    }
    if (inst.familyId === 'solid' && inst.solidOp === 'sweep' &&
        inst.path && inst.path.length >= 3 && inst.pathPoints && inst.pathPoints.length >= 2 && inst.pathPlane) {
      return buildSolidSweep(inst.path, inst.pathPoints, inst.pathPlane, inst.closed ?? false,
        inst.params['ПРОФИЛ_ЗАВЪРТАНЕ'] ?? 0, inst.params['ПРОФИЛ_ОТСТЪП_ХОРИЗ'] ?? 0, inst.params['ПРОФИЛ_ОТСТЪП_ВЕРТ'] ?? 0);
    }
    if (inst.familyId === 'solid' && inst.path && inst.path.length >= 3 && inst.plane) {
      return buildSolidExtrude(inst.path, inst.params['ДЪЛБОЧИНА'] ?? 18, inst.plane);
    }
    if (inst.familyId === 'fbx-import' && inst.fbxData) {
      try { return parseFbxDataUrl(inst.fbxData); } catch (err) {
        console.warn('[FBX] failed to parse', inst.label, err);
      }
    }
    return this.getFamilyDef(inst.familyId).buildObject(inst.params);
  }

  /**
   * This instance's nominal (untilted/unoffset) envelope, for `anchorWrap`'s
   * `nominalSize` — so a per-panel nudge (МОДУЛ's `*_РЪБ_ОФСЕТ`) or an in-place
   * rotation (ПЛОСКОСТ's НАКЛОН) that changes the as-built bbox never drags the
   * anchor — and with it every other panel, or the rotation's own pivot — along
   * with it. Undefined for every other family, which still anchors off its actual
   * built geometry.
   */
  private nominalAnchorSize(inst: SceneInstance): THREE.Vector3 | undefined {
    if (inst.familyId === 'module') {
      return new THREE.Vector3(
        inst.params['ШИРИНА'] ?? 800,
        inst.params['ВИСОЧИНА'] ?? 720,
        inst.params['ДЪЛБОЧИНА'] ?? 550,
      );
    }
    if (inst.familyId === 'ploskost') {
      // НАКЛОН tilts the built mesh before anchorWrap ever sees it, so its as-built
      // bbox shrinks/grows with the tilt angle. Anchoring off the untilted AB×BC×
      // ДЕБЕЛИНА envelope instead keeps that anchor offset constant — so the tilt
      // always pivots around the panel's own centre instead of the anchor (e.g. a
      // floor-anchored instance's bottom edge) dragging that centre around as it spins.
      return new THREE.Vector3(
        inst.params['AB'] ?? 600,
        inst.params['BC'] ?? 600,
        inst.params['thickness'] ?? 18,
      );
    }
    return undefined;
  }

  private spawnObject(inst: SceneInstance) {
    this.backfillParams(inst);
    this.backfillMaterials(inst);
    const built = this.buildInstanceObject(inst);
    // A Line sketch IS its own edges already (buildLinePath returns a genuine
    // isEdge-tagged LineSegments, same visual language as every other family's
    // addEdges()-built wireframe, plus an invisible pick-target tube alongside it for
    // raycasting) — skip addEdges (it would wireframe the pick-tube's own faceted
    // geometry, polluting the snap system with junk candidates) and the face-tinting
    // calls (a Line has no faces/material to tint). A void SOLID skips them for a
    // different reason — see isVoidSolid below. An imported FBX skips them for yet
    // another: it comes with its own materials/textures baked in (whatever the
    // original file had), and the generic single-colour tint/wireframe this app
    // applies to its own parametric families would just stomp that — same reasoning,
    // different cause.
    const isLineSketch = inst.familyId === 'line';
    const isVoidSolid = inst.familyId === 'solid' && !!inst.isVoid;
    const isFbxImport = inst.familyId === 'fbx-import';
    const obj = anchorWrap(built, inst.anchor, inst.rotY, this.nominalAnchorSize(inst));
    // Cut BEFORE addEdges/position, while obj is still at its pre-placement identity
    // transform (anchorWrap never sets obj's own position/rotation — see
    // applyVoidCuts's own doc comment for why that matters) — so the wireframe outline
    // traces the already-cut shape. A void itself is never cut by anything else. An
    // FBX import is never cut either — CSG against an arbitrary imported mesh (often
    // many sub-meshes, not necessarily watertight) isn't something this was built for.
    if (!isVoidSolid && !isFbxImport) applyVoidCuts(obj, inst, this.instances);
    if (!isLineSketch && !isVoidSolid && !isFbxImport) addEdges(obj);
    obj.position.set(inst.x, inst.y, inst.z);
    obj.rotation.y = inst.rotY * (Math.PI / 180);
    obj.scale.x = inst.mirrored ? -1 : 1;   // true geometric mirror, set by the Mirror tool
    obj.visible = !inst.hidden;
    if (isVoidSolid) {
      // Invisible except while hovered/selected (setVoidPreview) — never the generic
      // material tint, same reasoning as Line's own exclusion just above.
      obj.traverse(child => {
        if (child instanceof THREE.Mesh) {
          const mat = child.material as THREE.MeshPhongMaterial;
          mat.transparent = true; mat.opacity = 0; mat.depthWrite = false;
        }
      });
    } else if (!isLineSketch && !isFbxImport) {
      if (this.renderMode) this.applyRenderMaterials(obj, inst);
      else this.cadColorObj(obj, inst);        // CAD mode: tint faces by assigned material colour
    }
    if (this.viewPlane !== '3D') {
      // A 2D plan/elevation view: hide this object's shaded faces too (see
      // setMeshFacesVisible/applyViewPlaneVisuals, which handle everything already in
      // objectMap — this mirrors it for a single freshly-spawned object not yet
      // registered there).
      this.setMeshFacesVisible(obj, false);
    }
    this.objectMap.set(inst.id, obj);
    this.scene.add(obj);
  }

  /** A void SOLID's own mesh is otherwise always `opacity: 0` (see spawnObject) — this
   *  is the only thing that ever touches that material, fading it in while hovered or
   *  selected. */
  private setVoidPreview(id: number, show: boolean) {
    const obj = this.objectMap.get(id);
    if (!obj) return;
    obj.traverse(child => {
      if (child instanceof THREE.Mesh) (child.material as THREE.MeshPhongMaterial).opacity = show ? 0.35 : 0;
    });
  }

  /** Re-spawn every other instance — call this whenever a void SOLID's own shape,
   *  position or isVoid flag changes, so holes appear/update/vanish immediately. */
  private respawnAllVoidTargets() {
    for (const inst of this.instances) {
      if (inst.familyId === 'solid' && inst.isVoid) continue;
      const wasSelected = this.selectedIds.has(inst.id);
      const old = this.objectMap.get(inst.id);
      if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
      this.spawnObject(inst);
      if (wasSelected) {
        const obj = this.objectMap.get(inst.id);
        if (obj && !this.renderMode) { colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED); }
      }
    }
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
    this.clearWallDims();
    // In Render mode faces must keep their real material look, so selection is not painted
    // onto them (edges are hidden there anyway); CAD mode keeps the blue highlight.
    const paint = !this.renderMode;
    this.selectedIds.forEach(id => {
      const obj = this.objectMap.get(id);
      if (!obj) return;
      const inst = this.instances.find(i => i.id === id);
      if (inst?.familyId === 'solid' && inst.isVoid) { this.setVoidPreview(id, false); return; }
      if (inst?.familyId === 'fbx-import') return;   // keep its own imported materials untouched
      if (paint) {
        if (inst) this.cadColorObj(obj, inst); else colorObj(obj, COLOR_NORMAL);  // restore material tint
        setEdgeColor(obj, inst?.familyId === 'line' ? LINE_IDLE_COLOR : EDGE_NORMAL);
      }
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
      if (!obj) return;
      const inst = this.instances.find(i => i.id === id);
      if (inst?.familyId === 'solid' && inst.isVoid) { this.setVoidPreview(id, true); return; }
      if (inst?.familyId === 'fbx-import') return;   // keep its own imported materials untouched
      if (paint) { colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED); }
    });
    this.updateWallHandles();   // show editable handles when a single wall is selected
  }

  /** World-space centre of the union AABB of the current selection's live objects (or null if none). */
  private selectionCenter(): THREE.Vector3 | null {
    if (this.selectedIds.size === 0) return null;
    const box = new THREE.Box3();
    let any = false;
    this.selectedIds.forEach(id => {
      const obj = this.objectMap.get(id);
      if (!obj) return;
      obj.updateMatrixWorld(true);
      const b = new THREE.Box3().setFromObject(obj);
      if (b.isEmpty()) return;
      box.union(b);
      any = true;
    });
    return any ? box.getCenter(new THREE.Vector3()) : null;
  }

  clickList(id: number) {
    this.cancelMode();
    this.applySelect(this.selectedIds.size === 1 && this.selectedIds.has(id) ? [] : [id]);
  }

  /**
   * Eye icon in the scene list: show/hide one instance without touching undo. When the
   * clicked row is part of a multi-selection, the toggle applies to every selected
   * instance at once (direction taken from the clicked row's current state), so you can
   * hide/show a whole multi-select from any one of its eye icons.
   */
  toggleVisibility(id: number, event: Event) {
    event.stopPropagation();   // don't also trigger the row's clickList()
    const inst = this.instances.find(i => i.id === id);
    if (!inst) return;
    const ids = (this.selectedIds.size > 1 && this.selectedIds.has(id)) ? [...this.selectedIds] : [id];
    const nextHidden = !inst.hidden;
    for (const targetId of ids) {
      const target = this.instances.find(i => i.id === targetId);
      if (!target) continue;
      target.hidden = nextHidden;
      const obj = this.objectMap.get(targetId);
      if (obj) obj.visible = !nextHidden;
    }
    if (nextHidden) {
      this.applySelect([...this.selectedIds].filter(x => !ids.includes(x)));
    }
  }

  // ── Undo history ─────────────────────────────────────────────────────────────

  /** Deep copy of the data model (the source of truth — the 3D scene is derived). */
  private snapshot(): SceneSnapshot {
    return {
      instances: this.instances.map(i => ({
        ...i, params: { ...i.params }, materials: i.materials ? { ...i.materials } : undefined,
        anchor: i.anchor ? { ...i.anchor } : undefined, path: i.path ? i.path.map(p => ({ ...p })) : undefined,
        plane: i.plane ? { origin: { ...i.plane.origin }, normal: { ...i.plane.normal }, uAxis: { ...i.plane.uAxis } } : undefined,
        pathPlane: i.pathPlane ? { origin: { ...i.pathPlane.origin }, normal: { ...i.pathPlane.normal }, uAxis: { ...i.pathPlane.uAxis } } : undefined,
        pathPoints: i.pathPoints ? i.pathPoints.map(p => ({ ...p })) : undefined,
        extraPaths: i.extraPaths ? i.extraPaths.map(r => ({ closed: r.closed, pts: r.pts.map(p => ({ ...p })) })) : undefined,
      })),
      nextId: this.nextId, nextSolidNum: this.nextSolidNum,
    };
  }

  private record(snap: SceneSnapshot) {
    this.undoStack.push(snap);
    if (this.undoStack.length > this.UNDO_LIMIT) this.undoStack.shift();
    this.pendingSnapshot = null;
    this.scheduleAutosave();
  }

  /** Debounced autosave, fired shortly after each change (every `record()` — covers
   *  both pushHistory's discrete actions and commitPendingEdit's coalesced live edits).
   *  By the time the timer actually fires, the mutation that triggered it has long since
   *  completed (this only ever runs the snapshot taken BEFORE a change), so reading
   *  buildSceneDoc() then correctly captures the resulting, post-change state. Rapid
   *  successive changes (e.g. dragging a slider) collapse into a single write once
   *  things go quiet, instead of one write per tick. */
  private scheduleAutosave() {
    clearTimeout(this.autosaveDebounceId);
    this.ngZone.runOutsideAngular(() => {
      this.autosaveDebounceId = window.setTimeout(() => this.persistAutosave(), 1000);
    });
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
    this.instances = snap.instances.map(i => ({
      ...i, params: { ...i.params }, materials: i.materials ? { ...i.materials } : undefined,
      anchor: i.anchor ? { ...i.anchor } : undefined, path: i.path ? i.path.map(p => ({ ...p })) : undefined,
      plane: i.plane ? { origin: { ...i.plane.origin }, normal: { ...i.plane.normal }, uAxis: { ...i.plane.uAxis } } : undefined,
      pathPlane: i.pathPlane ? { origin: { ...i.pathPlane.origin }, normal: { ...i.pathPlane.normal }, uAxis: { ...i.pathPlane.uAxis } } : undefined,
      pathPoints: i.pathPoints ? i.pathPoints.map(p => ({ ...p })) : undefined,
      extraPaths: i.extraPaths ? i.extraPaths.map(r => ({ closed: r.closed, pts: r.pts.map(p => ({ ...p })) })) : undefined,
    }));
    this.nextId = snap.nextId;
    this.nextSolidNum = snap.nextSolidNum;
    this.instances.forEach(inst => this.spawnObject(inst));
    this.selectedIds = new Set();
    this.pendingSnapshot = null;
    this.removeWallHandles();   // selection cleared → no handles
  }

  /** Ctrl/Cmd+Z — restore the most recent snapshot and rebuild the scene from it. */
  undo() {
    const snap = this.undoStack.pop();
    if (snap) this.restoreScene(snap);
  }

  // ── Save / Load scene (JSON) ─────────────────────────────────────────────────

  /** The scene document: every instance and its props, the material library, and the view. */
  private buildSceneDoc() {
    const cam = this.camera, tgt = this.controls.target;
    return {
      format: 'webcad-scene',
      version: 2,
      savedAt: new Date().toISOString(),
      nextId: this.nextId,
      nextSolidNum: this.nextSolidNum,
      // Family instances: position, rotation, anchor, every parameter value, the module
      // material name, per-panel МАТЕРИАЛИ picks, and any wall/slab polyline.
      instances: this.instances,
      // The editable material library (name + colour/transparency/reflection/glossiness).
      materials: this.materialDefs,
      // Sidebar "Адрес за доставка" field — see its own field doc comment.
      deliveryAddress: this.deliveryAddress,
      // Visualisation + view settings so the scene reopens looking identical.
      view: {
        theme: this.lightTheme ? 'light' : 'dark',
        cameraBrightness: this.cameraBrightness,
        directLight: this.directLight,
        bloomStrength: this.bloomStrength,
        floorReflections: this.floorReflections,
        ssaoEnabled: this.ssaoEnabled,
        viewPlane: this.viewPlane,
        currentPlane: this.currentPlane,
        camera: {
          position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
          target:   { x: tgt.x, y: tgt.y, z: tgt.z },
          // Perspective zoom is implicit in position↔target distance (already saved
          // above), but an orthographic 2D view's wheel-zoom scales THIS instead (its
          // frustum left/right/top/bottom stay fixed — see updateSnapDotScale's own
          // comment on the exact same distinction) — without it, reopening a saved 2D
          // view always came back at whatever setViewPlane's fresh "fit everything"
          // framing is, not wherever you'd actually zoomed to.
          zoom: cam.zoom,
        },
      },
    };
  }

  /** Fallback save: trigger a browser download of the scene JSON (no file handle to keep).
   *  Named after `openedFileName` when we have one (even just `lastFileName`, e.g. right
   *  after a reload) so this still matches the project instead of reverting to the
   *  generic "scene.json" the moment live write access is gone. */
  private downloadScene() {
    const blob = new Blob([JSON.stringify(this.buildSceneDoc(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = this.openedFileName ?? 'scene.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Save — never shows a dialog. Silently overwrites the file this scene was last
   * saved to (or opened from) via the File System Access API; if there's no file yet
   * (or the handle is stale/permission was revoked), it downloads immediately instead
   * of prompting for a location — that's what "Save as…" is for.
   */
  async saveScene() {
    if (this.savedFileHandle) {
      try {
        const writable = await this.savedFileHandle.createWritable();
        await writable.write(JSON.stringify(this.buildSceneDoc(), null, 2));
        await writable.close();
        return;
      } catch {
        this.savedFileHandle = null;   // stale/revoked handle — fall through
      }
    }
    this.downloadScene();
  }

  /** Save as… — always prompts for a location (or downloads, in browsers without the picker API). */
  async saveSceneAs() {
    const picker = window.showSaveFilePicker;
    if (picker) {
      try {
        const handle = await picker({
          suggestedName: this.openedFileName ?? 'scene.json',
          types: [{ description: 'WebCAD scene', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(this.buildSceneDoc(), null, 2));
        await writable.close();
        this.savedFileHandle = handle;
        this.rememberFileName(handle.name);
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;   // user cancelled the picker
        // any other failure (e.g. picker unsupported in this context) — fall back to a download
      }
    }
    this.downloadScene();
  }

  /** Open scene… — via the File System Access picker (so a later "Save" can overwrite it), or the classic file input. */
  async openScene() {
    const picker = window.showOpenFilePicker;
    if (picker) {
      try {
        const [handle] = await picker({
          types: [{ description: 'WebCAD scene', accept: { 'application/json': ['.json'] } }],
        });
        const file = await handle.getFile();
        this.savedFileHandle = handle;
        this.loadSceneFile(file);
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;   // user cancelled the picker
        // any other failure — fall back to the classic hidden file input
      }
    }
    this.sceneFileInputRef?.nativeElement.click();
  }

  /** Change handler for the classic hidden `<input type=file>` fallback. */
  loadScene(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';   // allow re-loading the same file next time
    if (file) this.loadSceneFile(file);
  }

  /** File menu's "Import FBX…" — change handler for its own hidden `<input type=file>`.
   *  Reads the .fbx as a base64 data URL (embedded in `fbxData`, not just referenced —
   *  see that field's own doc comment) and places one new instance, named after the
   *  file, selected and ready to Move into place. */
  importFbx(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';   // allow re-importing the same file next time
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const fbxData = String(reader.result);
      this.ngZone.run(() => {
        this.pushHistory();
        const id = this.nextId++;
        const inst: SceneInstance = {
          id, familyId: 'fbx-import', label: file.name.replace(/\.fbx$/i, ''),
          params: {}, material: '', x: 0, y: 0, z: 0, rotY: 0,
          anchor: { ...CENTRE_ANCHOR }, fbxData,
        };
        this.instances.push(inst);
        this.spawnObject(inst);
        this.applySelect([id]);
      });
    };
    reader.onerror = () => this.ngZone.run(() => alert(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  }

  /** Parse a scene JSON file and recreate every object, coordinate and property. */
  private loadSceneFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { snap, materials, view, deliveryAddress } = this.parseSceneJson(String(reader.result));
        this.ngZone.run(() => {
          this.pushHistory();   // loading is undoable
          this.restoreScene(snap);
          this.restoreMaterialLibrary(materials);
          this.restoreView(view);
          this.deliveryAddress = deliveryAddress;
          // Covers BOTH the File System Access open path and the classic
          // <input type=file> fallback — both route through here — so the sidebar
          // header and export filenames keep the right name even where (or once,
          // after a reload) there's no live write-access handle to derive it from.
          this.rememberFileName(file.name);
        });
      } catch {
        this.ngZone.run(() => alert('Invalid scene file — expected WebCAD scene JSON.'));
      }
    };
    reader.readAsText(file);
  }

  /** Normalise + validate a scene JSON string into a restorable snapshot; throws on invalid input. */
  private parseSceneJson(text: string): { snap: SceneSnapshot; materials: unknown; view: unknown; deliveryAddress: string } {
    const doc = JSON.parse(text);
    const instances = Array.isArray(doc) ? doc : doc.instances;   // accept a bare array too
    if (!Array.isArray(instances)) throw new Error('no instances array');
    const normWallPoints = (pts: unknown): WallPoint[] | undefined =>
      Array.isArray(pts)
        ? pts.map((p: Partial<WallPoint>) => ({
            x: Number(p?.x) || 0, z: Number(p?.z) || 0,
            ...(Number(p?.r) > 0 ? { r: Number(p!.r) } : {}),
            // Round-trip a curved segment's 3-point arc too — this was missing before
            // (only x/z/r were kept), so a saved Curve silently flattened back to
            // straight on reload.
            ...(p?.arc && typeof p.arc === 'object'
              ? { arc: { x: Number((p.arc as Partial<{ x: number; z: number }>).x) || 0, z: Number((p.arc as Partial<{ x: number; z: number }>).z) || 0 } }
              : {}),
          }))
        : undefined;
    const normExtraPaths = (runs: unknown): { pts: WallPoint[]; closed: boolean }[] | undefined =>
      Array.isArray(runs)
        ? runs
            .map((r: { pts?: unknown; closed?: unknown }) => ({ pts: normWallPoints(r?.pts) ?? [], closed: Boolean(r?.closed) }))
            .filter(r => r.pts.length >= 2)
        : undefined;
    // Normalise + validate each instance; coerce missing fields to safe defaults.
    const clean: SceneInstance[] = instances.map((i: Partial<SceneInstance>) => {
      // Migrate scenes saved before КОРПУС С ВРАТА / КОРПУС С РЕБРА were unified into
      // one МОДУЛ family (С_ТАВАН vs С_РЕБРА) — everything else backfills automatically.
      let familyId = String(i.familyId);
      const params: Record<string, number> = { ...(i.params ?? {}) };
      if (familyId === 'cabinet-door') { familyId = 'module'; params['С_РЕБРА'] = 0; }
      else if (familyId === 'cabinet-ribs') { familyId = 'module'; params['С_РЕБРА'] = 1; }
      // Migrate scenes saved before ВИСОЧИНА_ВРАТИЧКА was removed (replaced by
      // ВРАТИЧКА_ГОРЕН_РЪБ_ОФСЕТ): in ribs mode it used to fix the door's top edge
      // directly from the nominal bottom — fold that into an equivalent offset so
      // existing geometry doesn't move.
      if (familyId === 'module' && params['С_РЕБРА'] === 1 && 'ВИСОЧИНА_ВРАТИЧКА' in params) {
        const H = params['ВИСОЧИНА'] ?? 720;
        const t = params['ПЛОСКОСТ_ДЕБЕЛИНА'] ?? 18;
        const fugaTop = params['ВРАТИЧКА_ФУГА_ОТГОРЕ'] ?? 0;
        const fugaBot = params['ВРАТИЧКА_ФУГА_ОТДОЛУ'] ?? 0;
        const tavFront = !!params['ТАВАН_ВИДИМ_КАНТ_ОТПРЕД'];
        const oldYt = (-H / 2 + fugaBot) + params['ВИСОЧИНА_ВРАТИЧКА'];
        const newBaseYt = tavFront ? H / 2 - t - 1 : H / 2 - fugaTop;
        params['ВРАТИЧКА_ГОРЕН_РЪБ_ОФСЕТ'] = (params['ВРАТИЧКА_ГОРЕН_РЪБ_ОФСЕТ'] ?? 0) + (oldYt - newBaseYt);
        delete params['ВИСОЧИНА_ВРАТИЧКА'];
      }
      return {
        id: Number(i.id),
        familyId,
        label: String(i.label ?? `МОДУЛ ${i.id}`),
        params,
        material: String(i.material ?? ''),
        materials: i.materials && typeof i.materials === 'object' ? { ...i.materials } : undefined,
        x: Number(i.x) || 0, y: Number(i.y) || 0, z: Number(i.z) || 0,
        rotY: Number(i.rotY) || 0,
        mirrored: Boolean(i.mirrored) || undefined,
        anchor: normAnchor(i.anchor),
        path: normWallPoints(i.path),
        hidden: Boolean(i.hidden) || undefined,
        plane: i.plane ? normalizePlaneDesc(i.plane) : undefined,
        closed: Boolean(i.closed) || undefined,
        solidOp: (i.solidOp === 'sweep' ? 'sweep' : i.solidOp === 'extrude' ? 'extrude' : undefined) as 'extrude' | 'sweep' | undefined,
        pathPlane: i.pathPlane ? normalizePlaneDesc(i.pathPlane) : undefined,
        pathPoints: normWallPoints(i.pathPoints),
        extraPaths: normExtraPaths(i.extraPaths),
        isVoid: Boolean(i.isVoid) || undefined,
        voidExcludeIds: Array.isArray(i.voidExcludeIds)
          ? i.voidExcludeIds.map(Number).filter(Number.isFinite)
          : undefined,
        fbxData: typeof i.fbxData === 'string' ? i.fbxData : undefined,
      };
    }).filter(i => Number.isFinite(i.id) && this.getFamilyDef(i.familyId));
    const maxId = clean.reduce((m, i) => Math.max(m, i.id), 0);
    const nextId = Number(doc.nextId) > maxId ? Number(doc.nextId) : maxId + 1;
    const maxSolidLabel = clean.reduce((m, i) => {
      const match = /^SOLID (\d+)$/.exec(i.label);
      return match ? Math.max(m, Number(match[1])) : m;
    }, 0);
    const nextSolidNum = Math.max(Number(doc.nextSolidNum) > 0 ? Number(doc.nextSolidNum) : 1, maxSolidLabel + 1);
    return {
      snap: { instances: clean, nextId, nextSolidNum }, materials: doc.materials, view: doc.view,
      deliveryAddress: typeof doc.deliveryAddress === 'string' ? doc.deliveryAddress : '',
    };
  }

  // ── Autosave (localStorage) ──────────────────────────────────────────────────
  //
  // Independent of Save/Save as/Open: mirrors whatever is currently on screen so a
  // refresh, an accidental tab close, or a crash doesn't lose in-progress work. Written
  // on a timer and on `beforeunload`; restored once at startup if present.

  /**
   * Serialise the current scene: always to localStorage (the refresh/crash safety net,
   * independent of any file), and — when the scene was saved to or opened from a real
   * file via the File System Access API — ALSO to that same file, so "autosave" means
   * what it sounds like: the file you're actually working on stays current, not just a
   * hidden fallback copy. Silently no-ops on failure (storage full, private-browsing
   * mode, an unserialisable value, or a revoked file-write permission — exactly
   * `saveScene()`'s own recovery: drop the stale handle and keep going with
   * localStorage only).
   */
  private persistAutosave() {
    let json: string;
    try {
      json = JSON.stringify(this.buildSceneDoc());
    } catch {
      return;
    }
    try {
      localStorage.setItem(AUTOSAVE_KEY, json);
    } catch {
      // quota exceeded or storage disabled — nothing we can do, just skip this tick
    }
    if (this.savedFileHandle) {
      this.savedFileHandle.createWritable()
        .then(w => w.write(json).then(() => w.close()))
        .catch(() => { this.savedFileHandle = null; });
    }
  }

  /** Restore the autosaved scene from localStorage, if any — called once at startup. */
  private restoreAutosave() {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (!text) return;
    try {
      const { snap, materials, view, deliveryAddress } = this.parseSceneJson(text);
      if (snap.instances.length === 0) return;   // nothing worth restoring
      this.restoreScene(snap);
      this.restoreMaterialLibrary(materials);
      this.restoreView(view);
      this.deliveryAddress = deliveryAddress;
    } catch {
      localStorage.removeItem(AUTOSAVE_KEY);   // corrupted — drop it rather than fail on every load
    }
  }

  /** Restore the saved material library (v2+); older files leave the current library intact. */
  private restoreMaterialLibrary(mats: unknown) {
    if (!Array.isArray(mats)) return;
    const clean: MaterialDef[] = mats
      .filter((m): m is Partial<MaterialDef> => !!m && typeof m === 'object')
      .map(m => ({
        name: String(m.name ?? 'МАТЕРИАЛ'),
        color: typeof m.color === 'string' ? m.color : '#cccccc',
        transparency: Number(m.transparency) || 0,
        reflection: Number(m.reflection) || 0,
        glossiness: Number.isFinite(m.glossiness as number) ? Number(m.glossiness) : 50,
        bump: Number(m.bump) > 0 ? Number(m.bump) : undefined,
        bumpSize: Number(m.bumpSize) > 0 ? Number(m.bumpSize) : undefined,
        bumpTexture: typeof m.bumpTexture === 'string' ? m.bumpTexture : undefined,
        texture: typeof m.texture === 'string' ? m.texture : undefined,
        textureW: Number(m.textureW) > 0 ? Number(m.textureW) : undefined,
        textureH: Number(m.textureH) > 0 ? Number(m.textureH) : undefined,
        textureRotation: Number.isFinite(m.textureRotation as number) ? Number(m.textureRotation) : undefined,
        grainAxis: m.grainAxis === 'Ш' || m.grainAxis === 'В' ? m.grainAxis : undefined,
      }));
    if (!clean.length) return;
    // Merge in any built-in defaults the saved library is missing (by name), so older scenes
    // still get the standard finishes (ХРОМ, СТЪКЛО, …) without losing custom materials.
    const have = new Set(clean.map(m => m.name));
    for (const d of DEFAULT_MATERIALS) if (!have.has(d.name)) clean.push({ ...d });
    this.clearTextureCache();
    this.materialDefs = clean;
    this.editingMaterialIndex = 0;
    // The scene is spawned BEFORE this library loads (restore order), so objects were tinted
    // against the defaults only — re-skin them now that custom materials exist: full PBR in
    // Render mode, else the flat CAD colour indication (selected ones stay blue).
    this.objectMap.forEach((obj, id) => {
      const inst = this.instances.find(i => i.id === id);
      if (!inst) return;
      if (this.renderMode) this.applyRenderMaterials(obj, inst);
      else if (!this.selectedIds.has(id)) this.cadColorObj(obj, inst);
    });
  }

  /** Restore the saved visualisation/view settings (v2+): theme, brightness, camera pose. */
  private restoreView(view: any) {
    if (!view || typeof view !== 'object') return;
    if (view.theme === 'light' || view.theme === 'dark') {
      this.lightTheme = view.theme === 'light';
      this.applyViewportBackground();
    }
    if (Number.isFinite(view.cameraBrightness)) {
      this.cameraBrightness = Math.min(2, Math.max(0.2, Number(view.cameraBrightness)));
      this.applyLighting();
    }
    if (typeof view.directLight === 'boolean') this.directLight = view.directLight;
    if (Number.isFinite(view.bloomStrength)) this.bloomStrength = Math.min(1, Math.max(0, Number(view.bloomStrength)));
    if (typeof view.floorReflections === 'boolean') this.floorReflections = view.floorReflections;
    if (typeof view.ssaoEnabled === 'boolean') this.ssaoEnabled = view.ssaoEnabled;
    // Restore currentPlane BEFORE viewPlane — setViewPlane('current') reads it
    // immediately, and this must run after the scene's own instances are already
    // spawned (objectMap populated) for its bounding-sphere framing to work, which
    // every caller of restoreView already guarantees (always called after restoreScene).
    if (view.currentPlane && typeof view.currentPlane === 'object') {
      try { this.currentPlane = normalizePlaneDesc(view.currentPlane); } catch { this.currentPlane = null; }
    }
    if (typeof view.viewPlane === 'string' && ['3D', 'XZ', 'XY', 'YZ', 'current'].includes(view.viewPlane)) {
      this.setViewPlane(view.viewPlane as MovePlane | '3D' | 'current');
    }
    // Position/target/zoom restore AFTER viewPlane, not before: for any 2D mode,
    // setViewPlane always (re)builds the orthographic camera's own default framing —
    // centred on the scene's bounding sphere, not wherever you'd actually panned/
    // zoomed to — which would otherwise silently overwrite whatever's set here. This
    // was the exact bug: zoom alone survived a reload (applied after, as a plain
    // scalar — see below) while position/target didn't (set before, then clobbered
    // by setViewPlane's own computation). Landing all three here, after viewPlane, on
    // whichever camera object ends up active, fixes it for 2D and changes nothing for
    // 3D (setViewPlane('3D') never touches position/target itself anyway).
    const cp = view.camera?.position, ct = view.camera?.target;
    if (cp && Number.isFinite(cp.x) && Number.isFinite(cp.y) && Number.isFinite(cp.z)) {
      this.camera.position.set(cp.x, cp.y, cp.z);
    }
    if (ct && Number.isFinite(ct.x) && Number.isFinite(ct.y) && Number.isFinite(ct.z)) {
      this.controls.target.set(ct.x, ct.y, ct.z);
    }
    const cz = view.camera?.zoom;
    if (Number.isFinite(cz) && cz > 0) {
      this.camera.zoom = Number(cz);
      this.camera.updateProjectionMatrix();
    }
    this.controls.update();
  }

  // ── Property editing ───────────────────────────────────────────────────────

  updatePosition() {
    const inst = this.selectedInstance;
    if (!inst) return;
    this.commitPendingEdit();
    this.objectMap.get(inst.id)?.position.set(inst.x, inst.y, inst.z);
    if (inst.familyId === 'wall') this.updateWallHandles();
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
    if (inst.familyId === 'wall') this.updateWallHandles();
  }

  rebuildSelected() {
    const inst = this.selectedInstance;
    if (!inst) return;
    this.commitPendingEdit();
    const old = this.objectMap.get(inst.id);
    if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
    this.spawnObject(inst);
    if (inst.familyId === 'solid' && inst.isVoid) {
      this.setVoidPreview(inst.id, true);
    } else {
      const obj = this.objectMap.get(inst.id)!;
      if (!this.renderMode) { colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED); }
    }
    // Unconditional for any SOLID edit (not just while currently isVoid): toggling
    // isVoid OFF needs this exactly as much as ON does, to un-cut/cut everyone else —
    // and it's a harmless no-op (0 voids filtered) for an ordinary solid's own edits.
    if (inst.familyId === 'solid') this.respawnAllVoidTargets();
    this.accumDirty = true;
  }

  /** Every instance a void SOLID could plausibly cut — everything except Lines (a
   *  no-op cut target, see applyVoidCuts) and other void SOLIDs (never cut at all,
   *  see spawnObject's isVoidSolid branch) — for the selected void's "Cuts" list. */
  voidCuttableList(voidId: number): SceneInstance[] {
    return this.instances.filter(i =>
      i.id !== voidId && i.familyId !== 'line' && !(i.familyId === 'solid' && i.isVoid));
  }

  isVoidExcluded(voidInst: SceneInstance, targetId: number): boolean {
    return voidInst.voidExcludeIds?.includes(targetId) ?? false;
  }

  /** Toggle whether the selected void cuts `targetId` — the "Cuts" list's eye icon. */
  toggleVoidExclude(targetId: number, event: Event) {
    event.stopPropagation();
    const inst = this.selectedInstance;
    if (!inst || inst.familyId !== 'solid' || !inst.isVoid) return;
    this.beginEdit();
    const excluded = inst.voidExcludeIds ?? [];
    inst.voidExcludeIds = excluded.includes(targetId)
      ? excluded.filter(id => id !== targetId)
      : [...excluded, targetId];
    this.rebuildSelected();
  }

  deleteSelected() {
    this.pushHistory();
    const anyVoidDeleted = this.instances.some(i => this.selectedIds.has(i.id) && i.familyId === 'solid' && i.isVoid);
    this.selectedIds.forEach(id => {
      const obj = this.objectMap.get(id);
      if (obj) { this.scene.remove(obj); disposeObj(obj); this.objectMap.delete(id); }
    });
    if (this.hoveredInst && this.selectedIds.has(this.hoveredInst.id)) this.hoveredInst = null;
    this.instances = this.instances.filter(i => !this.selectedIds.has(i.id));
    this.applySelect([]);
    // Un-cut whatever any deleted void used to target, now that it's gone.
    if (anyVoidDeleted) this.respawnAllVoidTargets();
  }

  // ── Schedule export ──────────────────────────────────────────────────────────

  /** File menu's "Спецификация (.txt)" — opens the preview dialog instead of downloading
   *  straight away, so the shop can check it (and toggle Itemize) before committing to a file. */
  openSchedulePreview() { this.fileMenuOpen = false; this.scheduleDialogOpen = true; }
  closeSchedulePreview() { this.scheduleDialogOpen = false; }

  /** The preview dialog's own live table: each cut-list line split into cells (see
   *  webcad-schedule) — recomputed from `itemize`/`instances` on every change detection,
   *  same "just a getter" pattern as `scheduleColCount` below, so toggling Itemize in
   *  the dialog updates the preview immediately with no extra wiring. `asFormulas:
   *  false` so a ОБЩО subtotal shows its plain number instead of the literal formula
   *  text that the actual .txt download (exportSchedule) still gets. */
  get scheduleRows(): string[][] {
    return buildScheduleText(this.instances, this.itemize, this.materialDefs, false).replace(/^﻿/, '').split('\r\n').map(l => l.split('\t'));
  }

  /** Column count of the header row — a shorter row (a ОБЩО subtotal/blank separator,
   *  see webcad-schedule) spans this many columns instead of sitting in the first one. */
  get scheduleColCount(): number {
    return this.scheduleRows[0]?.length ?? 1;
  }

  /** Generate the cut-list (see webcad-schedule) and download it as a .txt for the shop —
   *  the preview dialog's own "Изтегли" button. */
  exportSchedule() {
    const blob = new Blob([buildScheduleText(this.instances, this.itemize, this.materialDefs)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'schedule.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  /** The preview dialog's "За Хосе (.xlsx)"/"За Мая (.xlsx)" buttons — each manufacturer's
   *  own production-offer request template, filled from the exact same panels as the
   *  .txt export above (see webcad-export-xlsx.ts for each one's own layout). Хосе's
   *  clones a real template fetched from assets/ (never written back to); both just
   *  hand the finished in-memory workbook here to download. */
  private async downloadWorkbook(wb: ExcelJS.Workbook, filename: string) {
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** The project's own saved/opened file name (see `openedFileName`), minus its .json
   *  extension — 'scene' for a brand-new unsaved scene, matching `downloadScene()`'s own
   *  fallback name. Used to name the manufacturer exports after the project itself. */
  private get projectBaseName(): string {
    return (this.openedFileName ?? 'scene.json').replace(/\.json$/i, '');
  }

  async exportHoseXlsx() {
    try {
      await this.downloadWorkbook(await buildHoseWorkbook(this.instances, this.materialDefs, this.deliveryAddress), `${this.projectBaseName}_Hose.xlsx`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Неуспешен експорт за Хосе.');
    }
  }

  async exportMayaXlsx() {
    try {
      await this.downloadWorkbook(await buildMayaWorkbook(this.instances, this.materialDefs), `${this.projectBaseName}_Laminati.xlsx`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Неуспешен експорт за Мая.');
    }
  }

  // ── Photoreal export (→ Blender / V-Ray-class offline render) ───────────────────

  /**
   * Export the scene as a single self-contained `.glb` for offline path-traced
   * rendering (see `scripts/render/`). The GLB carries the full **Render-mode PBR look**
   * (MeshStandard metalness/roughness + embedded JPG textures → glTF PBR, which maps
   * 1:1 onto Blender's Principled BSDF) plus a camera matching the current view, so the
   * Blender render frames exactly what's on screen. Nothing here mutates the live scene:
   * every object is cloned and render materials are applied to the clones with
   * `dispose = false` (the live materials are shared, so we must not free them), and CAD
   * edge lines are left invisible so `onlyVisible` drops them.
   */
  async exportForRender() {
    this.visMenuOpen = false;
    if (!this.instances.length) return;

    const group = new THREE.Group();
    group.name = 'Kitchen';
    for (const inst of this.instances) {
      const src = this.objectMap.get(inst.id);
      if (!src) continue;
      const clone = src.clone(true);              // shares geometry + materials with the live object
      this.applyRenderMaterials(clone, inst, false);  // give the clone its own MeshStandard mats; keep live ones
      group.add(clone);
    }

    // A camera matching the current view. Blender's glTF importer handles the Y-up→Z-up
    // conversion; the aspect ratio (stored as a node extra) lets the script pick a matching
    // output resolution so the framing is identical.
    const canvas = this.canvasRef.nativeElement;
    const aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
    const cam = this.camera.clone();
    cam.name = 'ViewCamera';
    cam.userData = { viewAspect: aspect };
    group.add(cam);
    group.updateMatrixWorld(true);

    // Textures (chipboard edge, material JPGs) load asynchronously; GLTFExporter throws
    // "No valid image data" if a map's image hasn't decoded yet. Wait for them, and drop
    // any that never arrive so one un-loaded image can't block the whole export.
    await this.awaitGroupTextures(group, 5000);

    const exporter = new GLTFExporter();
    exporter.parse(
      group,
      (result) => {
        const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'kitchen-render.glb';
        a.click();
        URL.revokeObjectURL(url);
      },
      (err) => console.error('[render export] GLTF export failed', err),
      { binary: true, onlyVisible: true },
    );
  }

  /**
   * Resolve once every texture map under `group` has decoded image data (or `timeoutMs`
   * elapses). Any map still without a usable image is then removed so `GLTFExporter`
   * won't throw. Operates only on the throwaway clone materials — the shared texture
   * objects are left intact, so the live scene is unaffected.
   */
  private awaitGroupTextures(group: THREE.Object3D, timeoutMs: number): Promise<void> {
    const maps = new Set<THREE.Texture>();
    const eachMat = (fn: (m: THREE.MeshStandardMaterial) => void) => group.traverse(o => {
      const mm = (o as THREE.Mesh).material;
      if (!mm) return;
      (Array.isArray(mm) ? mm : [mm]).forEach(m => fn(m as THREE.MeshStandardMaterial));
    });
    eachMat(m => { if (m.map) maps.add(m.map); });
    if (!maps.size) return Promise.resolve();

    const ready = (t: THREE.Texture): boolean => {
      const img = t.image as (HTMLImageElement | ImageBitmap | HTMLCanvasElement | undefined);
      if (!img) return false;
      if (img instanceof HTMLImageElement) return img.complete && img.naturalWidth > 0;
      return (img as { width?: number }).width! > 0;
    };

    const start = Date.now();
    return new Promise<void>(resolve => {
      const tick = () => {
        const pending = [...maps].some(t => !ready(t));
        if (!pending || Date.now() - start > timeoutMs) {
          eachMat(m => { if (m.map && !ready(m.map)) { m.map = null; m.needsUpdate = true; } });
          resolve();
          return;
        }
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  // ── Match tool ───────────────────────────────────────────────────────────────

  /** Available when idle with exactly one object selected (the source). */
  get canMatch(): boolean { return this.mode === 'idle' && this.selectedIds.size === 1; }

  /**
   * Enter Match mode: the single selected instance becomes the source. Every object
   * clicked afterwards takes the source's properties (params + material) if it is the
   * SAME family — you can't match a Ploskost onto a МОДУЛ. Placement
   * (position/rotation) is never copied. Esc finishes.
   */
  startMatch() {
    if (this.selectedIds.size !== 1) return;
    this.cancelMode();
    this.matchSourceId = [...this.selectedIds][0];
    this.applySelect([this.matchSourceId]);   // keep the source highlighted as reference
    this.removeWallHandles();
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
    this.removeWallHandles();
    this.mode = 'measure-from';
    this.modeLabel = 'Click the first point — Shift+scroll-drag orbits — Esc to finish';
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
    this.removeWallHandles();
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

  /**
   * Shift-lock for the Line tool: the arbitrary-plane generalisation of `lockAxisXZ` —
   * pins the new point to whichever of the PLANE's OWN two axes (u or v) the drag
   * deviates along more, so the segment runs purely along one of them instead of at
   * a free angle. For the quick-picked XZ/XY/YZ planes this is exactly a lock to two
   * of the three world axes (their u/v ARE world axes by construction — see
   * `quickPickPlane`); for an arbitrary face-picked plane it locks to that plane's own
   * natural in-plane directions instead, the closest sensible analogue.
   */
  private lockAxisOnPlane(to: THREE.Vector3, from: THREE.Vector3, plane: PlaneDesc): THREE.Vector3 {
    const { uAxis, vAxis } = planeBasis(plane);
    const delta = to.clone().sub(from);
    const du = delta.dot(uAxis), dv = delta.dot(vAxis);
    return Math.abs(du) >= Math.abs(dv)
      ? from.clone().addScaledVector(uAxis, du)
      : from.clone().addScaledVector(vAxis, dv);
  }

  /**
   * Live translucent preview of the in-progress segment `from`→`to`, plus the editable
   * cursor-distance input (same `.move-measure` editor the Move tool uses) so a specific
   * length can be typed in rather than clicked — see `commitTypedDistance`.
   */
  private updateWallGhost(from: THREE.Vector3, to: THREE.Vector3) {
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    const dx = to.x - from.x, dz = to.z - from.z;
    const len = Math.hypot(dx, dz);
    if (len < 1) { this.ngZone.run(() => { this.moveLabel = null; }); return; }
    const seg = makeMesh(len, this.wallHeight, 90, this.wallThickness, [false, false, false, false], 0.5, true);
    ghostify(seg);
    seg.rotation.y = Math.atan2(-dz, dx);
    seg.position.set((from.x + to.x) / 2, this.wallHeight / 2, (from.z + to.z) / 2);
    this.ghost = seg;
    this.scene.add(this.ghost);

    this.moveDir.set(dx, 0, dz).normalize();
    const { x, y } = this.worldToPx(to);
    this.ngZone.run(() => {
      this.moveLabel = { x, y };
      if (!this.distanceLocked) this.distanceStr = String(Math.round(len));
      if (this.distFocusPending) {
        this.distFocusPending = false;
        setTimeout(() => this.distInputRef?.nativeElement.focus());
      }
    });
  }

  /** Append a vertex to the current polyline and create/grow the single wall instance. */
  private addWallPoint(p: THREE.Vector3) {
    this.wallPath.push(p.clone());
    // Reset the typed-length editor for the next segment (fresh live value, auto-focus).
    this.distanceLocked = false; this.distanceStr = ''; this.distFocusPending = true;
    if (this.wallPath.length < 2) return;
    this.pushHistory();
    const p0 = this.wallPath[0];
    const localPath: WallPoint[] = this.wallPath.map(v => ({ x: v.x - p0.x, z: v.z - p0.z }));
    if (this.wallInstanceId === null) {
      const id = this.nextId++;
      const inst: SceneInstance = {
        id, familyId: 'wall', label: `СТЕНА ${id}`,
        params: { 'ВИСОЧИНА': this.wallHeight, 'ДЕБЕЛИНА': this.wallThickness },
        material: 'БЯЛО МАТ', path: localPath,
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

  // ── Wall vertex / segment editing (after the wall is finished) ────────────────

  /** True while a wall vertex or segment is being repositioned. */
  get wallVertexEditing(): boolean { return !!this.wallEdit; }

  /** Local wall-frame point → world ground position (honours the wall's rotation). */
  private wallToWorld(inst: SceneInstance, p: WallPoint): THREE.Vector3 {
    return new THREE.Vector3(p.x, 0, p.z)
      .applyAxisAngle(WALL_Y, inst.rotY * (Math.PI / 180))
      .add(new THREE.Vector3(inst.x, inst.y, inst.z));
  }

  /** World ground position → local wall-frame point (rounded to mm). */
  private worldToWallLocal(inst: SceneInstance, w: THREE.Vector3): WallPoint {
    const v = w.clone().sub(new THREE.Vector3(inst.x, inst.y, inst.z))
      .applyAxisAngle(WALL_Y, -inst.rotY * (Math.PI / 180));
    return { x: Math.round(v.x), z: Math.round(v.z) };
  }

  /** (Re)build the draggable handles for the single selected wall, or remove them. */
  private updateWallHandles() {
    this.removeWallHandles();
    if (this.mode !== 'idle' && !this.wallEdit) return;
    if (this.selectedIds.size !== 1) return;
    const inst = this.selectedInstance;
    if (!inst || inst.familyId !== 'wall' || !inst.path || inst.path.length < 2) return;

    const g = new THREE.Group();
    inst.path.forEach((p, i) => {
      const m = new THREE.Mesh(this.vtxHandleGeo, this.vtxHandleMat);
      m.position.copy(this.wallToWorld(inst, p));
      m.renderOrder = 1000;
      m.userData = { wallHandle: 'vertex', index: i };
      g.add(m);
    });
    for (let i = 0; i < inst.path.length - 1; i++) {
      const a = this.wallToWorld(inst, inst.path[i]);
      const b = this.wallToWorld(inst, inst.path[i + 1]);
      const m = new THREE.Mesh(this.edgeHandleGeo, this.edgeHandleMat);
      m.position.copy(a.add(b).multiplyScalar(0.5));
      m.renderOrder = 1000;
      m.userData = { wallHandle: 'edge', index: i };
      g.add(m);
    }
    this.wallHandleGroup = g;
    this.scene.add(g);
  }

  private removeWallHandles() {
    if (this.wallHandleGroup) { this.scene.remove(this.wallHandleGroup); this.wallHandleGroup = null; }
  }

  /** Raycast the wall handles; returns the picked vertex/segment, or null. */
  private pickWallHandle(e: MouseEvent): { kind: 'vertex' | 'edge'; index: number } | null {
    if (!this.wallHandleGroup) return null;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hits = this.raycaster.intersectObjects(this.wallHandleGroup.children, false);
    if (!hits.length) return null;
    const ud = hits[0].object.userData;
    return { kind: ud['wallHandle'], index: ud['index'] };
  }

  /**
   * Pick up a wall vertex (or whole segment) for repositioning. Click-move-click, like
   * the Move tool: it reuses the move-to drag so Shift axis-lock, snapping and the typed
   * distance editor all work; commit with a click or a typed distance + Enter.
   */
  private startWallEdit(kind: 'vertex' | 'edge', index: number) {
    const inst = this.selectedInstance;
    if (!inst || inst.familyId !== 'wall' || !inst.path) return;
    this.pushHistory();
    this.wallEdit = { instId: inst.id, kind, index };
    this.wallEditOrig = inst.path.map(p => ({ ...p }));
    const from = kind === 'vertex'
      ? this.wallToWorld(inst, inst.path[index])
      : this.wallToWorld(inst, inst.path[index]).add(this.wallToWorld(inst, inst.path[index + 1])).multiplyScalar(0.5);
    this.moveFrom.copy(from);
    this.movePlane = 'XZ';
    this.isCopy = false; this.isArray = false;
    this.mode = 'move-to';
    this.modeLabel = (kind === 'vertex' ? 'Move vertex' : 'Move segment')
      + ' — click to drop · Shift locks axis · type distance + Enter · Esc cancels';
    this.distanceLocked = false; this.distanceStr = ''; this.distFocusPending = true;
    this.controls.enabled = false;
  }

  /** Apply the in-progress vertex/segment move to `pos` (world ground point) and rebuild. */
  private applyWallEdit(pos: THREE.Vector3) {
    if (!this.wallEdit || !this.wallEditOrig) return;
    const inst = this.instances.find(i => i.id === this.wallEdit!.instId);
    if (!inst) return;
    const path = this.wallEditOrig.map(p => ({ ...p }));
    const i = this.wallEdit.index;
    if (this.wallEdit.kind === 'vertex') {
      path[i] = this.worldToWallLocal(inst, pos);
    } else {
      const dl = pos.clone().sub(this.moveFrom).applyAxisAngle(WALL_Y, -inst.rotY * (Math.PI / 180));
      path[i]     = { x: Math.round(this.wallEditOrig[i].x     + dl.x), z: Math.round(this.wallEditOrig[i].z     + dl.z) };
      path[i + 1] = { x: Math.round(this.wallEditOrig[i + 1].x + dl.x), z: Math.round(this.wallEditOrig[i + 1].z + dl.z) };
    }
    inst.path = path;
    const old = this.objectMap.get(inst.id);
    if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
    this.spawnObject(inst);
    const obj = this.objectMap.get(inst.id);
    if (obj) { colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED); }
    this.updateWallHandles();
  }

  /** Live preview while moving the cursor with a vertex/segment picked up. */
  private wallEditMove(e: MouseEvent) {
    const snap = this.getSnap(e, this.groundPlane, new Set([this.wallEdit!.instId]));
    if (!snap) return;
    const pos = e.shiftKey ? this.lockAxisXZ(snap.pos, this.moveFrom) : snap.pos;
    this.showSnap(pos, snap.type);
    this.applyWallEdit(pos);
    this.showMoveMeasure(e, pos);
  }

  /** Drop the vertex/segment at `pos` and return to idle. */
  private finishWallEdit(pos: THREE.Vector3) {
    this.applyWallEdit(pos);
    this.wallEdit = null; this.wallEditOrig = null;
    this.mode = 'idle'; this.modeLabel = '';
    this.controls.enabled = true;
    this.snapDot.visible = false;
    this.hideMoveMeasure();
    this.distanceLocked = false; this.distanceStr = '';
    this.updateWallHandles();
  }

  // ── Wall face temporary dimensions (Revit-style) ──────────────────────────────
  //
  // Clicking a selected wall's vertical face raycasts along that face's outward
  // normal (and, for a side face, inward too) to find the nearest OTHER instance's
  // surface, showing an editable live distance. The search always excludes the
  // clicked wall's own geometry, so this can never show — or change — its thickness;
  // committing only ever translates the whole wall or moves one endpoint.

  /** Nearest face hit along a ray from `origin` in `dir`, excluding `excludeInstId`. */
  private nearestSurfaceHit(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, excludeInstId: number):
    { point: THREE.Vector3; dist: number } | null {
    const eps = 1;   // nudge past the source face so it isn't immediately re-hit at t≈0
    const targets: THREE.Mesh[] = [];
    this.objectMap.forEach((obj, id) => {
      if (id === excludeInstId) return;
      obj.traverse(c => { if (c instanceof THREE.Mesh && !c.userData['isEdge']) targets.push(c); });
    });
    const d = dir.clone().normalize();
    this.raycaster.set(origin.clone().addScaledVector(d, eps), d);
    this.raycaster.far = maxDist;
    const hits = this.raycaster.intersectObjects(targets, false);
    this.raycaster.far = Infinity;
    if (!hits.length) return null;
    return { point: hits[0].point, dist: hits[0].distance + eps };
  }

  /**
   * Classify a raycast hit on a wall's solid: an end-cap face (only exists at the
   * polyline's first/last vertex — interior joints are mitred) or a side face
   * (belongs to one segment). Returns null for a face this feature doesn't handle.
   */
  private classifyWallFace(inst: SceneInstance, worldNormal: THREE.Vector3):
    { kind: 'end'; vertexIndex: number } | { kind: 'side'; segIndex: number } | null {
    const path = inst.path;
    if (!path || path.length < 2) return null;
    const n = path.length;
    const dir2 = (a: WallPoint, b: WallPoint) => new THREE.Vector3(b.x - a.x, 0, b.z - a.z).normalize();

    // Undo the wall instance's own Y rotation to work in its local (unrotated) frame.
    const localN = worldNormal.clone().applyAxisAngle(WALL_Y, -inst.rotY * (Math.PI / 180));
    localN.y = 0; localN.normalize();

    const d0 = dir2(path[0], path[1]);
    if (localN.dot(d0) < -0.9) return { kind: 'end', vertexIndex: 0 };
    const dLast = dir2(path[n - 2], path[n - 1]);
    if (localN.dot(dLast) > 0.9) return { kind: 'end', vertexIndex: n - 1 };

    let best = -1, bestDot = 0.6;   // require reasonably close alignment
    for (let i = 0; i < n - 1; i++) {
      const d = dir2(path[i], path[i + 1]);
      const perp = new THREE.Vector3(-d.z, 0, d.x);   // rotate 90° in the ground plane
      const dot = Math.abs(localN.dot(perp));
      if (dot > bestDot) { bestDot = dot; best = i; }
    }
    return best >= 0 ? { kind: 'side', segIndex: best } : null;
  }

  private makeWallDim(
    instId: number, editKind: WallDim['editKind'], axis: THREE.Vector3,
    originPoint: THREE.Vector3, hitPoint: THREE.Vector3, vertexIndex?: number,
  ): WallDim {
    const dist = Math.round(originPoint.distanceTo(hitPoint));
    return {
      instId, editKind, axis: axis.clone().normalize(),
      originPoint: originPoint.clone(), hitPoint: hitPoint.clone(),
      dist, vertexIndex, screen: { x: 0, y: 0 }, valueStr: String(dist),
    };
  }

  /** Build the dimension(s) for a clicked face — only ever to ANOTHER instance — and show them. */
  private beginWallDimension(
    inst: SceneInstance, point: THREE.Vector3, worldNormal: THREE.Vector3,
    cls: { kind: 'end'; vertexIndex: number } | { kind: 'side'; segIndex: number },
  ) {
    const dims: WallDim[] = [];
    if (cls.kind === 'end') {
      const hit = this.nearestSurfaceHit(point, worldNormal, WALL_DIM_MAX, inst.id);
      if (hit) dims.push(this.makeWallDim(inst.id, 'vertex', worldNormal, point, hit.point, cls.vertexIndex));
    } else {
      const out = this.nearestSurfaceHit(point, worldNormal, WALL_DIM_MAX, inst.id);
      if (out) dims.push(this.makeWallDim(inst.id, 'translate', worldNormal, point, out.point));
      const inwardDir = worldNormal.clone().negate();
      const inHit = this.nearestSurfaceHit(point, inwardDir, WALL_DIM_MAX, inst.id);
      if (inHit) dims.push(this.makeWallDim(inst.id, 'translate', inwardDir, point, inHit.point));
    }
    this.wallDims = dims;
    this.updateWallDimScreens();
    this.updateWallDimLines();
  }

  /** Raycast the clicked wall's own solid; on a vertical face, show its temp dimension(s). */
  private tryStartWallFaceDimension(e: MouseEvent, inst: SceneInstance) {
    const obj = this.objectMap.get(inst.id);
    if (!obj) { this.clearWallDims(); return; }
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const hits = this.raycaster.intersectObject(obj, true).filter(h => !h.object.userData['isEdge'] && h.face);
    if (!hits.length) { this.clearWallDims(); return; }
    const hit = hits[0];
    const worldNormal = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
    if (Math.abs(worldNormal.y) > 0.9) { this.clearWallDims(); return; }   // top/bottom — not handled here
    const cls = this.classifyWallFace(inst, worldNormal);
    if (!cls) { this.clearWallDims(); return; }
    this.beginWallDimension(inst, hit.point, worldNormal, cls);
  }

  /** Re-project each shown dimension's label onto the canvas (camera moved). */
  private updateWallDimScreens() {
    for (const d of this.wallDims) {
      const mid = d.originPoint.clone().add(d.hitPoint).multiplyScalar(0.5);
      d.screen = this.worldToPx(mid);
    }
  }

  /** Draw the witness line(s) for the currently-shown dimension(s). */
  private updateWallDimLines() {
    const attr = this.wallDimLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    this.wallDims.forEach((d, i) => {
      attr.setXYZ(i * 2,     d.originPoint.x, d.originPoint.y, d.originPoint.z);
      attr.setXYZ(i * 2 + 1, d.hitPoint.x,    d.hitPoint.y,    d.hitPoint.z);
    });
    attr.needsUpdate = true;
    this.wallDimLine.geometry.setDrawRange(0, this.wallDims.length * 2);
    this.wallDimLine.visible = this.wallDims.length > 0;
  }

  clearWallDims() {
    if (!this.wallDims.length) return;
    this.wallDims = [];
    if (this.wallDimLine) this.wallDimLine.visible = false;
  }

  /** Commit a typed dimension value: translate the whole wall, or move one endpoint. */
  commitWallDim(i: number) {
    const d = this.wallDims[i];
    if (!d) return;
    const value = parseFloat(d.valueStr);
    if (!isFinite(value) || value <= 0) return;
    const inst = this.instances.find(x => x.id === d.instId);
    if (!inst) return;
    this.pushHistory();

    const s = d.dist - value;   // move backward along axis (away from the hit) to grow the gap
    if (d.editKind === 'translate') {
      inst.x += d.axis.x * s; inst.y += d.axis.y * s; inst.z += d.axis.z * s;
    } else {   // 'vertex'
      if (!inst.path || d.vertexIndex === undefined) return;
      const newWorld = this.wallToWorld(inst, inst.path[d.vertexIndex]).addScaledVector(d.axis, s);
      const path = inst.path.map(p => ({ ...p }));
      path[d.vertexIndex] = this.worldToWallLocal(inst, newWorld);
      inst.path = path;
    }

    const old = this.objectMap.get(inst.id);
    if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
    this.spawnObject(inst);
    const obj = this.objectMap.get(inst.id);
    if (obj) { colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED); }
    this.updateWallHandles();
    this.clearWallDims();   // click the wall's face again to see the updated dimension(s)
  }

  // ── ПЛОЧА (slab) tool ────────────────────────────────────────────────────────

  /** Available whenever idle (no selection needed). */
  get canSlab(): boolean { return this.mode === 'idle'; }

  /** Start drawing a slab polygon on the ground (0x-0z) plane. */
  startSlab() {
    this.cancelMode();
    this.removeWallHandles();
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
      material: 'БЯЛО МАТ', path: localPath,
      x: p0.x, y: 0, z: p0.z, rotY: 0, anchor: { ...CENTRE_ANCHOR },
    };
    this.instances.push(inst);
    this.spawnObject(inst);
    return id;
  }

  // ── Line tool (arbitrary-plane sketch → Extrude) ────────────────────────────

  /** Available whenever idle (no selection needed) — drives the merged toolbar
   *  button's enabled state when nothing editable is selected. */
  get canLine(): boolean { return this.mode === 'idle'; }

  /** The merged "Line"/"Edit" toolbar button shows "Edit" exactly when there's an
   *  eligible Line selected to edit — see `canEditLine`. */
  get lineButtonLabel(): 'Line' | 'Edit' { return this.canEditLine ? 'Edit' : 'Line'; }

  /** The merged toolbar button's single click handler: cancel an active session,
   *  otherwise start one — editing the current selection if there is one, else fresh
   *  (plane-pick first). */
  onLineEditButtonClick() {
    if (this.lineSessionActive) { this.cancelMode(); return; }
    if (this.canEditLine) this.startEditSession(); else this.startNewLineSession();
  }

  /** Start a brand-new Line/Circle/Curve session: pick a construction plane first,
   *  then land in `'line-session'` (the persistent Draw-panel idle state — see
   *  `commitLinePlane`) where Line/Circle/Curve can be picked explicitly. */
  startNewLineSession() {
    this.cancelMode();
    this.removeWallHandles();
    this.lineSessionActive = true;
    this.lineSessionEditId = null;
    this.linePath = [];
    this.lineArcMids = [];
    this.lineInstanceId = null;
    this.linePlane = null;
    this.linePlanePreview = null;
    this.isDrawingCircle = false;
    this.isDrawingCurve = false;
    this.selectedSegmentIndices.clear();
    this.hoverSegIndex = null;
    this.mode = 'line-plane';
    this.modeLabel = 'Hover a surface to pick its plane (or pick XZ/XY/YZ) — click to confirm';
    // Deliberately NOT disabling OrbitControls here (unlike wall/slab/measure): an
    // arbitrary-plane tool benefits far more from being able to look around while
    // placing points, and it's conflict-free — OrbitControls only owns right-drag
    // (orbit) and middle-drag (pan); left-click stays reserved for this app's own
    // click handling (`controls.mouseButtons.LEFT = null`, set up in ngAfterViewInit).
  }

  /** Start an Edit session on the selected Line: reuse its own plane (skip the
   *  plane-pick step entirely) and drop straight into `'line-session'` idle — NOT into
   *  "click the next point" the way the old `editLine()` immediately did. From there
   *  the panel's Line/Curve tools CONTINUE this same instance from its last vertex
   *  once explicitly picked (`seedFromEditTarget`) — picking the tool is now a
   *  deliberate choice instead of something that happens automatically — Circle is the
   *  one exception, always a fresh separate instance. The instance's own segments can
   *  also be clicked (building `segmentOverlay`) to select-then-Delete them. */
  startEditSession() {
    const inst = this.selectedInstance;
    if (!inst || inst.familyId !== 'line' || !inst.plane || !inst.path) return;
    this.cancelMode();
    this.removeWallHandles();
    this.lineSessionActive = true;
    this.lineSessionEditId = inst.id;
    this.linePlane = { origin: { ...inst.plane.origin }, normal: { ...inst.plane.normal }, uAxis: { ...inst.plane.uAxis } };
    this.linePath = [];
    this.lineArcMids = [];
    this.lineInstanceId = null;
    this.isDrawingCircle = false;
    this.isDrawingCurve = false;
    this.selectedSegmentIndices.clear();
    this.hoverSegIndex = null;
    this.buildSegmentOverlay(inst);
    this.mode = 'line-session';
    this.modeLabel = 'Pick Line/Circle/Curve to draw, click segments to select, Delete to remove them — Esc to finish';
  }

  /** When editing an existing Line (`lineSessionEditId` set), seed `linePath`/
   *  `lineArcMids`/`lineInstanceId` from its already-saved plane+path (the exact same
   *  trick the old `editLine()` used, via `planePointToWorld` — the inverse of
   *  `worldToLineLocal`), so the panel's Line/Curve tools CONTINUE that same instance
   *  from its last vertex instead of starting a disconnected new one — `addLinePoint`'s
   *  existing "lineInstanceId !== null → update the existing instance" branch picks up
   *  from there with zero other changes. Returns `false` (nothing seeded) when there's
   *  no edit target, so the caller starts a brand-new shape instead. */
  private seedFromEditTarget(): boolean {
    const inst = this.lineSessionEditId !== null ? this.instances.find(i => i.id === this.lineSessionEditId) : null;
    if (!inst || !inst.path || !inst.plane) return false;
    this.linePath = inst.path.map(p => planePointToWorld(this.linePlane!, p));
    // Seed existing arcs too — addLinePoint rebuilds `path` fresh from linePath AND
    // lineArcMids on every call, so without this the first new point would silently
    // flatten every already-curved segment back to straight.
    this.lineArcMids = inst.path.map(p => p.arc ? planePointToWorld(this.linePlane!, p.arc) : null);
    this.lineInstanceId = inst.id;
    return true;
  }

  /** Flip a resumed edit's seeded `linePath`/`lineArcMids` so the NEXT point attaches
   *  to what was the path's FIRST vertex instead of its last — used by the 'line-from'
   *  click handler when that first post-edit click lands back on that other open end.
   *  `arc` describes the curve from vertex i TOWARD i+1, so reversing the vertex order
   *  also shifts which slot each arc lives in: the arc for original segment i (i.e.
   *  `lineArcMids[i]`, i = 0..n-2) becomes the arc for reversed segment (n-2-i) — the
   *  same physical curve, just now read in the opposite direction, which needs no
   *  change to the arc-mid point itself (a 3-point arc is direction-agnostic). */
  private reverseLinePathAndArcs() {
    const n = this.linePath.length;
    const newArcMids: (THREE.Vector3 | null)[] = new Array(n).fill(null);
    for (let i = 0; i < n - 1; i++) newArcMids[n - 2 - i] = this.lineArcMids[i];
    this.linePath.reverse();
    this.lineArcMids = newArcMids;
  }

  /** The panel's "Line" tool — only live while `'line-session'` idle (plane already
   *  known, whether from a fresh plane-pick or from the instance being edited). When
   *  editing, seeds the edited instance (`seedFromEditTarget`) but STILL goes to
   *  `'line-from'` — click anywhere on the plane for the new point, unconstrained
   *  (no snapping onto the last vertex required); `addLinePoint` appends it onto the
   *  already-seeded path either way. Deliberately NOT `'line-to'`: that mode's
   *  mousemove draws a ghost already dangling from the last vertex to the cursor
   *  before any click happens at all, which read as the next point being assumed
   *  rather than chosen. `'line-from'` shows no such ghost until the first click. */
  beginDrawLine() {
    if (this.mode !== 'line-session') return;
    this.isDrawingCircle = false;
    this.isDrawingCurve = false;
    const editing = this.seedFromEditTarget();
    if (!editing) { this.linePath = []; this.lineArcMids = []; this.lineInstanceId = null; }
    this.mode = 'line-from';
    this.modeLabel = editing
      ? 'Click the next point anywhere — Esc to finish'
      : 'Click the line start point — Esc to finish';
  }

  /** The panel's "Circle" tool — click centre, click again to set the radius. A circle
   *  is a fresh closed shape, not a continuation of an existing path, so — unlike
   *  Line/Curve — it's always a brand-new separate instance even during an Edit
   *  session. */
  beginDrawCircle() {
    if (this.mode !== 'line-session') return;
    this.circleCenter = null;
    this.isDrawingCircle = true;
    this.isDrawingCurve = false;
    this.mode = 'circle-center';
    this.modeLabel = 'Click the circle centre — Esc to cancel';
  }

  /** The panel's "Curve" tool — click points exactly like Line except every segment
   *  from the second point on is a 3-point arc (click the arc's mid-point, click its
   *  end — see `addLinePoint`) — no mixing within one Curve shape. Continues the
   *  edited instance exactly like `beginDrawLine`, when there is one — see its own
   *  doc comment for why this goes to `'line-from'`, not `'line-to'`. */
  beginDrawCurve() {
    if (this.mode !== 'line-session') return;
    this.pendingArcMid = null;
    this.isDrawingCircle = false;
    this.isDrawingCurve = true;
    const editing = this.seedFromEditTarget();
    if (!editing) { this.linePath = []; this.lineArcMids = []; this.lineInstanceId = null; }
    this.mode = 'line-from';
    this.modeLabel = editing
      ? 'Click the next point anywhere — Esc to finish'
      : 'Click the curve start point — Esc to finish';
  }

  /** Deterministic in-plane "u" axis for any normal — `cross(worldUp, normal)`,
   *  falling back to `cross(worldX, normal)` only when that's degenerate (normal is
   *  parallel to world up/down). For the ground plane this reduces to exactly world
   *  +X, matching СТЕНА/ПЛОЧА's own convention. */
  private stableUAxis(normal: THREE.Vector3): THREE.Vector3 {
    let u = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), normal);
    if (u.lengthSq() < 1e-6) u = new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), normal);
    return u.normalize();
  }

  /** The three quick-pick planes — hand-tuned (not run through `stableUAxis`) so each
   *  vertical one's "v" (second path coordinate) points world-up, which reads more
   *  intuitively while drawing than whatever a generic fallback would produce. XZ
   *  matches СТЕНА/ПЛОЧА's own ground convention exactly (u = +X, v = +Z). */
  private quickPickPlane(axis: 'XZ' | 'XY' | 'YZ', origin: THREE.Vector3): PlaneDesc {
    const o = { x: origin.x, y: origin.y, z: origin.z };
    switch (axis) {
      case 'XZ': return { origin: o, normal: { x: 0, y: 1, z: 0 }, uAxis: { x: 1, y: 0, z: 0 } };
      case 'XY': return { origin: o, normal: { x: 0, y: 0, z: 1 }, uAxis: { x: -1, y: 0, z: 0 } };
      case 'YZ': return { origin: o, normal: { x: 1, y: 0, z: 0 }, uAxis: { x: 0, y: 0, z: 1 } };
    }
  }

  /** Toolbar quick-pick (during 'line-plane'): skip the hover/raycast step entirely. */
  quickPickLinePlane(axis: 'XZ' | 'XY' | 'YZ') {
    if (this.mode !== 'line-plane') return;
    this.commitLinePlane(this.quickPickPlane(axis, this.controls.target.clone()));
  }

  /** Raycast the cursor against every visible mesh (same mesh-collection idiom as
   *  `pickInstance`) for a candidate construction plane: the hit face's world normal
   *  (the same extraction already proven at `tryStartWallFaceDimension`, but — unlike
   *  there — valid for ANY orientation, not just near-vertical). Empty space falls
   *  back to the ground plane at the cursor's ground intersection. */
  private pickFacePlane(e: MouseEvent): PlaneDesc {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const meshes: THREE.Mesh[] = [];
    this.objectMap.forEach(obj => {
      if (!obj.visible) return;
      obj.traverse(child => { if (child instanceof THREE.Mesh && !child.userData['isEdge']) meshes.push(child); });
    });
    const hits = this.raycaster.intersectObjects(meshes, false).filter(h => h.face);
    if (hits.length) {
      const hit = hits[0];
      const normal = hit.face!.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
      const uAxis = this.stableUAxis(normal);
      return {
        origin: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
        normal: { x: normal.x, y: normal.y, z: normal.z },
        uAxis: { x: uAxis.x, y: uAxis.y, z: uAxis.z },
      };
    }
    const pos = new THREE.Vector3();
    const onGround = this.raycaster.ray.intersectPlane(this.groundPlane, pos);
    return this.quickPickPlane('XZ', onGround ? pos : new THREE.Vector3());
  }

  /** Live indicator quad + normal arrow for the candidate plane, following the cursor. */
  private updatePlaneGhost(plane: PlaneDesc) {
    if (this.planeGhost) { this.scene.remove(this.planeGhost); disposeObj(this.planeGhost); this.planeGhost = null; }
    const { origin, normal } = planeBasis(plane);
    const group = new THREE.Group();
    const quad = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.MeshBasicMaterial({ color: 0x29b6f6, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }),
    );
    quad.position.copy(origin);
    quad.lookAt(origin.clone().add(normal));
    group.add(quad);
    const arrow = new THREE.ArrowHelper(normal, origin, 150, 0x29b6f6, 40, 20);
    group.add(arrow);
    this.planeGhost = group;
    this.scene.add(this.planeGhost);
  }

  /** Commit the candidate plane for a fresh session and drop into `'line-session'`
   *  idle — the Draw panel's Line/Circle/Curve tools (`beginDrawLine`/`beginDrawCircle`/
   *  `beginDrawCurve`) take it from there; nothing starts drawing automatically. */
  private commitLinePlane(plane: PlaneDesc) {
    if (this.planeGhost) { this.scene.remove(this.planeGhost); disposeObj(this.planeGhost); this.planeGhost = null; }
    this.linePlane = plane;
    this.linePath = [];
    this.lineArcMids = [];
    this.lineInstanceId = null;
    this.ngZone.run(() => {
      this.mode = 'line-session';
      this.modeLabel = 'Pick Line, Circle or Curve to draw — Esc to finish';
    });
  }

  /** Circle centre clicked — re-base `linePlane`'s origin onto it (same trick
   *  `addLinePoint` uses for a polyline's first vertex), so `worldToLineLocal` and
   *  `buildLinePath` need zero changes to work for a circle too. */
  private commitCircleCenter(pos: THREE.Vector3) {
    this.linePlane = { ...this.linePlane!, origin: { x: pos.x, y: pos.y, z: pos.z } };
    this.circleCenter = pos.clone();
    this.mode = 'circle-radius';
    this.modeLabel = 'Click to set the radius — Esc to cancel';
  }

  /** After a Line/Circle/Curve shape finishes (closeLine, commitCircle) — select it
   *  and drop back into the session's own idle state ('line-session'), rebuilding
   *  `lineSessionEditId`'s overlay (unaffected by drawing a separate new shape), so the
   *  Draw panel stays open ready for another shape or a segment delete, instead of
   *  exiting the whole session the way finishing used to. */
  private returnToLineSession(finishedId: number | null) {
    this.linePath = [];
    this.lineArcMids = [];
    this.lineInstanceId = null;
    this.isDrawingCircle = false;
    this.isDrawingCurve = false;
    this.circleCenter = null;
    this.pendingArcMid = null;
    this.segmentCopyFrom = null;
    if (this.segmentCopyGhost) { this.scene.remove(this.segmentCopyGhost); disposeObj(this.segmentCopyGhost); this.segmentCopyGhost = null; }
    if (finishedId !== null) this.applySelect([finishedId]);
    this.mode = 'line-session';
    this.modeLabel = 'Pick Line, Circle or Curve to draw, click segments to select, Delete to remove them — Esc to finish';
    const editInst = this.lineSessionEditId !== null ? this.instances.find(i => i.id === this.lineSessionEditId) : null;
    if (editInst) this.buildSegmentOverlay(editInst);
  }

  /** Live translucent preview of the circle while dragging out its radius. */
  private updateCircleGhost(to: THREE.Vector3) {
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    const { x, z } = this.worldToLineLocal(to);
    const radius = Math.hypot(x, z);
    if (radius < 1) return;
    const obj = buildLinePath(circlePoints(radius), true, this.linePlane!);
    const { origin } = this.linePlane!;
    obj.position.set(origin.x, origin.y, origin.z);   // buildLinePath builds relative to LOCAL (0,0,0) — see updateLineGhost's own doc comment
    ghostify(obj);
    this.ghost = obj;
    this.scene.add(this.ghost);
  }

  /** Radius point clicked — commit a new closed 'line' instance (a circle is just a
   *  Line with many vertices and no fillets), identical in every other respect to one
   *  drawn point-by-point: Extrude/Mirror/the schedule all already work on it. */
  private commitCircle(to: THREE.Vector3) {
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    const { x, z } = this.worldToLineLocal(to);
    const radius = Math.hypot(x, z);
    if (radius < 1) { this.ngZone.run(() => this.returnToLineSession(null)); return; }   // degenerate click — nothing worth creating
    this.pushHistory();
    const { origin } = this.linePlane!;
    const id = this.nextId++;
    const inst: SceneInstance = {
      id, familyId: 'line', label: `Line ${id}`,
      params: {}, material: '', path: circlePoints(radius), plane: { ...this.linePlane! }, closed: true,
      x: origin.x, y: origin.y, z: origin.z, rotY: 0, anchor: { ...CENTRE_ANCHOR },
    };
    this.instances.push(inst);
    this.spawnObject(inst);
    this.ngZone.run(() => this.returnToLineSession(id));
  }

  /** "Select Current Plane": the same hover-a-surface/quick-pick-axis plane picker the
   *  Line tool uses (pickFacePlane/updatePlaneGhost/quickPickPlane), but it just stores
   *  the result as `currentPlane` instead of starting a line — for the view-plane
   *  dropdown's 'current' option. */
  startPickCurrentPlane() {
    this.cancelMode();
    this.mode = 'pick-plane';
    this.modeLabel = 'Hover a surface to pick its plane (or pick XZ/XY/YZ) — click to confirm';
  }

  /** Toolbar quick-pick (during 'pick-plane'): skip the hover/raycast step entirely. */
  quickPickCurrentPlane(axis: 'XZ' | 'XY' | 'YZ') {
    if (this.mode !== 'pick-plane') return;
    this.commitCurrentPlane(this.quickPickPlane(axis, this.controls.target.clone()));
  }

  private commitCurrentPlane(plane: PlaneDesc) {
    if (this.planeGhost) { this.scene.remove(this.planeGhost); disposeObj(this.planeGhost); this.planeGhost = null; }
    this.currentPlane = plane;
    this.ngZone.run(() => { this.mode = 'idle'; this.modeLabel = ''; });
    if (this.viewPlane === 'current') this.setViewPlane('current');   // live-refresh if already showing it
  }

  /** World point → local (u, v) pair on `this.linePlane`, rounded to mm (matches the
   *  convention every other path-based family stores `path` in). */
  private worldToLineLocal(w: THREE.Vector3): WallPoint {
    return this.worldToPlaneLocal(this.linePlane!, w);
  }

  /** Local path points for everything drawn so far PLUS one more point `extra` —
   *  shared by every Line/Curve live-preview ghost, so a ghost shows already-curved
   *  earlier segments curved too, not just the final straight/arc preview segment. */
  private previewLocalPath(extra: THREE.Vector3): WallPoint[] {
    return [...this.linePath, extra].map((v, i) => {
      const wp = this.worldToLineLocal(v);
      const mid = this.lineArcMids[i];   // undefined for `extra` itself — fine, it has none yet
      if (mid) wp.arc = this.worldToLineLocal(mid);
      return wp;
    });
  }

  /** Live translucent preview of the in-progress segment `from`→`to`. */
  private updateLineGhost(from: THREE.Vector3, to: THREE.Vector3) {
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    const dist = from.distanceTo(to);
    if (dist < 1) { this.ngZone.run(() => { this.moveLabel = null; }); return; }
    const pts = this.previewLocalPath(to);
    const obj = buildLinePath(pts, false, this.linePlane!);
    // buildLinePath builds relative to LOCAL (0,0,0) — planeBasisMatrix is deliberately
    // rotation-only (see its own doc comment), so the caller must still place the
    // result at the plane's own origin, exactly like spawnObject does via inst.x/y/z
    // for a real instance. This step was missing here: the ghost rendered on a plane
    // with the right ORIENTATION but passing through world (0,0,0) instead of the
    // plane's actual origin — a second, phantom line parallel to the real one, through
    // the scene's centre, visible the whole time you're drawing.
    const { origin } = this.linePlane!;
    obj.position.set(origin.x, origin.y, origin.z);
    ghostify(obj);
    this.ghost = obj;
    this.scene.add(this.ghost);

    this.moveDir.copy(to).sub(from).normalize();
    const { x, y } = this.worldToPx(to);
    this.ngZone.run(() => {
      this.moveLabel = { x, y };
      if (!this.distanceLocked) this.distanceStr = String(Math.round(dist));
      if (this.distFocusPending) {
        this.distFocusPending = false;
        setTimeout(() => this.distInputRef?.nativeElement.focus());
      }
    });
  }

  /** Live translucent preview of the in-progress ARC segment `from`→`to` through
   *  `mid` (the already-clicked arc mid-point) — same shape as `updateLineGhost`, just
   *  setting the pending arc on the last committed point before appending `to`. */
  private updateCurveGhost(from: THREE.Vector3, mid: THREE.Vector3, to: THREE.Vector3) {
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    if (from.distanceTo(to) < 1) return;
    const pts = this.linePath.map((v, i) => {
      const wp = this.worldToLineLocal(v);
      const m = this.lineArcMids[i];
      if (m) wp.arc = this.worldToLineLocal(m);
      return wp;
    });
    pts[pts.length - 1].arc = this.worldToLineLocal(mid);
    pts.push(this.worldToLineLocal(to));
    const obj = buildLinePath(pts, false, this.linePlane!);
    const { origin } = this.linePlane!;
    obj.position.set(origin.x, origin.y, origin.z);
    ghostify(obj);
    this.ghost = obj;
    this.scene.add(this.ghost);
  }

  /** True when the cursor is within ~12 px of the polyline's first vertex (close gesture). */
  private nearFirstLineVertex(e: MouseEvent): boolean {
    if (this.linePath.length < 3) return false;
    const { x, y } = this.worldToPx(this.linePath[0]);
    const canvas = this.canvasRef.nativeElement;
    const r = canvas.getBoundingClientRect();
    return Math.hypot(x - (e.clientX - r.left), y - (e.clientY - r.top)) < 12;
  }

  /** Append a vertex to the current polyline and create/grow the single Line instance
   *  (wall's live-growing pattern — a Line can stay open indefinitely). The FIRST
   *  vertex re-bases `linePlane`'s origin onto itself, so the stored path keeps the
   *  usual "first vertex is local (0,0)" convention every other family already uses.
   *  `arcMidWorld`, when given (the Curve tool, or Edit's arc toggle — see
   *  `lineNextSegmentCurved`), marks the segment just completed as a 3-point arc
   *  through it — recorded on `lineArcMids` (parallel to `linePath`, see its own field
   *  comment) at the PREVIOUS point's slot, since `arc` belongs to the point that
   *  starts a segment, not the one that ends it. */
  private addLinePoint(p: THREE.Vector3, arcMidWorld?: THREE.Vector3) {
    if (this.linePath.length === 0) {
      this.linePlane = { ...this.linePlane!, origin: { x: p.x, y: p.y, z: p.z } };
    }
    this.linePath.push(p.clone());
    this.lineArcMids.push(null);   // this new point's own OUTGOING arc is unknown yet
    if (arcMidWorld && this.lineArcMids.length >= 2) {
      this.lineArcMids[this.lineArcMids.length - 2] = arcMidWorld.clone();
    }
    this.distanceLocked = false; this.distanceStr = ''; this.distFocusPending = true;
    if (this.linePath.length < 2) return;
    this.pushHistory();
    const localPath: WallPoint[] = this.linePath.map((v, i) => {
      const wp = this.worldToLineLocal(v);
      const mid = this.lineArcMids[i];
      if (mid) wp.arc = this.worldToLineLocal(mid);
      return wp;
    });
    const p0 = this.linePath[0];
    if (this.lineInstanceId === null) {
      const id = this.nextId++;
      const inst: SceneInstance = {
        id, familyId: 'line', label: `Line ${id}`,
        params: {}, material: '', path: localPath, plane: this.linePlane!, closed: false,
        x: p0.x, y: p0.y, z: p0.z, rotY: 0, anchor: { ...CENTRE_ANCHOR },
      };
      this.instances.push(inst);
      this.spawnObject(inst);
      this.lineInstanceId = id;
    } else {
      const inst = this.instances.find(i => i.id === this.lineInstanceId);
      if (!inst) return;
      // Fires both while still placing points of the SAME in-progress shape, AND when
      // beginDrawLine()/beginDrawCurve() just seeded lineInstanceId from an Edit
      // session's target (seedFromEditTarget) — either way this is "keep growing the
      // live instance `lineInstanceId` already points at", same as it always has been.
      inst.closed = false;
      inst.path = localPath;
      const old = this.objectMap.get(inst.id);
      if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
      this.spawnObject(inst);
    }
  }

  /** Close the loop (click back on the first vertex): mark the live instance closed,
   *  then drop back into the session's own idle state (`returnToLineSession`) — a
   *  third pattern distinct from wall's "just stop" and slab's "finalize on close,"
   *  since a Line is already a live instance that can ALSO close. */
  private closeLine() {
    // The live "next segment" ghost preview (updateLineGhost, driven by every line-to
    // mousemove) is never removed by anything else on THIS exit path — cancelMode()
    // cleans it up for Esc/Enter, but closing the loop by clicking back on the first
    // vertex routes here instead, a separate path that forgot to do the same. Left
    // uncleaned, the last preview segment stays in the scene forever, rendered right
    // alongside the real, now-closed line — i.e. exactly a visible "duplicate line".
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    if (this.planeGhost) { this.scene.remove(this.planeGhost); disposeObj(this.planeGhost); this.planeGhost = null; }
    const inst = this.lineInstanceId !== null ? this.instances.find(i => i.id === this.lineInstanceId) : null;
    if (inst) {
      inst.closed = true;
      const old = this.objectMap.get(inst.id);
      if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
      this.spawnObject(inst);
    }
    const id = this.lineInstanceId;
    this.clearCopyGhosts();
    this.isMarqueeing = false; this.marqueeRect = null;
    this.hideMoveMeasure();
    this.controls.enabled = true;
    this.returnToLineSession(id);
  }

  /** Whether the current selection is an existing Line eligible for an Edit session
   *  (`startEditSession`) — also decides the merged toolbar button's "Edit" vs "Line"
   *  label. Requires enough points to actually have a segment to draw more from or
   *  delete. */
  get canEditLine(): boolean {
    const inst = this.selectedInstance;
    return this.mode === 'idle' && !!inst && inst.familyId === 'line' && !!inst.path &&
      inst.path.length >= (inst.closed ? 3 : 2);
  }

  /** Encode which run (0 = `path`, 1..N = `extraPaths[0..N-1]`) and which segment
   *  index within it into one number, so `selectedSegmentIndices`/`hoverSegIndex`
   *  (and every overlay mesh's `userData`) can keep using a flat `number` key instead
   *  of a `{run, seg}` pair everywhere. 100000 segments per run is far beyond anything
   *  this tool could ever produce. */
  private static encodeSegKey(run: number, seg: number): number { return run * 100000 + seg; }
  private static decodeSegKey(key: number): { run: number; seg: number } {
    return { run: Math.floor(key / 100000), seg: key % 100000 };
  }

  /** Every run of `inst` as `(points, closed)` pairs, run 0 first (`path` itself),
   *  then each of `extraPaths` in order — the single list every segment-overlay/
   *  delete/copy/rotate operation walks instead of each special-casing `path` vs
   *  `extraPaths` separately. */
  private instanceRuns(inst: SceneInstance): { pts: WallPoint[]; closed: boolean }[] {
    return [{ pts: inst.path!, closed: !!inst.closed }, ...(inst.extraPaths ?? [])];
  }

  /** Build the transient per-segment pick+highlight overlay for `inst` — NOT a change
   *  to the Line's own everyday rendering (`buildLinePath`/`spawnObject`), a session-
   *  scoped addition cleaned up by `cancelMode` like `planeGhost`/`copyGhosts` already
   *  are. Covers EVERY run (`instanceRuns` — the main path plus any extra runs from a
   *  segment Copy), so a "disjoined" Line's extra runs are just as selectable/
   *  deletable as its main path. Each segment gets its own invisible pick-tube (tagged
   *  `segKey`, same mesh-collection raycast idiom as every other pick target in this
   *  file) and its own highlight `LineSegments` (shown hovered and/or selected — see
   *  `refreshSegmentHighlight`) — sampled independently via `filletedPolylineShape` on
   *  just that one edge's 2 points, so a curved segment's overlay is correctly curved
   *  too, not approximated as straight.
   */
  /** World-space length corresponding to 1 on-screen (CSS) pixel, measured at
   *  `atPoint` for a perspective camera (depth-dependent) or from the current ortho
   *  zoom for an orthographic one — same formula `updateSnapDotScale` already uses
   *  for the snap indicator, factored out here so `buildSegmentOverlay` can size its
   *  pick tubes to a constant ON-SCREEN radius instead of a fixed WORLD radius. A
   *  fixed world radius (what this replaced) shrinks to a sub-pixel, effectively
   *  unclickable sliver once the view is zoomed out far enough — confirmed live: a
   *  10mm world radius landed well under 2 screen pixels wide at a typical "whole
   *  line in view" zoom level, exactly dense enough to miss with an ordinary click. */
  private worldUnitsPerPixel(atPoint: THREE.Vector3): number {
    const h = this.canvasRef.nativeElement.clientHeight || 600;
    const worldHeightVisible = this.camera instanceof THREE.PerspectiveCamera
      ? 2 * this.camera.position.distanceTo(atPoint) * Math.tan((this.camera.fov * Math.PI / 180) / 2)
      : (this.camera.top - this.camera.bottom) / this.camera.zoom;
    return worldHeightVisible / h;
  }

  private buildSegmentOverlay(inst: SceneInstance) {
    if (this.segmentOverlay) { this.scene.remove(this.segmentOverlay); disposeObj(this.segmentOverlay); this.segmentOverlay = null; }
    const plane = inst.plane!;
    const origin = new THREE.Vector3(plane.origin.x, plane.origin.y, plane.origin.z);
    const pickRadius = 10 * this.worldUnitsPerPixel(origin);   // ~10 on-screen px, any zoom level
    const group = new THREE.Group();
    this.instanceRuns(inst).forEach((run, runIdx) => {
      const path = run.pts, n = path.length;
      const segCount = run.closed ? n : n - 1;
      for (let i = 0; i < segCount; i++) {
        const a = path[i], b = path[(i + 1) % n];
        const shape = filletedPolylineShape([a, b], false);
        const samples2D = shape.getPoints(16);
        const worldPts = samples2D.map(p2 => planePointToWorld(plane, { x: p2.x, z: p2.y }));
        if (worldPts.length < 2) continue;
        const segKey = AdminPageComponent.encodeSegKey(runIdx, i);

        const curve = new THREE.CurvePath<THREE.Vector3>();
        for (let k = 0; k < worldPts.length - 1; k++) curve.add(new THREE.LineCurve3(worldPts[k], worldPts[k + 1]));
        const pickGeo = new THREE.TubeGeometry(curve, worldPts.length - 1, pickRadius, 6, false);
        const pickMesh = new THREE.Mesh(pickGeo, new THREE.MeshBasicMaterial({ visible: false }));
        pickMesh.userData['segKey'] = segKey;
        group.add(pickMesh);

        const linePositions: number[] = [];
        for (let k = 0; k < worldPts.length - 1; k++) {
          const pa = worldPts[k], pb = worldPts[k + 1];
          linePositions.push(pa.x, pa.y, pa.z, pb.x, pb.y, pb.z);
        }
        const lineGeo = new THREE.BufferGeometry();
        lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
        // depthTest: false — this highlight runs along the EXACT same points as the
        // Line's own real wireframe underneath it (both zero-width LineSegments at
        // the same world position), so without it the two z-fight pixel-by-pixel
        // instead of the highlight cleanly winning: confirmed live, a selected
        // segment rendered as a muddled, inconsistent colour instead of clean orange.
        // Same fix this app's own wall vertex/edge handles already use for the same
        // "overlay that must always show through the real geometry" reason.
        const lineSegs = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: EDGE_HOVER, depthTest: false }));
        lineSegs.visible = false;   // only shown hovered/selected — see refreshSegmentHighlight
        lineSegs.renderOrder = 999;   // draw after (on top of) the real line within the same pass
        lineSegs.userData['isEdge'] = true;
        lineSegs.userData['segKey'] = segKey;
        group.add(lineSegs);
      }
    });
    this.segmentOverlay = group;
    this.scene.add(group);
  }

  /** Raycast the cursor against the overlay's pick tubes; returns the hit segment's
   *  encoded `segKey`, or null. */
  private pickOverlaySegment(e: MouseEvent): number | null {
    if (!this.segmentOverlay) return null;
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const meshes: THREE.Mesh[] = [];
    this.segmentOverlay.traverse(c => { if (c instanceof THREE.Mesh) meshes.push(c); });
    const hit = this.raycaster.intersectObjects(meshes, false)[0];
    return hit ? (hit.object.userData['segKey'] as number) : null;
  }

  /** Show each segment's highlight line while it's hovered and/or toggled into
   *  `selectedSegmentIndices` — both use the same EDGE_HOVER (orange) colour; a
   *  selected segment just stays lit without needing to be hovered too. */
  private refreshSegmentHighlight() {
    if (!this.segmentOverlay) return;
    this.segmentOverlay.traverse(c => {
      if (c instanceof THREE.LineSegments && c.userData['isEdge']) {
        const key = c.userData['segKey'] as number;
        const selected = this.selectedSegmentIndices.has(key);
        const hovered = this.hoverSegIndex === key;
        c.visible = selected || hovered;
        (c.material as THREE.LineBasicMaterial).color.set(EDGE_HOVER);   // selected or hovered — both orange
      }
    });
  }

  /** Delete button in the Draw panel — enabled once ≥1 segment of
   *  `lineSessionEditId`'s instance is toggle-selected. */
  get canDeleteSelectedSegments(): boolean {
    return this.mode === 'line-session' && this.lineSessionEditId !== null && this.selectedSegmentIndices.size > 0;
  }

  /** Cut `pts` (one run, `closed` or not) wherever an index in `removed` falls,
   *  producing zero or more surviving contiguous point-runs (each ≥2 points; a lone
   *  leftover vertex has nothing to draw and is dropped). A closed run is first
   *  rotated open at one removed edge (arbitrarily but deterministically chosen) so
   *  the same walk works for both. */
  private removeEdgesFromRun(pts: WallPoint[], closed: boolean, removed: Set<number>): WallPoint[][] {
    const n = pts.length;
    const walk = (verts: WallPoint[], removedIdx: Set<number>): WallPoint[][] => {
      const runs: WallPoint[][] = [];
      let current: WallPoint[] = [verts[0]];
      for (let i = 0; i < verts.length - 1; i++) {
        if (removedIdx.has(i)) { runs.push(current); current = [verts[i + 1]]; }
        else current.push(verts[i + 1]);
      }
      runs.push(current);
      return runs.filter(r => r.length >= 2);
    };
    if (!closed) return walk(pts, removed);
    const r0 = Math.min(...removed);   // the seam to rotate open at
    const rotated = [...pts.slice(r0 + 1), ...pts.slice(0, r0 + 1)];
    const remap = (e: number) => (e - (r0 + 1) + n) % n;
    const removedRotated = new Set<number>();
    removed.forEach(e => { if (e !== r0) removedRotated.add(remap(e)); });
    return walk(rotated, removedRotated);
  }

  /**
   * Remove every toggle-selected segment of `lineSessionEditId`'s instance in one go,
   * across however many runs (`instanceRuns` — the main `path` plus any `extraPaths`)
   * have a selected segment. Each touched run is cut independently
   * (`removeEdgesFromRun`), producing zero or more surviving point-runs for THAT run:
   * - 0 survive: that run disappears entirely (the whole instance, if it was the main
   *   path and there's no extra run left to promote in its place).
   * - 1 survives: updated in place (main `path`, or that one `extraPaths` entry).
   * - ≥2 survive: that run splits into that many new, independent top-level Line
   *   instances (same plane/material) — a fragment has no reason to stay bundled.
   * Untouched runs are left completely alone. If the main path itself disappears but
   * an untouched extra run still exists, the first extra run is promoted to be the
   * new main `path` (a Line always needs one); if nothing survives anywhere, the
   * whole instance is removed.
   */
  deleteSelectedSegments() {
    if (!this.canDeleteSelectedSegments) return;
    const instId = this.lineSessionEditId!;
    const inst = this.instances.find(x => x.id === instId);
    if (!inst || !inst.path) return;
    this.pushHistory();

    const byRun = new Map<number, Set<number>>();
    this.selectedSegmentIndices.forEach(key => {
      const { run, seg } = AdminPageComponent.decodeSegKey(key);
      (byRun.get(run) ?? byRun.set(run, new Set()).get(run)!).add(seg);
    });
    this.selectedSegmentIndices.clear();
    this.hoverSegIndex = null;

    const clonePlane = (): PlaneDesc => ({
      origin: { ...inst.plane!.origin }, normal: { ...inst.plane!.normal }, uAxis: { ...inst.plane!.uAxis },
    });
    const { x, y, z } = inst.plane!.origin;
    const spawnPieces = (runs: WallPoint[][]): number[] => runs.map(pts => {
      const id = this.nextId++;
      const piece: SceneInstance = {
        id, familyId: 'line', label: `Line ${id}`, params: {}, material: inst.material,
        path: pts.map(p => ({ ...p })), plane: clonePlane(), closed: false, x, y, z, rotY: 0, anchor: { ...CENTRE_ANCHOR },
      };
      this.instances.push(piece);
      this.spawnObject(piece);
      return id;
    });

    const newTopLevelIds: number[] = [];
    let mainGone = false;

    // Extra runs touched by the selection — process by HIGHEST index first so
    // splicing one out doesn't shift the indices of another still to be processed.
    const touchedExtraIdx = [...byRun.keys()].filter(r => r >= 1).map(r => r - 1).sort((a, b) => b - a);
    for (const extraIdx of touchedExtraIdx) {
      const removed = byRun.get(extraIdx + 1)!;
      const run = inst.extraPaths![extraIdx];
      const survivors = this.removeEdgesFromRun(run.pts, run.closed, removed);
      inst.extraPaths!.splice(extraIdx, 1);   // always remove the old entry; re-add below if it survives as one piece
      if (survivors.length === 1) {
        inst.extraPaths!.splice(extraIdx, 0, { pts: survivors[0].map(p => ({ ...p })), closed: false });
      } else if (survivors.length >= 2) {
        newTopLevelIds.push(...spawnPieces(survivors));
      }
    }
    if (inst.extraPaths && inst.extraPaths.length === 0) inst.extraPaths = undefined;

    // The main path, if the selection touched it.
    if (byRun.has(0)) {
      const survivors = this.removeEdgesFromRun(inst.path, !!inst.closed, byRun.get(0)!);
      if (survivors.length === 0) {
        if (inst.extraPaths && inst.extraPaths.length > 0) {
          // Promote the first remaining extra run to be the new main path — a Line
          // instance always needs one.
          const promoted = inst.extraPaths.shift()!;
          inst.path = promoted.pts;
          inst.closed = promoted.closed;
        } else {
          mainGone = true;
        }
      } else if (survivors.length === 1) {
        inst.path = survivors[0].map(p => ({ ...p }));
        inst.closed = false;
      } else {
        newTopLevelIds.push(...spawnPieces(survivors));
        // The main path fragmented into independent pieces — any UNTOUCHED extra runs
        // this instance still has would otherwise be silently lost; carry them onto
        // the first fragment rather than drop them (an edge case, but not a data-loss
        // one).
        if (inst.extraPaths && inst.extraPaths.length > 0 && newTopLevelIds.length > 0) {
          const carryTo = this.instances.find(i => i.id === newTopLevelIds[0]);
          if (carryTo) carryTo.extraPaths = inst.extraPaths;
        }
        mainGone = true;
      }
    }

    if (mainGone) {
      const old = this.objectMap.get(inst.id);
      if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
      this.instances = this.instances.filter(x => x.id !== inst.id);
      if (this.segmentOverlay) { this.scene.remove(this.segmentOverlay); disposeObj(this.segmentOverlay); this.segmentOverlay = null; }
      this.lineSessionEditId = null;
      this.applySelect(newTopLevelIds.length > 0 ? newTopLevelIds : []);
      return;
    }
    this.respawnLineInstance(inst);
    if (newTopLevelIds.length > 0) {
      this.buildSegmentOverlay(inst);
      this.applySelect([inst.id, ...newTopLevelIds]);
    } else {
      this.buildSegmentOverlay(inst);
    }
  }

  /** Respawn a Line instance in place after its `path` changed (segment delete). */
  private respawnLineInstance(inst: SceneInstance) {
    const old = this.objectMap.get(inst.id);
    if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
    this.spawnObject(inst);
  }

  /** Panel's Copy button — enabled with ≥1 segment selected, same as Delete. */
  get canCopySelectedSegments(): boolean {
    return this.mode === 'line-session' && this.lineSessionEditId !== null && this.selectedSegmentIndices.size > 0;
  }

  /** Every selected segment's own two (or three, with an arc) points, read once up
   *  front so the live ghost and the final commit both translate the SAME original
   *  points regardless of how many times the mouse has moved since. */
  private segmentCopySourcePts(inst: SceneInstance): WallPoint[][] {
    const out: WallPoint[][] = [];
    this.selectedSegmentIndices.forEach(key => {
      const { run, seg } = AdminPageComponent.decodeSegKey(key);
      const runArr = run === 0 ? inst.path! : inst.extraPaths?.[run - 1]?.pts;
      if (!runArr) return;
      const n = runArr.length;
      out.push([runArr[seg], runArr[(seg + 1) % n]]);
    });
    return out;
  }

  /** Start the panel's Copy tool: a 2-click translate-copy, exactly like the whole-
   *  instance Move/Copy tool's own `moveFrom`/`moveTo` gesture — click the point to
   *  measure the move FROM, then click the destination; that vector (or a typed
   *  distance along it, via the same `distanceStr` input Move already uses) is how
   *  far and which direction the duplicate(s) translate from the original segment(s)'
   *  own place. Not a typed offset: the whole point is picking the vector by clicking,
   *  same as every other move in this app. */
  startCopySegments() {
    if (!this.canCopySelectedSegments) return;
    this.mode = 'copy-seg-from';
    this.modeLabel = "Click the point to measure the copy's move from — Esc to cancel";
  }

  /** Live preview of the translated duplicate(s) while in 'copy-seg-to'. */
  private updateSegmentCopyGhost(toPos: THREE.Vector3) {
    if (this.segmentCopyGhost) { this.scene.remove(this.segmentCopyGhost); disposeObj(this.segmentCopyGhost); this.segmentCopyGhost = null; }
    const inst = this.instances.find(x => x.id === this.lineSessionEditId);
    if (!inst) return;
    const from = this.worldToLineLocal(this.segmentCopyFrom!);
    const to = this.worldToLineLocal(toPos);
    const dx = to.x - from.x, dz = to.z - from.z;
    if (Math.hypot(dx, dz) < 1) return;
    const group = new THREE.Group();
    const { origin } = this.linePlane!;
    for (const pts of this.segmentCopySourcePts(inst)) {
      const translated = pts.map(p => ({
        x: p.x + dx, z: p.z + dz,
        ...(p.arc ? { arc: { x: p.arc.x + dx, z: p.arc.z + dz } } : {}),
      }));
      const obj = buildLinePath(translated, false, this.linePlane!);
      obj.position.set(origin.x, origin.y, origin.z);
      group.add(obj);
    }
    ghostify(group);
    this.segmentCopyGhost = group;
    this.scene.add(group);
  }

  /** Second click (or typed distance) of the Copy tool: translate every selected
   *  segment's own points by `toPos - segmentCopyFrom` and add each as its own new
   *  run in `inst.extraPaths` — "a parallel duplicate directly next to the original,
   *  still part of the same Line instance" (the user's own framing), using the
   *  multi-run support `extraPaths` adds. A curved segment's own arc point
   *  translates the same way, so the copy stays curved too. */
  private finishSegmentCopy(toPos: THREE.Vector3) {
    if (this.segmentCopyGhost) { this.scene.remove(this.segmentCopyGhost); disposeObj(this.segmentCopyGhost); this.segmentCopyGhost = null; }
    const inst = this.instances.find(x => x.id === this.lineSessionEditId);
    const from = this.segmentCopyFrom;
    this.segmentCopyFrom = null;
    if (!inst || !from) { this.returnToLineSession(null); return; }
    const fromLocal = this.worldToLineLocal(from);
    const toLocal = this.worldToLineLocal(toPos);
    const dx = toLocal.x - fromLocal.x, dz = toLocal.z - fromLocal.z;
    if (Math.hypot(dx, dz) < 1) { this.returnToLineSession(null); return; }   // degenerate — nothing worth creating
    const newRuns = this.segmentCopySourcePts(inst).map(pts => ({
      closed: false,
      pts: pts.map(p => ({
        x: Math.round(p.x + dx), z: Math.round(p.z + dz),
        ...(p.arc ? { arc: { x: Math.round(p.arc.x + dx), z: Math.round(p.arc.z + dz) } } : {}),
      })),
    }));
    this.pushHistory();
    inst.extraPaths = [...(inst.extraPaths ?? []), ...newRuns];
    this.selectedSegmentIndices.clear();
    this.hoverSegIndex = null;
    this.respawnLineInstance(inst);
    this.returnToLineSession(null);
  }

  /** Panel's Rotate button — needs exactly ONE selected segment (rotating several at
   *  once around independent pivots has no single clear meaning). */
  get canRotateSelectedSegment(): boolean {
    return this.mode === 'line-session' && this.lineSessionEditId !== null && this.selectedSegmentIndices.size === 1;
  }

  /** Swing the selected segment's free endpoint around its pivot endpoint
   *  (`segmentRotatePivot`) by `segmentRotateAngle` degrees, in-plane — each click
   *  applies another increment, same "typed value, click to apply" pattern the rest
   *  of the app already uses (no new drag-handling needed). If the pivot/free
   *  endpoint is SHARED with an adjacent segment of the same connected run (true for
   *  any segment that isn't its own standalone 2-point run), that joint moves with
   *  it — the same "grab a vertex, the chain follows" semantics editing a wall/slab
   *  vertex already has. Any arc touching the moved endpoint is dropped (flattened to
   *  straight) rather than left stale — recomputing it correctly isn't worth it here. */
  rotateSelectedSegment() {
    if (!this.canRotateSelectedSegment) return;
    const inst = this.instances.find(x => x.id === this.lineSessionEditId);
    if (!inst || !inst.path) return;
    const key = [...this.selectedSegmentIndices][0];
    const { run, seg } = AdminPageComponent.decodeSegKey(key);
    const runArr = run === 0 ? inst.path : inst.extraPaths?.[run - 1]?.pts;
    if (!runArr) return;
    const n = runArr.length;
    const iA = seg, iB = (seg + 1) % n;
    const pivotIdx = this.segmentRotatePivot === 'start' ? iA : iB;
    const freeIdx = this.segmentRotatePivot === 'start' ? iB : iA;
    const pivot = runArr[pivotIdx], free = runArr[freeIdx];
    this.pushHistory();
    const rad = (this.segmentRotateAngle * Math.PI) / 180;
    const dx = free.x - pivot.x, dz = free.z - pivot.z;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    free.x = Math.round(pivot.x + dx * cos - dz * sin);
    free.z = Math.round(pivot.z + dx * sin + dz * cos);
    delete free.arc;        // free's own outgoing curvature (if any) no longer matches its new position
    runArr[iA].arc = undefined;   // this edge's own curvature (if any) no longer matches either endpoint
    this.respawnLineInstance(inst);
    this.buildSegmentOverlay(inst);
  }

  /** `run`'s own point array (0 = `path`, 1..N = `extraPaths[0..N-1]`), or `null` if
   *  that run doesn't exist — the same lookup `rotateSelectedSegment`/
   *  `copySelectedSegments` already repeat inline, factored out for the newer
   *  Offset/Trim tools below. */
  private runArrFor(inst: SceneInstance, run: number): WallPoint[] | null {
    return run === 0 ? inst.path! : inst.extraPaths?.[run - 1]?.pts ?? null;
  }

  /** Panel's Offset button — any number of selected segments (≥1), same reasoning as
   *  Copy/Delete/Trim's own multi-select support. */
  get canOffsetSelectedSegments(): boolean {
    return this.mode === 'line-session' && this.lineSessionEditId !== null && this.selectedSegmentIndices.size > 0;
  }

  /**
   * Shift every selected segment sideways by `segmentOffsetDistance` mm,
   * perpendicular to it, toward `segmentOffsetSide` — classic CAD Offset (a precise
   * perpendicular distance, unlike Copy's free 2-click vector). `segmentOffsetCopy`
   * picks which of Offset's two usual behaviours:
   * - Checked: keeps the originals and adds each selected segment's own shifted
   *   copy as a SEPARATE new `extraPaths` run — same "one independent duplicate per
   *   segment" convention `copySelectedSegments` already uses for a multi-select,
   *   just with each vector computed from the typed distance+side instead of two
   *   clicks, so there's nothing to "connect" between them.
   * - Unchecked: moves the real vertices. A vertex touched by exactly ONE selected
   *   segment just translates by that segment's own offset vector (same as a lone
   *   selection). A vertex SHARED between two ADJACENT selected segments instead
   *   moves to where their two OFFSET lines actually intersect — the correct
   *   mitred corner a connected polyline offset needs, not a naive average of two
   *   different translations (computed from the ORIGINAL geometry throughout, in
   *   one pass, so segments don't see each other's already-shifted positions).
   *   Any arc touching a moved vertex is dropped as stale, same reasoning
   *   `rotateSelectedSegment` already documents.
   * Segments from different runs are handled independently — there's no
   * "connection" between separate runs to mitre.
   */
  offsetSelectedSegments() {
    if (!this.canOffsetSelectedSegments) return;
    const inst = this.instances.find(x => x.id === this.lineSessionEditId);
    if (!inst || !inst.path) return;

    const byRun = new Map<number, Set<number>>();
    this.selectedSegmentIndices.forEach(key => {
      const { run, seg } = AdminPageComponent.decodeSegKey(key);
      (byRun.get(run) ?? byRun.set(run, new Set()).get(run)!).add(seg);
    });

    this.pushHistory();
    const newExtraRuns: { pts: WallPoint[]; closed: boolean }[] = [];

    byRun.forEach((segs, run) => {
      const runArr = this.runArrFor(inst, run);
      if (!runArr) return;
      const n = runArr.length;
      const closed = run === 0 && !!inst.closed;

      // Pass 1: each selected segment's own offset LINE, from the untouched
      // original geometry — nothing gets written to `runArr` yet.
      const segOffset = new Map<number, { iA: number; iB: number; oa: { x: number; z: number }; ob: { x: number; z: number } }>();
      segs.forEach(seg => {
        const iA = seg, iB = (seg + 1) % n;
        const a = runArr[iA], b = runArr[iB];
        const dx = b.x - a.x, dz = b.z - a.z;
        const len = Math.hypot(dx, dz);
        if (len < 1e-6) return;
        let px = -dz / len, pz = dx / len;   // unit perpendicular, 'right' side
        if (this.segmentOffsetSide === 'left') { px = -px; pz = -pz; }
        const ox = px * this.segmentOffsetDistance, oz = pz * this.segmentOffsetDistance;
        segOffset.set(seg, { iA, iB, oa: { x: a.x + ox, z: a.z + oz }, ob: { x: b.x + ox, z: b.z + oz } });
      });
      if (segOffset.size === 0) return;

      if (this.segmentOffsetCopy) {
        segOffset.forEach(({ oa, ob }, seg) => {
          const orig = runArr[seg];   // seg === the stored iA by construction
          const a2: WallPoint = { x: Math.round(oa.x), z: Math.round(oa.z) };
          const b2: WallPoint = { x: Math.round(ob.x), z: Math.round(ob.z) };
          if (orig.arc) a2.arc = { x: Math.round(orig.arc.x + (oa.x - orig.x)), z: Math.round(orig.arc.z + (oa.z - orig.z)) };
          newExtraRuns.push({ closed: false, pts: [a2, b2] });
        });
        return;
      }

      // Move mode. Which selected segment(s) touch each vertex.
      const touchers = new Map<number, number[]>();
      segOffset.forEach((off, seg) => {
        (touchers.get(off.iA) ?? touchers.set(off.iA, []).get(off.iA)!).push(seg);
        (touchers.get(off.iB) ?? touchers.set(off.iB, []).get(off.iB)!).push(seg);
      });

      const newPos = new Map<number, { x: number; z: number }>();
      touchers.forEach((segList, v) => {
        if (segList.length === 1) {
          const off = segOffset.get(segList[0])!;
          newPos.set(v, v === off.iA ? off.oa : off.ob);
        } else {
          const off1 = segOffset.get(segList[0])!, off2 = segOffset.get(segList[1])!;
          const inter = this.lineLineIntersection(
            { x: off1.oa.x, z: off1.oa.z }, { x: off1.ob.x, z: off1.ob.z },
            { x: off2.oa.x, z: off2.oa.z }, { x: off2.ob.x, z: off2.ob.z },
          );
          newPos.set(v, inter ?? (v === off1.iA ? off1.oa : off1.ob));   // parallel fallback
        }
      });

      newPos.forEach((p, v) => { runArr[v] = { x: Math.round(p.x), z: Math.round(p.z) }; });
      // Any arc into/out of a moved vertex, from an UNTOUCHED neighbour, is now stale.
      touchers.forEach((_segList, v) => {
        delete runArr[v].arc;
        if (closed || v > 0) {
          const prev = (v - 1 + n) % n;
          if (!touchers.has(prev)) runArr[prev].arc = undefined;
        }
      });
    });

    if (newExtraRuns.length > 0) inst.extraPaths = [...(inst.extraPaths ?? []), ...newExtraRuns];
    this.selectedSegmentIndices.clear();
    this.hoverSegIndex = null;
    this.respawnLineInstance(inst);
    this.buildSegmentOverlay(inst);
  }

  /** Standard 2D line–line intersection (treating each pair of points as an INFINITE
   *  line, not just the segment between them — Trim needs where they'd meet even when
   *  the actual segments fall short of or past it) — `null` if parallel/coincident. */
  private lineLineIntersection(p1: WallPoint, p2: WallPoint, p3: WallPoint, p4: WallPoint): { x: number; z: number } | null {
    const denom = (p1.x - p2.x) * (p3.z - p4.z) - (p1.z - p2.z) * (p3.x - p4.x);
    if (Math.abs(denom) < 1e-9) return null;
    const a = p1.x * p2.z - p1.z * p2.x;
    const b = p3.x * p4.z - p3.z * p4.x;
    return {
      x: (a * (p3.x - p4.x) - (p1.x - p2.x) * b) / denom,
      z: (a * (p3.z - p4.z) - (p1.z - p2.z) * b) / denom,
    };
  }

  /** Panel's Trim button — needs exactly TWO selected segments (any two: adjacent,
   *  from different runs, even ones that don't currently touch). */
  get canTrimSelectedSegments(): boolean {
    return this.mode === 'line-session' && this.lineSessionEditId !== null && this.selectedSegmentIndices.size === 2;
  }

  /** Auto-fill the Trim radius input with the CURRENT fillet radius at the two
   *  selected segments' shared corner, whenever the selection reaches exactly two —
   *  if they're already adjacent (share a vertex) and that vertex already has a
   *  radius (from a previous Trim, or the sidebar's own per-vertex corner field),
   *  you see and can tweak the real value instead of it always showing 0 as if
   *  there were never a fillet there. Leaves the field alone otherwise (0, 1 or 3+
   *  selected, or two non-adjacent segments) — Trim with a radius has no effect on
   *  a non-adjacent pair anyway (see `trimSelectedSegments`'s own doc comment). */
  private syncTrimRadiusFromSelection() {
    if (this.lineSessionEditId === null || this.selectedSegmentIndices.size !== 2) return;
    const inst = this.instances.find(x => x.id === this.lineSessionEditId);
    if (!inst || !inst.path) return;
    const [key1, key2] = [...this.selectedSegmentIndices];
    const d1 = AdminPageComponent.decodeSegKey(key1), d2 = AdminPageComponent.decodeSegKey(key2);
    if (d1.run !== d2.run) { this.segmentTrimRadius = 0; return; }
    const arr = this.runArrFor(inst, d1.run);
    if (!arr) { this.segmentTrimRadius = 0; return; }
    const n = arr.length;
    const iA1 = d1.seg, iB1 = (d1.seg + 1) % n;
    const iA2 = d2.seg, iB2 = (d2.seg + 1) % n;
    const shared = [iA1, iB1].find(i => i === iA2 || i === iB2);   // the vertex they already share, if any
    if (shared !== undefined) { this.segmentTrimRadius = arr[shared].r ?? 0; return; }
    // Not an EXACT shared vertex — check whether they're separated by nothing but a
    // degenerate zero-length run (same detection `trimSelectedSegments` itself
    // uses), so the shown radius matches what clicking Trim would actually read.
    const p = this.lineLineIntersection(arr[iA1], arr[iB1], arr[iA2], arr[iB2]);
    if (!p) { this.segmentTrimRadius = 0; return; }
    const distTo = (pt: WallPoint) => Math.hypot(pt.x - p.x, pt.z - p.z);
    const near1 = distTo(arr[iA1]) <= distTo(arr[iB1]) ? iA1 : iB1;
    const near2 = distTo(arr[iA2]) <= distTo(arr[iB2]) ? iA2 : iB2;
    const lo = Math.min(near1, near2), hi = Math.max(near1, near2);
    this.segmentTrimRadius = this.isDegenerateRun(arr, lo, hi) ? (arr[lo].r ?? arr[hi].r ?? 0) : 0;
  }

  /** Whether every point from `lo` to `hi` (inclusive) in `arr` sits at the same
   *  spot — i.e. a degenerate, zero-length run (typically leftover debris from an
   *  earlier edit), not real geometry. Shared by `syncTrimRadiusFromSelection` and
   *  `trimSelectedSegments` so both treat "separated only by a duplicate point" the
   *  same way. */
  private isDegenerateRun(arr: WallPoint[], lo: number, hi: number): boolean {
    const ref = arr[lo];
    for (let k = lo; k <= hi; k++) if (Math.hypot(arr[k].x - ref.x, arr[k].z - ref.z) > 0.5) return false;
    return true;
  }

  /**
   * Trim (or extend) the two selected segments to meet at the intersection of the
   * lines they lie on, optionally rounding that corner with `segmentTrimRadius`:
   * - Already adjacent (share a vertex): the intersection IS that vertex (for two
   *   non-collinear segments), so this reduces to just setting its fillet radius —
   *   the exact same `WallPoint.r` the sidebar's per-vertex corner field already
   *   reads, just reachable from here too.
   * - Same run, separated only by a degenerate (zero-length) run of duplicate
   *   points — typically leftover debris from an earlier edit, not a real gap —
   *   collapses that whole run into the one real vertex and rounds IT, same as the
   *   already-adjacent case (see `isDegenerateRun`): two segments that visually meet
   *   at a clean corner shouldn't silently refuse a radius just because the data has
   *   a stray duplicate point sitting between them.
   * - Same run, genuinely not adjacent: each segment's nearer endpoint moves to the
   *   intersection independently. No single vertex exists there for the existing
   *   fillet renderer to round, so a typed radius has no effect in this case.
   * - Different runs: each nearer endpoint moves to the intersection, and the two
   *   runs are then MERGED into one continuous run joined there (`mergeRunsAt`) —
   *   same "concatenate at a shared point" trick `uniteLines` already uses — so a
   *   "disjoined" Line can become whole again via Trim, not just stay separate.
   */
  trimSelectedSegments() {
    if (!this.canTrimSelectedSegments) return;
    const inst = this.instances.find(x => x.id === this.lineSessionEditId);
    if (!inst || !inst.path) return;
    const [key1, key2] = [...this.selectedSegmentIndices];
    const d1 = AdminPageComponent.decodeSegKey(key1), d2 = AdminPageComponent.decodeSegKey(key2);
    const arr1 = this.runArrFor(inst, d1.run), arr2 = this.runArrFor(inst, d2.run);
    if (!arr1 || !arr2) return;
    const n1 = arr1.length, n2 = arr2.length;
    const iA1 = d1.seg, iB1 = (d1.seg + 1) % n1;
    const iA2 = d2.seg, iB2 = (d2.seg + 1) % n2;
    const p = this.lineLineIntersection(arr1[iA1], arr1[iB1], arr2[iA2], arr2[iB2]);
    if (!p) return;   // parallel — nothing sensible to trim/extend to

    const distTo = (pt: WallPoint) => Math.hypot(pt.x - p.x, pt.z - p.z);
    const near1 = distTo(arr1[iA1]) <= distTo(arr1[iB1]) ? iA1 : iB1;
    const near2 = distTo(arr2[iA2]) <= distTo(arr2[iB2]) ? iA2 : iB2;
    const radius = this.segmentTrimRadius > 0 ? this.segmentTrimRadius : undefined;

    // `near1`/`near2` separated by nothing but a degenerate zero-length run —
    // typically leftover debris from an earlier non-adjacent Trim/segment-delete
    // (see `splitByRemovedEdges`'s own "a lone leftover vertex... is dropped" case,
    // which can still leave a duplicate point behind when its NEIGHBOUR survives) —
    // are still the SAME corner (`isDegenerateRun`): two segments that visually meet
    // at a clean corner shouldn't refuse a radius just because of a stray duplicate
    // point, the way two genuinely different, non-adjacent segments correctly do.

    this.pushHistory();
    if (d1.run === d2.run && near1 === near2) {
      arr1[near1] = { x: Math.round(p.x), z: Math.round(p.z), ...(radius ? { r: radius } : {}) };
    } else if (d1.run === d2.run && this.isDegenerateRun(arr1, Math.min(near1, near2), Math.max(near1, near2))) {
      arr1.splice(Math.min(near1, near2), Math.abs(near1 - near2) + 1,
        { x: Math.round(p.x), z: Math.round(p.z), ...(radius ? { r: radius } : {}) });
    } else if (d1.run === d2.run) {
      arr1[near1] = { x: Math.round(p.x), z: Math.round(p.z) };
      arr1[near2] = { x: Math.round(p.x), z: Math.round(p.z) };
    } else {
      arr1[near1] = { x: Math.round(p.x), z: Math.round(p.z) };
      arr2[near2] = { x: Math.round(p.x), z: Math.round(p.z) };
      this.mergeRunsAt(inst, d1.run, near1, d2.run, near2, radius);
    }
    this.selectedSegmentIndices.clear();
    this.hoverSegIndex = null;
    this.respawnLineInstance(inst);
    this.buildSegmentOverlay(inst);
  }

  /** Join two DIFFERENT runs of `inst` into one continuous run, concatenated at the
   *  point they now share (`near1`/`near2`, already moved to the same coordinates by
   *  the caller) — refuses if either run is the (possibly) CLOSED main path, since a
   *  closed loop has no free end to join from. Mirrors `uniteLines`'s own "reverse
   *  whichever side needs it so the shared point lands adjacent, then drop the
   *  duplicate" trick, just within one instance's own runs instead of across two
   *  instances. */
  private mergeRunsAt(inst: SceneInstance, run1: number, near1: number, run2: number, near2: number, radius?: number) {
    const isClosed = (r: number) => r === 0 && !!inst.closed;
    if (isClosed(run1) || isClosed(run2)) return;
    let arr1 = this.runArrFor(inst, run1)!, arr2 = this.runArrFor(inst, run2)!;
    if (near1 !== arr1.length - 1) arr1 = [...arr1].reverse();
    if (near2 !== 0) arr2 = [...arr2].reverse();
    const merged = [...arr1, ...arr2.slice(1)];
    if (radius) merged[arr1.length - 1] = { ...merged[arr1.length - 1], r: radius };

    if (run1 === 0 || run2 === 0) {
      const otherRun = run1 === 0 ? run2 : run1;
      inst.path = merged;
      inst.extraPaths!.splice(otherRun - 1, 1);
    } else {
      const lowRun = Math.min(run1, run2), highRun = Math.max(run1, run2);
      inst.extraPaths![lowRun - 1] = { closed: false, pts: merged };
      inst.extraPaths!.splice(highRun - 1, 1);
    }
    if (inst.extraPaths && inst.extraPaths.length === 0) inst.extraPaths = undefined;
  }

  /** World point → local (u, v) pair on an EXPLICIT plane (not necessarily
   *  `this.linePlane`) — the generalisation `uniteLines` needs to re-express one
   *  Line's points in another's plane; `worldToLineLocal` delegates to this for the
   *  everyday in-progress-drawing case. */
  private worldToPlaneLocal(plane: PlaneDesc, w: THREE.Vector3): WallPoint {
    const { origin, uAxis, vAxis } = planeBasis(plane);
    const delta = w.clone().sub(origin);
    return { x: Math.round(delta.dot(uAxis)), z: Math.round(delta.dot(vAxis)) };
  }

  /** "Unite" — gated on exactly two selected Line instances. */
  get canUniteLines(): boolean {
    if (this.mode !== 'idle' || this.selectedIds.size !== 2) return false;
    const insts = [...this.selectedIds].map(id => this.instances.find(i => i.id === id));
    return insts.every(i => !!i && i.familyId === 'line' && !!i.path && i.path.length >= 2 && !!i.plane);
  }

  /**
   * Merge the two selected Lines into one instance: the first keeps its own id and
   * plane; every one of the second's points (main path + any `extraPaths`) is
   * re-expressed in the first's plane (`worldToPlaneLocal`), so the two can have been
   * drawn on different (even differently oriented) planes, as long as they're meant
   * to end up on the kept one's.
   *
   * If both main paths are OPEN and a pair of their endpoints coincide (within
   * `JOIN_TOLERANCE`, in the kept plane's own local frame — a rigid re-expression,
   * so local-frame distance already equals world distance), they're welded into one
   * continuous path (the shared point kept once, the second line's run reversed
   * first if needed so the matching ends land adjacent). Otherwise — closed, or no
   * matching endpoints — the second's main path becomes just another `extraPaths`
   * run, same mechanism `copySelectedSegments` already uses. Either way, every
   * `extraPaths` run EITHER line already had carries over onto the merged instance.
   */
  uniteLines() {
    if (!this.canUniteLines) return;
    const [idA, idB] = [...this.selectedIds];
    const a = this.instances.find(i => i.id === idA)!;
    const b = this.instances.find(i => i.id === idB)!;
    this.pushHistory();

    const JOIN_TOLERANCE = 5;   // mm
    const toALocal = (p: WallPoint): WallPoint => {
      const world = planePointToWorld(b.plane!, p);
      const local = this.worldToPlaneLocal(a.plane!, world);
      if (p.arc) local.arc = this.worldToPlaneLocal(a.plane!, planePointToWorld(b.plane!, p.arc));
      return local;
    };
    const bPathLocal = b.path!.map(toALocal);
    const bExtrasLocal = (b.extraPaths ?? []).map(r => ({ closed: r.closed, pts: r.pts.map(toALocal) }));

    const dist2D = (p: WallPoint, q: WallPoint) => Math.hypot(p.x - q.x, p.z - q.z);
    let joined: WallPoint[] | null = null;
    if (!a.closed && !b.closed) {
      const aStart = a.path![0], aEnd = a.path![a.path!.length - 1];
      const bStart = bPathLocal[0], bEnd = bPathLocal[bPathLocal.length - 1];
      if (dist2D(aEnd, bStart) < JOIN_TOLERANCE) joined = [...a.path!, ...bPathLocal.slice(1)];
      else if (dist2D(aEnd, bEnd) < JOIN_TOLERANCE) joined = [...a.path!, ...[...bPathLocal].reverse().slice(1)];
      else if (dist2D(aStart, bStart) < JOIN_TOLERANCE) joined = [...[...a.path!].reverse(), ...bPathLocal.slice(1)];
      else if (dist2D(aStart, bEnd) < JOIN_TOLERANCE) joined = [...[...a.path!].reverse(), ...[...bPathLocal].reverse().slice(1)];
    }

    if (joined) {
      a.path = joined;
      a.extraPaths = [...(a.extraPaths ?? []), ...bExtrasLocal];
    } else {
      a.extraPaths = [...(a.extraPaths ?? []), { closed: !!b.closed, pts: bPathLocal }, ...bExtrasLocal];
    }
    if (a.extraPaths.length === 0) a.extraPaths = undefined;

    const oldB = this.objectMap.get(b.id);
    if (oldB) { this.scene.remove(oldB); disposeObj(oldB); this.objectMap.delete(b.id); }
    this.instances = this.instances.filter(x => x.id !== b.id);
    this.respawnLineInstance(a);
    this.applySelect([a.id]);
  }

  /** "Extrude" — a separate toolbar tool, gated on exactly one selected CLOSED Line
   *  (not tied to drawing: a Line is free to stay a Line forever). Allowed from
   *  `'line-session'` too (the Draw panel's own idle state — no shape mid-draw), not
   *  just strict `'idle'`: after Copy/Rotate-ing a segment you're still inside that
   *  session until you explicitly leave it, and Extrude shouldn't need that extra Esc
   *  first if the result is already a plain closed Line. Refuses a "disjoined" Line
   *  (one with extra runs from a segment Copy — `extraPaths`) regardless of mode:
   *  there's no single sensible solid for disconnected pieces. */
  get canExtrudeLine(): boolean {
    const inst = this.selectedInstance;
    return (this.mode === 'idle' || this.mode === 'line-session') && !!inst && inst.familyId === 'line' && !!inst.closed &&
      (!inst.extraPaths || inst.extraPaths.length === 0);
  }

  /** "Extrude" on a selected, closed Line → a new independent `SOLID N` instance. */
  extrudeLine() {
    const src = this.selectedInstance;
    if (!src || src.familyId !== 'line' || !src.closed || !src.plane || !src.path) return;
    this.pushHistory();
    const id = this.nextId++;
    const num = this.nextSolidNum++;
    const inst: SceneInstance = {
      id, familyId: 'solid', label: `SOLID ${num}`, solidOp: 'extrude',
      params: { 'ДЪЛБОЧИНА': this.lineExtrudeDepth }, material: src.material,
      path: src.path.map(p => ({ ...p })),
      plane: { origin: { ...src.plane.origin }, normal: { ...src.plane.normal }, uAxis: { ...src.plane.uAxis } },
      // x/y/z must equal plane.origin — spawnObject places the geometry there, since
      // buildSolidExtrude builds relative to LOCAL (0,0,0), not plane.origin (see
      // planeBasisMatrix's doc comment).
      closed: true, x: src.plane.origin.x, y: src.plane.origin.y, z: src.plane.origin.z,
      rotY: 0, anchor: { ...CENTRE_ANCHOR },
    };
    this.instances.push(inst);
    this.spawnObject(inst);
    src.hidden = true;
    const srcObj = this.objectMap.get(src.id);
    if (srcObj) srcObj.visible = false;
    // Extrude ends the Line's useful life as a Line (hidden, replaced by the new
    // solid) — if Extrude was clicked from inside its own Edit session (now allowed —
    // see canExtrudeLine), that session has nothing left worth editing, so leave it
    // entirely rather than keep the Draw panel open over a hidden line.
    if (this.mode === 'line-session') {
      if (this.segmentOverlay) { this.scene.remove(this.segmentOverlay); disposeObj(this.segmentOverlay); this.segmentOverlay = null; }
      this.lineSessionActive = false;
      this.lineSessionEditId = null;
      this.selectedSegmentIndices.clear();
      this.hoverSegIndex = null;
      this.linePlane = null;
      this.mode = 'idle';
      this.modeLabel = '';
    }
    this.applySelect([id]);
  }

  /** "Path-extrusion" is available only with exactly two Line instances selected,
   *  one closed (the profile) and the other — open or closed — the path. */
  get canPathExtrude(): boolean {
    if (this.mode !== 'idle' || this.selectedIds.size !== 2) return false;
    const insts = [...this.selectedIds].map(id => this.instances.find(i => i.id === id));
    if (insts.some(i => !i || i.familyId !== 'line')) return false;
    return insts.filter(i => i!.closed).length === 1;
  }

  /** Sweep the selected pair's CLOSED Line (the profile) along the OTHER one (the
   *  path) → a new independent `SOLID N` instance, same "self-contained snapshot, no
   *  live re-link" convention as `extrudeLine`. */
  sweepLines() {
    if (!this.canPathExtrude) return;
    const insts = [...this.selectedIds].map(id => this.instances.find(i => i.id === id)!);
    const profile = insts.find(i => i.closed)!;
    const path = insts.find(i => i.id !== profile.id)!;
    if (!profile.plane || !profile.path || !path.plane || !path.path) return;
    this.pushHistory();
    const id = this.nextId++;
    const num = this.nextSolidNum++;
    const origin = planePointToWorld(path.plane, path.path[0]);
    const inst: SceneInstance = {
      id, familyId: 'solid', label: `SOLID ${num}`, solidOp: 'sweep',
      params: {}, material: profile.material,
      path: profile.path.map(p => ({ ...p })),
      plane: { origin: { ...profile.plane.origin }, normal: { ...profile.plane.normal }, uAxis: { ...profile.plane.uAxis } },
      pathPoints: path.path.map(p => ({ ...p })),
      pathPlane: { origin: { ...path.plane.origin }, normal: { ...path.plane.normal }, uAxis: { ...path.plane.uAxis } },
      // closed here means the PATH's closedness (see SceneInstance's doc comment) —
      // x/y/z must equal the path's first point, same reasoning as extrudeLine.
      closed: path.closed ?? false, x: origin.x, y: origin.y, z: origin.z,
      rotY: 0, anchor: { ...CENTRE_ANCHOR },
    };
    this.instances.push(inst);
    this.spawnObject(inst);
    for (const src of [profile, path]) {
      src.hidden = true;
      const obj = this.objectMap.get(src.id);
      if (obj) obj.visible = false;
    }
    this.applySelect([id]);
  }

  // ── Move / Copy / Array (two-step snap) ────────────────────────────────────

  /** Toolbar tools are available only when something is selected and nothing else is in progress. */
  get canEdit(): boolean { return this.mode === 'idle' && this.selectedIds.size > 0; }

  /** The Mirror button is only enabled when at least one selected instance is actually
   *  mirrorable (see MIRROR_EXCLUDED_FAMILIES) — a selection of only МОДУЛ/wall/slab/line
   *  instances leaves it disabled rather than clickable-then-rejected. */
  get canMirror(): boolean {
    return this.canEdit && [...this.selectedIds].some(id => {
      const inst = this.instances.find(i => i.id === id);
      return inst && !MIRROR_EXCLUDED_FAMILIES.includes(inst.familyId);
    });
  }

  startMove()  { this.beginMoveOp('move'); }
  startCopy()  { this.beginMoveOp('copy'); }
  startArray() { this.beginMoveOp('array'); }

  /** `solid` mirrors its plane/path as data (mirrorPlane/mirrorWallPoints) — see
   *  commitDisplacement's isMirror branch. wall/slab/line remain unsupported (their
   *  geometry isn't touched by Move/Copy/Array either — a separate, pre-existing gap).
   *  module (МОДУЛ) is excluded — see MIRROR_EXCLUDED_FAMILIES. */
  startMirror() {
    const ids = [...this.selectedIds].filter(id => {
      const inst = this.instances.find(i => i.id === id);
      return inst && !MIRROR_EXCLUDED_FAMILIES.includes(inst.familyId);
    });
    if (ids.length === 0) { alert('Mirror does not support walls, slabs, lines or МОДУЛ — select a different family instead.'); return; }
    this.beginMoveOp('mirror', ids);
  }

  private beginMoveOp(kind: 'move' | 'copy' | 'array' | 'mirror', ids: number[] = [...this.selectedIds]) {
    if (ids.length === 0) return;
    this.clearWallDims();
    this.removeWallHandles();
    this.arrayCount = Math.max(1, Math.floor(Number(this.arrayCount) || 1));
    this.isCopy   = kind === 'copy';
    this.isArray  = kind === 'array';
    this.isMirror = kind === 'mirror';
    this.movePlane = 'XZ';
    this.mode = 'move-from';
    this.modeLabel = this.isMirror ? 'Click the first point of the mirror line — Esc to cancel'
                                    : 'Click reference point — Esc to cancel';
    this.distanceLocked = false;
    this.distanceStr = '';
    this.moveOrigins.clear();
    this.moveOriginRot.clear();
    this.moveOriginMirrored.clear();
    this.clearCopyGhosts();
    ids.forEach(id => {
      const inst = this.instances.find(i => i.id === id);
      if (!inst) return;
      this.moveOrigins.set(id, new THREE.Vector3(inst.x, inst.y, inst.z));
      this.moveOriginRot.set(id, inst.rotY);
      this.moveOriginMirrored.set(id, !!inst.mirrored);
      const makeGhost = (key: number) => {
        const ghost = anchorWrap(this.buildInstanceObject(inst), inst.anchor, inst.rotY, this.nominalAnchorSize(inst));
        ghost.position.set(inst.x, inst.y, inst.z);
        ghost.rotation.y = inst.rotY * (Math.PI / 180);
        ghost.scale.x = inst.mirrored ? -1 : 1;
        ghostify(ghost);
        ghost.visible = false;
        this.copyGhosts.set(key, ghost);
        this.scene.add(ghost);
      };
      if (this.isCopy) makeGhost(id);
      else if (this.isArray) for (let n = 1; n <= this.arrayCount; n++) makeGhost(this.arrayKey(id, n));
      else if (this.isMirror && this.mirrorKeepOriginal) makeGhost(id);
    });
    this.controls.enabled = false;
  }

  /** Finish a move-to: commit, reset state, leave idle. Used by both click and typed distance. */
  private finishMoveTo(pos: THREE.Vector3) {
    this.commitDisplacement(pos);
    this.isCopy = false; this.isArray = false; this.isMirror = false;
    this.mode = 'idle'; this.modeLabel = '';
    this.controls.enabled = true;
    this.snapDot.visible = false;
    this.hideMoveMeasure();
    this.distanceLocked = false; this.distanceStr = '';
    this.updateWallHandles();   // a moved wall keeps its handles at the new position
  }

  /** Cursor distance editor: the user typed → stop syncing the value from the cursor. */
  onDistanceTyped() { this.distanceLocked = true; }

  /**
   * Enter in the distance input: commit the move/copy/array along the current
   * direction, or — while drawing a wall — add the next vertex at exactly that
   * length along the current cursor direction (honouring any Shift axis-lock, since
   * `moveDir` already reflects it from the last mousemove).
   */
  commitTypedDistance() {
    if (this.mode === 'wall-to') {
      const d = parseFloat(this.distanceStr);
      if (!isFinite(d) || d <= 0 || this.moveDir.lengthSq() < 1e-9) return;
      const last = this.wallPath[this.wallPath.length - 1];
      this.addWallPoint(last.clone().addScaledVector(this.moveDir, d));
      return;
    }
    if (this.mode === 'line-to') {
      const d = parseFloat(this.distanceStr);
      if (!isFinite(d) || d <= 0 || this.moveDir.lengthSq() < 1e-9) return;
      const last = this.linePath[this.linePath.length - 1];
      this.addLinePoint(last.clone().addScaledVector(this.moveDir, d));
      return;
    }
    if (this.mode === 'copy-seg-to') {
      const d = parseFloat(this.distanceStr);
      if (!isFinite(d) || d <= 0 || this.moveDir.lengthSq() < 1e-9) return;
      this.finishSegmentCopy(this.segmentCopyFrom!.clone().addScaledVector(this.moveDir, d));
      return;
    }
    if (this.mode !== 'move-to') return;
    const d = parseFloat(this.distanceStr);
    if (!isFinite(d) || d <= 0 || this.moveDir.lengthSq() < 1e-9) return;
    const pos = this.moveFrom.clone().addScaledVector(this.moveDir, d);
    if (this.wallEdit) this.finishWallEdit(pos);
    else this.finishMoveTo(pos);
  }

  private clearCopyGhosts() {
    this.copyGhosts.forEach(g => { this.scene.remove(g); disposeObj(g); });
    this.copyGhosts.clear();
  }

  cancelMode() {
    this.clearWallDims();
    if (this.ghost) { this.scene.remove(this.ghost); disposeObj(this.ghost); this.ghost = null; }
    if (this.planeGhost) { this.scene.remove(this.planeGhost); disposeObj(this.planeGhost); this.planeGhost = null; }
    // Only a real Move or an in-place Mirror shifts the originals (and so must restore
    // them); Copy/Array and a copy-mode Mirror only ever touched ghosts, nothing to undo.
    if (this.mode === 'move-to' && !this.isCopy && !this.isArray && !(this.isMirror && this.mirrorKeepOriginal)) {
      this.moveOrigins.forEach((origin, id) => {
        const inst = this.instances.find(i => i.id === id);
        const obj  = this.objectMap.get(id);
        if (!inst || !obj) return;
        inst.x = origin.x; inst.y = origin.y; inst.z = origin.z; obj.position.copy(origin);
        if (this.isMirror) {
          const rot = this.moveOriginRot.get(id) ?? inst.rotY;
          const wasMirrored = this.moveOriginMirrored.get(id) ?? false;
          inst.rotY = rot; obj.rotation.y = rot * (Math.PI / 180);
          inst.mirrored = wasMirrored; obj.scale.x = wasMirrored ? -1 : 1;
        }
      });
    }
    // Cancelling a wall vertex/segment edit restores the original polyline.
    if (this.wallEdit && this.wallEditOrig) {
      const inst = this.instances.find(i => i.id === this.wallEdit!.instId);
      if (inst) {
        inst.path = this.wallEditOrig;
        const old = this.objectMap.get(inst.id);
        if (old) { this.scene.remove(old); disposeObj(old); this.objectMap.delete(inst.id); }
        this.spawnObject(inst);
        const obj = this.objectMap.get(inst.id);
        if (obj) { colorObj(obj, COLOR_SELECTED); setEdgeColor(obj, EDGE_SELECTED); }
      }
      this.wallEdit = null; this.wallEditOrig = null;
    }
    // Finishing a polyline tool keeps its result and selects it: walls already have a
    // live instance; a slab is finalised here from its committed polygon.
    const finishedWallId = (this.mode === 'wall-from' || this.mode === 'wall-to') ? this.wallInstanceId : null;
    const finishedSlabId = (this.mode === 'slab-from' || this.mode === 'slab-to') ? this.finalizeSlab() : null;
    // A Line already has a live instance like a wall does (closing it is a separate,
    // explicit gesture — see `closeLine()`) — Esc/Enter here just keeps it open.
    const finishedLineId = (this.mode === 'line-from' || this.mode === 'line-to' || this.mode === 'line-arc-mid') ? this.lineInstanceId : null;
    // Esc/Enter from any of a session's draw sub-modes (including Circle's, which has
    // no live instance of its own — finishedLineId stays null for it) pops back to the
    // session's own idle state ('line-session') instead of exiting the whole session —
    // see `returnToLineSession`'s own doc comment for why.
    const inLineSubDraw = finishedWallId === null && finishedSlabId === null && (
      this.mode === 'line-from' || this.mode === 'line-to' || this.mode === 'line-arc-mid' ||
      this.mode === 'circle-center' || this.mode === 'circle-radius' ||
      this.mode === 'copy-seg-from' || this.mode === 'copy-seg-to');
    // Kept (not nulled) when staying in the session below — the session's plane must
    // survive across shapes drawn within it; only a full exit actually drops it.
    const keepPlane = this.linePlane;
    this.wallPath = [];
    this.wallInstanceId = null;
    this.slabPath = [];
    this.linePath = [];
    this.lineArcMids = [];
    this.lineInstanceId = null;
    this.linePlane = null;
    this.linePlanePreview = null;
    this.isDrawingCircle = false;
    this.isDrawingCurve = false;
    this.pendingArcMid = null;
    this.circleCenter = null;
    this.segmentCopyFrom = null;
    if (this.segmentCopyGhost) { this.scene.remove(this.segmentCopyGhost); disposeObj(this.segmentCopyGhost); this.segmentCopyGhost = null; }
    if (this.segmentOverlay) { this.scene.remove(this.segmentOverlay); disposeObj(this.segmentOverlay); this.segmentOverlay = null; }
    this.clearCopyGhosts();
    this.clearHover();
    this.clearSubSelection();
    this.isCopy = false;
    this.isArray = false;
    this.isMirror = false;
    this.matchSourceId = null;
    this.distanceLocked = false; this.distanceStr = '';
    this.isMarqueeing = false;
    this.marqueeRect  = null;
    this.orbiting = false;
    this.snapDot.visible = false;
    this.hideMoveMeasure();
    this.hideMeasure();
    this.controls.enabled = true;
    const finishedId = finishedWallId !== null ? finishedWallId : finishedSlabId !== null ? finishedSlabId : finishedLineId;
    this.updateWallHandles();
    if (this.lineSessionActive && inLineSubDraw) {
      this.linePlane = keepPlane;
      this.mode = 'line-session';
      this.modeLabel = 'Pick Line, Circle or Curve to draw, click segments to select, Delete to remove them — Esc to finish';
      if (finishedId !== null) this.applySelect([finishedId]);
      const editInst = this.lineSessionEditId !== null ? this.instances.find(i => i.id === this.lineSessionEditId) : null;
      if (editInst) this.buildSegmentOverlay(editInst);
    } else {
      this.mode = 'idle'; this.modeLabel = '';
      if (finishedId !== null) this.applySelect([finishedId]);
      this.lineSessionActive = false;
      this.lineSessionEditId = null;
      this.selectedSegmentIndices.clear();
      this.hoverSegIndex = null;
    }
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
   * Shift-constrained measuring: lock the second point onto the X, Y or Z axis line
   * through the first point, so the measured segment is always parallel to 0x, 0y or 0z
   * — including the vertical (Y) axis, i.e. NOT confined to the XZ plane.
   *
   * The cursor is projected onto the view-facing plane through the first point (a stable
   * 3D point at the same depth), then we lock to whichever axis the drag deviates along
   * most. So dragging mostly upward measures along 0y, sideways along 0x / 0z — pick the
   * view (orbit mid-measure) that shows the axis you want.
   */
  private axisLockedMeasurePoint(e: MouseEvent): THREE.Vector3 | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const from = this.measureFrom;
    const n = new THREE.Vector3();
    this.camera.getWorldDirection(n);
    const viewPlane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, from);
    const raw = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(viewPlane, raw)) return null;
    const pos = this.projectOntoDominantAxis(from, raw);
    pos.x = Math.round(pos.x); pos.y = Math.round(pos.y); pos.z = Math.round(pos.z);
    return pos;
  }

  /**
   * Pin `to` onto whichever of the X/Y/Z axis lines through `from` its own offset from
   * `from` deviates along most — the other two coordinates stay pinned to `from`.
   */
  private projectOntoDominantAxis(from: THREE.Vector3, to: THREE.Vector3): THREE.Vector3 {
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    const pos = from.clone();
    if (ax >= ay && ax >= az)       pos.x = to.x;
    else if (ay >= ax && ay >= az)  pos.y = to.y;
    else                            pos.z = to.z;
    return pos;
  }

  /**
   * Shift-held measuring: lock the second point onto an axis through the first, same as
   * always — but when a real object snap (endpoint/midpoint/origin) is under the cursor,
   * project THAT point onto the axis instead of the raw mouse ray. Measuring straight to
   * the snapped point itself would silently ignore the lock (a diagonal distance); this
   * way a known point still drives an exact, jitter-free axis-locked measurement to it.
   */
  private measureSnapOrAxisLock(e: MouseEvent): { pos: THREE.Vector3; type: 'axis' } | null {
    const obj = this.findObjectSnap(e, null);
    if (obj) return { pos: this.projectOntoDominantAxis(this.measureFrom, obj.world), type: 'axis' };
    const pos = this.axisLockedMeasurePoint(e);
    return pos ? { pos, type: 'axis' } : null;
  }

  /**
   * Closest point on the infinite line (through `from`, unit direction `dir`) to the view
   * `ray` — closest approach of two skew lines. Null when the line is ~parallel to the ray.
   */
  private closestPointOnAxisToRay(from: THREE.Vector3, dir: THREE.Vector3, ray: THREE.Ray): THREE.Vector3 | null {
    const d2 = ray.direction;
    const b = dir.dot(d2);
    const denom = 1 - b * b;
    if (Math.abs(denom) < 1e-4) return null;
    const w0 = new THREE.Vector3().subVectors(from, ray.origin);
    const s = (b * d2.dot(w0) - dir.dot(w0)) / denom;
    return from.clone().addScaledVector(dir, s);
  }

  /**
   * Snap the cursor onto a world axis line — 0x, 0y OR 0z — when its screen projection
   * passes within a few pixels of the cursor. Unlike the ground-plane grid snap (which is
   * pinned to y = 0 and so only reaches 0x / 0z), this can land a point anywhere on the
   * vertical 0y axis. Returns null when no axis is close enough.
   */
  private worldAxisSnap(e: MouseEvent): { pos: THREE.Vector3; type: 'axis' } | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const ray = this.raycaster.ray;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const O = new THREE.Vector3(0, 0, 0);
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
    const AXIS_PX = 10;
    let best: THREE.Vector3 | null = null, bestDist = AXIS_PX;
    for (const dir of axes) {
      const p = this.closestPointOnAxisToRay(O, dir, ray);
      if (!p) continue;
      const px = this.worldToPx(p);
      const d = Math.hypot(px.x - cx, px.y - cy);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    if (!best) return null;
    best.x = Math.round(best.x); best.y = Math.round(best.y); best.z = Math.round(best.z);
    return { pos: best, type: 'axis' };
  }

  /**
   * Free measure-cursor snap: object endpoints/midpoints first, then the world axes
   * (incl. the vertical 0y), then the ground grid. Lets a measurement start or end on a
   * point of the Y axis, which the ground-plane snap alone can't reach.
   */
  private measureSnap(e: MouseEvent): { pos: THREE.Vector3; type: 'endpoint' | 'midpoint' | 'origin' | 'axis' | 'grid' } | null {
    const obj = this.findObjectSnap(e, null);
    if (obj) return { pos: obj.world.clone(), type: obj.type };
    return this.worldAxisSnap(e) ?? this.getSnap(e, null, null);
  }

  /**
   * Orbit the camera around the OrbitControls target by a screen-pixel delta — used to
   * let the user rotate the view (Shift + middle/scroll drag) WHILE a two-click tool has
   * the controls disabled. Matches OrbitControls' default rotate speed; the per-frame
   * controls.update() re-reads the camera position, so there's no jump when the tool ends.
   */
  private orbitCamera(dx: number, dy: number) {
    const h = this.canvasRef.nativeElement.clientHeight || 1;
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const sph = new THREE.Spherical().setFromVector3(offset);
    sph.theta -= 2 * Math.PI * dx / h;
    sph.phi   -= 2 * Math.PI * dy / h;
    const EPS = 1e-4;
    sph.phi = Math.max(EPS, Math.min(Math.PI - EPS, sph.phi));
    sph.makeSafe();
    offset.setFromSpherical(sph);
    this.camera.position.copy(target).add(offset);
    this.camera.lookAt(target);
  }

  /**
   * Orbit the camera around an arbitrary `pivot` (the current selection's centre) by a
   * screen-pixel delta, exactly like Revit's dynamic-view orbit: INCREMENTAL rotation
   * composed onto the camera's CURRENT orientation, never an absolute `lookAt(pivot)`.
   *
   * `orbitCamera` above (and OrbitControls itself) always ends with `camera.lookAt(target)`
   * — fine when `target` already IS wherever the camera is looking, but the moment you
   * retarget to a genuinely different point (the selection, which the camera usually
   * isn't currently centred on), that absolute lookAt snaps the view instantly, even with
   * zero mouse movement. Rotating the existing orientation by the SAME small delta used to
   * move the offset-from-pivot keeps dx=dy=0 a true no-op and makes every subsequent delta
   * continuous, so there is never a jump — only genuine drag input changes anything.
   *
   * `controls.target` is kept glued to exactly where the camera ends up facing (same
   * distance as before) so OrbitControls' own per-frame `lookAt(target)` in `animate()`
   * is always a no-op against this and never fights it; pan/zoom immediately afterward
   * then behave exactly as if this had been a native orbit.
   */
  private orbitCameraAroundPivot(dx: number, dy: number, pivot: THREE.Vector3) {
    if (dx === 0 && dy === 0) return;
    const h = this.canvasRef.nativeElement.clientHeight || 1;
    const thetaDelta = -2 * Math.PI * dx / h;
    let phiDelta = -2 * Math.PI * dy / h;

    // Clamp the SAME way OrbitControls clamps its polar angle, tracked relative to the
    // pivot (not the camera's actual look direction, which this never forces to align)
    // so a long drag still can't flip the camera upside down.
    const EPS = 1e-4;
    const clamped = Math.max(EPS - this.customOrbitPhi, Math.min(Math.PI - EPS - this.customOrbitPhi, phiDelta));
    this.customOrbitPhi += clamped;
    phiDelta = clamped;

    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), thetaDelta);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const qPitch = new THREE.Quaternion().setFromAxisAngle(right, phiDelta);
    const dq = qYaw.multiply(qPitch);

    const offset = this.camera.position.clone().sub(pivot);
    offset.applyQuaternion(dq);
    this.camera.position.copy(pivot).add(offset);
    this.camera.quaternion.premultiply(dq);

    const dist = this.controls.target.distanceTo(this.camera.position) || 1;
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.controls.target.copy(this.camera.position).addScaledVector(forward, dist);
  }

  /**
   * Dolly the camera toward / away from the OrbitControls target by a wheel delta —
   * keeps scroll-zoom working while a two-click tool has the controls disabled. Matches
   * OrbitControls' zoom step and respects its min/max distance clamps.
   */
  private dollyCamera(deltaY: number) {
    const target = this.controls.target;
    const offset = this.camera.position.clone().sub(target);
    const step = Math.pow(0.95, this.controls.zoomSpeed);
    offset.multiplyScalar(deltaY < 0 ? step : 1 / step);   // wheel up (deltaY<0) → zoom in
    const r = Math.max(this.controls.minDistance, Math.min(this.controls.maxDistance, offset.length()));
    offset.setLength(r);
    this.camera.position.copy(target).add(offset);
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
    // Mirror ignores `toPos` — the mirror line is already fully fixed by moveFrom/moveDir
    // (any point further along the same line reflects identically), so this also means
    // commitTypedDistance's existing "commit at a typed distance" path keeps working for
    // Mirror unmodified: whatever `pos` it computes is simply unused here.
    if (this.isMirror) return this.mirrorPoint(origin);
    const fx = this.moveFrom.x, fy = this.moveFrom.y, fz = this.moveFrom.z;
    switch (this.movePlane) {
      case 'XZ': return new THREE.Vector3(origin.x + toPos.x - fx, origin.y,                origin.z + toPos.z - fz);
      case 'XY': return new THREE.Vector3(origin.x + toPos.x - fx, origin.y + toPos.y - fy, origin.z);
      case 'YZ': return new THREE.Vector3(origin.x,                origin.y + toPos.y - fy, origin.z + toPos.z - fz);
    }
  }

  /** Reflect a world point (X/Z only — Y untouched) across the mirror line through
   *  `moveFrom` with unit direction `moveDir` (both captured by the existing move-from/
   *  move-to click pair, reused as a line rather than a translation vector). */
  private mirrorPoint(p: THREE.Vector3): THREE.Vector3 {
    const A = this.moveFrom, D = this.moveDir;
    const vx = p.x - A.x, vz = p.z - A.z;
    const dot = vx * D.x + vz * D.z;
    return new THREE.Vector3(A.x + (2 * dot * D.x - vx), p.y, A.z + (2 * dot * D.z - vz));
  }

  /** Reflect a heading (rotY, degrees) across the same mirror line's own angle — the
   *  angle convention matches how `rotY` is turned into a direction elsewhere
   *  (`obj.rotation.y = rotY * Math.PI/180`, a plain Y-axis rotation). */
  private mirrorRotY(rotYDeg: number): number {
    const lineAngleDeg = Math.atan2(this.moveDir.x, this.moveDir.z) * 180 / Math.PI;
    return 2 * lineAngleDeg - rotYDeg;
  }

  /** Reflect a free vector (direction, not a point — no translation) across the mirror
   *  line's vertical plane. Used on a construction plane's `normal`/`uAxis`, never on a
   *  world point (use `mirrorPoint` for those). */
  private mirrorVectorXZ(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    const D = this.moveDir;
    const dot = v.x * D.x + v.z * D.z;
    return { x: 2 * dot * D.x - v.x, y: v.y, z: 2 * dot * D.z - v.z };
  }

  /**
   * Mirror a Line/SOLID construction plane. `uAxis` is reflected as a free vector, but the
   * derived `vAxis` (= `uAxis × normal`, see PlaneDesc's own doc comment) of the reflected
   * basis ends up NEGATED relative to a faithfully-reflected original `vAxis` — any
   * reflection flips a cross product's sign (det = -1). `mirrorWallPoints` compensates by
   * negating each point's `z` (its local v-coordinate) to match, while `x` (the
   * u-coordinate) stays as-is since `uAxis` itself was already reflected. Verified by hand
   * against a direct world-point reflection during implementation, not just derived.
   */
  private mirrorPlane(plane: PlaneDesc): PlaneDesc {
    const o = this.mirrorPoint(new THREE.Vector3(plane.origin.x, plane.origin.y, plane.origin.z));
    return {
      origin: { x: o.x, y: o.y, z: o.z },
      normal: this.mirrorVectorXZ(plane.normal),
      uAxis: this.mirrorVectorXZ(plane.uAxis),
    };
  }

  /** Mirror a Line/SOLID's local (x, z) path points for use with a plane already mirrored
   *  by `mirrorPlane` — see that method's doc comment for why `z` (not `x`) is negated. */
  private mirrorWallPoints(points: WallPoint[]): WallPoint[] {
    return points.map(p => ({ x: p.x, z: -p.z, r: p.r, arc: p.arc ? { x: p.arc.x, z: -p.arc.z } : undefined }));
  }

  /**
   * Preview (no data write, runs outside Angular zone):
   * - Move:  shift the live objects to the destination.
   * - Copy:  show one ghost per object at the destination.
   * - Array: show `arrayCount` ghosts per object, stepped by the same delta.
   */
  private previewDisplacement(toPos: THREE.Vector3) {
    if (this.isMirror) {
      this.moveOrigins.forEach((origin, id) => {
        const inst = this.instances.find(i => i.id === id);
        if (!inst) return;
        const obj = this.mirrorKeepOriginal ? this.copyGhosts.get(id) : this.objectMap.get(id);
        if (!obj) return;
        if (this.mirrorKeepOriginal) obj.visible = true;
        obj.position.copy(this.mirrorPoint(origin));
        obj.rotation.y = this.mirrorRotY(this.moveOriginRot.get(id) ?? inst.rotY) * (Math.PI / 180);
        obj.scale.x = inst.mirrored ? 1 : -1;   // flip of the source's current handedness
      });
      return;
    }
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

  /**
   * Spawn a duplicate of `src` at (x,y,z), select-tracked via its returned id. Copy/Array
   * omit `rotY`/`mirrored` (keep the source's own); Mirror passes the reflected values.
   * Deep-copies every path-based field too (plane/closed/solidOp/pathPlane/pathPoints/
   * isVoid/voidExcludeIds) so a Copy/Array of a wall/line/SOLID carries its full geometry
   * (previously silently dropped here) — `overrides` lets Mirror substitute the already-
   * mirrored plane/path for a SOLID instead of the source's own.
   */
  private spawnCopyAt(
    src: SceneInstance, x: number, y: number, z: number,
    rotY: number = src.rotY, mirrored: boolean | undefined = src.mirrored,
    overrides: Partial<SceneInstance> = {},
  ): number {
    const nid = this.nextId++;
    const clonePlane = (pl?: PlaneDesc) => pl ? { origin: { ...pl.origin }, normal: { ...pl.normal }, uAxis: { ...pl.uAxis } } : undefined;
    const inst: SceneInstance = {
      id: nid, familyId: src.familyId, label: `МОДУЛ ${nid}`,
      params: { ...src.params }, material: src.material, materials: src.materials ? { ...src.materials } : undefined, x, y, z, rotY,
      mirrored,
      anchor: src.anchor ? { ...src.anchor } : { ...CENTRE_ANCHOR },
      path: src.path ? src.path.map(p => ({ ...p })) : undefined,
      plane: clonePlane(src.plane),
      closed: src.closed,
      solidOp: src.solidOp,
      pathPlane: clonePlane(src.pathPlane),
      pathPoints: src.pathPoints ? src.pathPoints.map(p => ({ ...p })) : undefined,
      extraPaths: src.extraPaths ? src.extraPaths.map(r => ({ closed: r.closed, pts: r.pts.map(p => ({ ...p })) })) : undefined,
      isVoid: src.isVoid,
      voidExcludeIds: src.voidExcludeIds ? [...src.voidExcludeIds] : undefined,
      ...overrides,
    };
    this.instances.push(inst);
    this.spawnObject(inst);
    return nid;
  }

  /** Commit: Move writes positions; Copy spawns one duplicate; Array spawns N stepped duplicates. */
  private commitDisplacement(toPos: THREE.Vector3) {
    this.pushHistory();
    // A void SOLID being moved/copied/arrayed changes what it cuts — recut everyone
    // else once the operation below is done, for whichever of these three paths runs.
    const anyVoidMoved = [...this.moveOrigins.keys()].some(id => {
      const i = this.instances.find(x => x.id === id);
      return i?.familyId === 'solid' && i.isVoid;
    });
    if (this.isMirror) {
      const newIds: number[] = [];
      this.moveOrigins.forEach((origin, id) => {
        const src = this.instances.find(i => i.id === id);
        if (!src) return;
        const p = this.mirrorPoint(origin);
        const rot = this.mirrorRotY(this.moveOriginRot.get(id) ?? src.rotY);
        // SOLID's shape is explicit world-space data (plane + local path points), so it's
        // mirrored by transforming THAT data (mirrorPlane/mirrorWallPoints) — correct for
        // any orientation, including a tilted/face-picked plane — rather than the cosmetic
        // scale.x flip the other families use (which only works because their geometry is
        // fixed local params around a world anchor point, with no equivalent for an
        // explicit path/plane). `mirrored` stays unset for SOLID; the flip is already baked
        // into its data, so no render-level flip is needed (or correct) on top of it.
        const isSolid = src.familyId === 'solid';
        const solidOverrides: Partial<SceneInstance> = !isSolid ? {} : {
          path: src.path ? this.mirrorWallPoints(src.path) : undefined,
          plane: src.plane ? this.mirrorPlane(src.plane) : undefined,
          pathPlane: src.pathPlane ? this.mirrorPlane(src.pathPlane) : undefined,
          pathPoints: src.pathPoints ? this.mirrorWallPoints(src.pathPoints) : undefined,
        };
        if (this.mirrorKeepOriginal) {
          newIds.push(this.spawnCopyAt(src, p.x, p.y, p.z, rot, isSolid ? src.mirrored : !src.mirrored, solidOverrides));
        } else {
          const obj = this.objectMap.get(id);
          src.x = p.x; src.y = p.y; src.z = p.z; src.rotY = rot;
          if (isSolid) Object.assign(src, solidOverrides);
          else src.mirrored = !src.mirrored;
          if (obj) {
            if (isSolid) {
              // The geometry itself changed (not just its transform) — rebuild rather than
              // try to re-transform the existing mesh.
              this.scene.remove(obj); disposeObj(obj); this.objectMap.delete(id);
              this.spawnObject(src);
            } else {
              obj.position.copy(p); obj.rotation.y = rot * (Math.PI / 180); obj.scale.x = src.mirrored ? -1 : 1;
            }
          }
        }
      });
      if (this.mirrorKeepOriginal) { this.clearCopyGhosts(); this.applySelect(newIds); }
      if (anyVoidMoved) this.respawnAllVoidTargets();
      return;
    }
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
      if (anyVoidMoved) this.respawnAllVoidTargets();
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
      if (anyVoidMoved) this.respawnAllVoidTargets();
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
    if (anyVoidMoved) this.respawnAllVoidTargets();
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

  /**
   * Plane-correct wrapper around `getSnap` for an ARBITRARY (non-axis-aligned) plane
   * — used by the Line tool. `getSnap`'s object-snap branch (`plane.projectPoint`) is
   * already plane-agnostic, but its grid-fallback branch rounds each WORLD axis
   * independently, which only coincidentally stays on-plane when the plane IS
   * axis-aligned (exactly one axis is actually constrained there). For a tilted
   * plane that independent rounding generally knocks the point off-plane entirely —
   * only the grid-snap case needs correcting, by re-rounding in the plane's own
   * local (u, v) coordinates instead.
   */
  private getSnapOnPlane(
    e: MouseEvent, plane: PlaneDesc, skip: Set<number> | null,
  ): { pos: THREE.Vector3; type: 'endpoint' | 'midpoint' | 'origin' | 'axis' | 'grid' } | null {
    const { origin, normal, uAxis, vAxis } = planeBasis(plane);
    const threePlane = new THREE.Plane(normal, -normal.dot(origin));
    const snap = this.getSnap(e, threePlane, skip);
    if (!snap || snap.type !== 'grid') return snap;
    const delta = snap.pos.clone().sub(origin);
    const u = Math.round(delta.dot(uAxis));
    const v = Math.round(delta.dot(vAxis));
    const pos = origin.clone().addScaledVector(uAxis, u).addScaledVector(vAxis, v);
    return { pos, type: 'grid' };
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
   * Keep the endpoint/midpoint snap indicator a constant SCREEN size (a fixed pixel
   * radius) regardless of camera zoom — it's a UI affordance, not a piece of real
   * geometry, so it shouldn't grow huge up close or shrink to nothing zoomed out
   * (its geometry is authored at a fixed 8mm world radius; this rescales it live).
   * Perspective: screen size ∝ worldSize / distance-to-camera, so worldSize must scale
   * ∝ distance to stay constant. Orthographic (the 2D plan/elevation views): screen
   * size ∝ worldSize / frustum-height, independent of distance — scales off that
   * instead. Run every frame (cheap — one sphere) so it's correct through zooming,
   * panning, and camera-type switches alike, not just on the next mouse move.
   */
  private updateSnapDotScale() {
    if (!this.snapDot?.visible) return;
    const targetPx = 7;   // desired on-screen radius, CSS pixels
    const h = this.canvasRef.nativeElement.clientHeight || 600;
    let worldHeightVisible: number;
    if (this.camera instanceof THREE.PerspectiveCamera) {
      const dist = this.camera.position.distanceTo(this.snapDot.position);
      worldHeightVisible = 2 * dist * Math.tan((this.camera.fov * Math.PI / 180) / 2);
    } else {
      // OrbitControls' wheel-zoom for an orthographic camera scales `.zoom`, not
      // top/bottom (those stay fixed at whatever setViewPlane originally fit them
      // to) — missing this divide was the actual bug: the dot stayed sized for the
      // view's ORIGINAL framing and grew more oversized the further you zoomed in.
      worldHeightVisible = (this.camera.top - this.camera.bottom) / this.camera.zoom;
    }
    const baseRadius = 8;   // the sphere geometry's own authored radius (SphereGeometry(8,…))
    this.snapDot.scale.setScalar((targetPx / h) * worldHeightVisible / baseRadius);
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

    this.camera = this.perspectiveCamera = new THREE.PerspectiveCamera(55, w / h, 1, 100000);
    this.camera.position.set(1500, 1200, 1500);
    this.camera.lookAt(0, 0, 0);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(this.ambientLight);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3000, 5000, 3000);
    key.castShadow = true;
    key.shadow.mapSize.set(4096, 4096);   // paired with fitShadowFrustum() shrinking the frustum to the scene
    key.shadow.camera.near = 10; key.shadow.camera.far = 30000;
    key.shadow.camera.left = key.shadow.camera.bottom = -8000;
    key.shadow.camera.right = key.shadow.camera.top   =  8000;
    this.keyLight = key;
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x8899ff, 0.3);
    fill.position.set(-3000, -2000, -3000);
    this.fillLight = fill;
    this.scene.add(fill);
    this.applyLighting();
    this.applyViewportBackground();

    const grid = new THREE.GridHelper(5000, 500, 0x2a2a2a, 0x1a1a1a);
    const axisLen = 500;
    const axes = new THREE.AxesHelper(axisLen);
    // X/Y/Z labels at the tip of each axis arrow
    const lblX = this.makeAxisLabel('X', 0xff5555, new THREE.Vector3(axisLen + 70, 0, 0));
    const lblY = this.makeAxisLabel('Y', 0x55ff55, new THREE.Vector3(0, axisLen + 70, 0));
    const lblZ = this.makeAxisLabel('Z', 0x5588ff, new THREE.Vector3(0, 0, axisLen + 70));
    this.viewHelpers = [grid, axes, lblX, lblY, lblZ];
    this.viewHelpers.forEach(h => this.scene.add(h));

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

    // Witness lines for the wall-face temporary dimensions (up to 2 independent
    // segments — one per direction — drawn via setDrawRange; hidden until wallDims.length).
    const wallDimGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(),
    ]);
    this.wallDimLine = new THREE.LineSegments(wallDimGeo, new THREE.LineBasicMaterial({ color: 0x00e5ff }));
    this.wallDimLine.visible = false;
    this.wallDimLine.renderOrder = 998;
    this.scene.add(this.wallDimLine);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.mouseButtons.LEFT   = null as any; // left-drag reserved for selection/marquee
    this.controls.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
    this.controls.mouseButtons.RIGHT  = THREE.MOUSE.ROTATE;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    // Both OrbitControls' native dolly (wheel) and pan (middle-drag) are already
    // distance-proportional by design (dolly multiplies the camera's offset by a
    // ratio; pan scales with distance-to-target via the FOV) — that's correct, it's
    // what keeps a drag feeling the same on screen at any zoom level. But the
    // defaults (1.0 each) move so little per tick/pixel that at this app's full
    // zoom range (3mm–50000mm, after lowering minDistance) it reads as "barely
    // moving" rather than "fine control". Bumping both keeps the same proportional
    // behaviour, just faster.
    this.controls.zoomSpeed = 1;
    this.controls.panSpeed = 2;
    // 50mm used to be the closest the camera could dolly to its target — too far to
    // inspect small detail (edge bands, fillets, the IsVoid cut channels, etc.), which
    // are often just a few mm across. 3mm stays safely above camera.near (1mm) so
    // nothing clips, while letting the user get genuinely close.
    this.controls.minDistance = 3;
    this.controls.maxDistance = 50000;
    // Keep the wall-face dimension labels glued to their 3D anchors while the user
    // orbits/pans/zooms (idle — OrbitControls stays enabled while they're shown).
    this.controls.addEventListener('change', () => {
      this.accumDirty = true;   // camera moved → restart Render-mode accumulation
      if (this.wallDims.length) this.ngZone.run(() => this.updateWallDimScreens());
      // Re-size the segment-overlay pick tubes for the new zoom level too — they're
      // sized to a constant ON-SCREEN radius (worldUnitsPerPixel), not a fixed world
      // one, so they'd otherwise stay sized for whatever zoom the Edit session
      // started at instead of tracking a zoom/pan/orbit that happens mid-session.
      if (this.lineSessionEditId !== null) {
        const inst = this.instances.find(i => i.id === this.lineSessionEditId);
        // Rebuilding makes fresh meshes (all hidden by default) — restore whichever
        // were already selected, or they'd visually "lose" their highlight on every
        // orbit/pan/zoom even though selectedSegmentIndices itself is untouched.
        if (inst) { this.buildSegmentOverlay(inst); this.refreshSegmentHighlight(); }
      }
    });
    // Right-drag-to-orbit is handled natively by OrbitControls EXCEPT when a selection
    // is active (see the capture-phase 'pointerdown' listener below + onCanvasDown/
    // onCanvasMove/onCanvasUp's customOrbiting branch), which instead orbits around the
    // selection's own centre via orbitCameraAroundPivot — see that method for why a
    // native OrbitControls retarget can't be used here without visibly snapping the view.
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 2 && this.mode === 'idle' && this.selectedIds.size > 0 && this.controls.enabled && this.viewPlane === '3D') {
        e.stopPropagation();   // steal this gesture before OrbitControls' own handler sees it
      }
    }, { capture: true });

    this.boundDown  = (e) => this.onCanvasDown(e);
    this.boundClick = (e) => this.onCanvasClick(e);
    this.boundMove  = (e) => this.onCanvasMove(e);
    this.boundUp    = (e) => this.onCanvasUp(e);
    this.boundWheel = (e) => this.onCanvasWheel(e);
    this.boundCanvasLeave = () => { this.clearHover(); this.ngZone.run(() => { this.hoveredInst = null; }); };
    canvas.addEventListener('mousedown', this.boundDown);
    canvas.addEventListener('click',     this.boundClick);
    canvas.addEventListener('mousemove', this.boundMove);
    canvas.addEventListener('mouseup',   this.boundUp);
    canvas.addEventListener('wheel',     this.boundWheel, { passive: false });
    canvas.addEventListener('mouseleave', this.boundCanvasLeave);

    this.resizeObserver = new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      if (this.camera instanceof THREE.PerspectiveCamera) {
        this.camera.aspect = w / h;
      } else {
        // Orthographic 2D view: keep top/bottom (the vertical half-extent already fit
        // to the scene) and rescale left/right by the new aspect, so a resize doesn't
        // visually jump.
        const halfH = (this.camera.top - this.camera.bottom) / 2;
        const halfW = halfH * (w / h);
        this.camera.left = -halfW; this.camera.right = halfW;
      }
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
      this.accumDirty = true;          // resized back-buffer → restart accumulation (renderAccum resizes RTs)
      if (this.bloomBright) {
        const [dw, dh] = this.accumSize();
        const bw = Math.max(1, Math.ceil(dw / 4)), bh = Math.max(1, Math.ceil(dh / 4));
        this.bloomBright.setSize(bw, bh); this.bloomA?.setSize(bw, bh); this.bloomB?.setSize(bw, bh);
      }
      if (this.floorReflector) {
        const [rw, rh] = this.floorReflectionSize();
        this.floorReflector.getRenderTarget().setSize(rw, rh);
        this.floorBlurA?.setSize(rw, rh); this.floorBlurB?.setSize(rw, rh);
      }
      this.ssaoPass?.setSize(...this.accumSize());
    });
    this.resizeObserver.observe(canvas.parentElement!);

    this.initNavCube();
    this.animate();
  }

  private animate() {
    this.animFrameId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.stepNavTween();
    this.updateSnapDotScale();
    if (this.renderMode && this.accumBlendQuad) {
      this.renderAccum();              // progressive AA + soft shadows
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this.renderNavCube();
  }

  // ── Navigation cube (Revit-style view-align gizmo) ───────────────────────────

  /** Small always-on-top gizmo: a labelled cube that mirrors the main camera's
   *  orientation; clicking a face snaps the main view to look straight at it. */
  private initNavCube() {
    const canvas = this.navCubeCanvasRef.nativeElement;
    const size = canvas.clientWidth || 84;

    // Built BEFORE the face materials below — makeNavFaceMaterial reads
    // navRenderer.capabilities for anisotropic filtering, and needs it to already exist
    // even on this very first build (rebuildNavCubeFaces, the OTHER caller, always runs
    // after initNavCube so it never had this ordering problem).
    this.navRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.navRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.navRenderer.setSize(size, size);

    this.navScene = new THREE.Scene();
    this.navCamera = new THREE.OrthographicCamera(-2.2, 2.2, 2.2, -2.2, 0.1, 20);

    const geo = new THREE.BoxGeometry(2, 2, 2);
    const mats = this.NAV_FACE_LABELS.map((label, i) => this.makeNavFaceMaterial(label, i === this.navHoverFace));
    this.navCube = new THREE.Mesh(geo, mats);
    this.navScene.add(this.navCube);
    this.navScene.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35 }),
    ));
    this.navScene.add(new THREE.AmbientLight(0xffffff, 1));

    this.boundNavMove  = (e) => this.onNavCubeMove(e);
    this.boundNavClick = (e) => this.onNavCubeClick(e);
    this.boundNavLeave = () => this.setNavHover(-1);
    canvas.addEventListener('mousemove', this.boundNavMove);
    canvas.addEventListener('click',     this.boundNavClick);
    canvas.addEventListener('mouseleave', this.boundNavLeave);
  }

  /**
   * Builds one face's canvas-texture material; `hover` brightens it. 512px source (was
   * 256) + anisotropic filtering: the cube mirrors the main camera's own orientation, so
   * most faces are seen at a shallow angle most of the time, not face-on — without
   * anisotropy, standard mip-level selection picks a blurrier isotropic level than that
   * view actually needs (it sizes for the worst-case screen-space derivative, which is
   * large at a shallow angle even though the other axis is still sharp), which is what
   * read as "blurred" specifically on the side faces rather than just small.
   */
  private makeNavFaceMaterial(label: string, hover: boolean): THREE.MeshBasicMaterial {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 512;
    const ctx = cv.getContext('2d')!;
    const fill = this.lightTheme ? (hover ? '#dbe4ee' : '#eef1f5') : (hover ? '#3a4048' : '#2b2f36');
    const border = this.lightTheme ? '#aab4c0' : '#4a5058';
    const text = this.lightTheme ? '#2a2f36' : '#e4e7eb';
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 512, 512);
    ctx.strokeStyle = border;
    ctx.lineWidth = 20;
    ctx.strokeRect(10, 10, 492, 492);
    ctx.fillStyle = text;
    ctx.font = 'bold 68px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 256, 256);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.navRenderer?.capabilities.getMaxAnisotropy() ?? 1;
    return new THREE.MeshBasicMaterial({ map: tex });
  }

  /** Re-skins the cube faces after a theme flip so it stays legible in both themes. */
  private rebuildNavCubeFaces() {
    if (!this.navCube) return;
    (this.navCube.material as THREE.MeshBasicMaterial[]).forEach(m => { m.map?.dispose(); m.dispose(); });
    this.navCube.material = this.NAV_FACE_LABELS.map((label, i) => this.makeNavFaceMaterial(label, i === this.navHoverFace));
  }

  private setNavHover(face: number) {
    if (face === this.navHoverFace) return;
    this.navHoverFace = face;
    this.rebuildNavCubeFaces();
  }

  private navNdc(e: MouseEvent, canvas: HTMLCanvasElement): THREE.Vector2 {
    const r = canvas.getBoundingClientRect();
    return new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1,
    );
  }

  private pickNavFace(e: MouseEvent): number {
    const canvas = this.navCubeCanvasRef.nativeElement;
    this.raycaster.setFromCamera(this.navNdc(e, canvas), this.navCamera);
    const hit = this.raycaster.intersectObject(this.navCube, false)[0];
    return hit?.face ? hit.face.materialIndex : -1;
  }

  private onNavCubeMove(e: MouseEvent) { this.setNavHover(this.pickNavFace(e)); }

  private onNavCubeClick(e: MouseEvent) {
    const face = this.pickNavFace(e);
    if (face < 0) return;
    this.orientToNavFace(this.NAV_FACE_DIRS[face]);
  }

  /** Animates the main camera to look straight at `dir` (a unit vector from the
   *  OrbitControls target), keeping the current distance and `camera.up` untouched
   *  so OrbitControls' internal state (captured from `camera.up` at construction)
   *  stays consistent once the tween hands back control. */
  private orientToNavFace(dir: THREE.Vector3) {
    const target = this.controls.target.clone();
    const dist = THREE.MathUtils.clamp(
      this.camera.position.distanceTo(target) || 2000, this.controls.minDistance, this.controls.maxDistance,
    );
    const fromDir = this.camera.position.clone().sub(target).normalize();
    const toDir = dir.clone().normalize();
    const quat = new THREE.Quaternion().setFromUnitVectors(fromDir, toDir);
    this.navTween = { target, fromDir, toDir, quat, dist, start: performance.now(), dur: 400 };
  }

  /** Advances the in-flight nav-cube camera tween (slerp along the great-circle arc). */
  private stepNavTween() {
    if (!this.navTween) return;
    const { target, fromDir, toDir, quat, dist, start, dur } = this.navTween;
    const t = Math.min(1, (performance.now() - start) / dur);
    const k = t * t * (3 - 2 * t);
    const curDir = t >= 1 ? toDir : fromDir.clone().applyQuaternion(new THREE.Quaternion().slerp(quat, k));
    this.camera.position.copy(target).addScaledVector(curDir, dist);
    this.camera.lookAt(target);
    if (t >= 1) this.navTween = null;
  }

  /** Mirrors the nav cube's mini-camera to the main camera's viewing direction each
   *  frame, so the gizmo always shows the world's current orientation, then renders it. */
  private renderNavCube() {
    if (!this.navRenderer) return;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.navCamera.position.copy(dir.multiplyScalar(5));
    this.navCamera.up.copy(this.camera.up);
    this.navCamera.lookAt(0, 0, 0);
    this.navRenderer.render(this.navScene, this.navCamera);
  }

  // ── Render (photoreal preview) mode ──────────────────────────────────────────

  /**
   * Toggle the photoreal Render preview: PBR materials lit by an image-based studio
   * environment (RoomEnvironment → PMREM), ACES filmic tone mapping and a shadow-
   * catching floor; CAD helpers and edge lines are hidden. Pure Three.js core + examples.
   * Toggling rebuilds all objects from data, so the standard viewport is restored on exit.
   */
  toggleRender() {
    if (this.viewPlane !== '3D') this.setViewPlane('3D');   // mutually exclusive — see setViewPlane
    this.renderMode = !this.renderMode;
    setRenderBevel(this.renderMode);   // cosmetic edge chamfer — Render only, rebuilt below
    if (this.renderMode) {
      this.cancelMode();
      this.applySelect([]);                       // clean, unhighlighted view
      this.enterRenderScene();
      this.scene.environment = this.envTexture!;
    } else {
      this.exitRenderScene();
    }
    this.applyLighting();             // mode-dependent base intensities × brightness
    this.applyViewportBackground();   // theme- and mode-dependent 3D background
    this.refreshAllObjects();
  }

  /** Render-look setup (env + tone mapping + shadow floor, CAD helpers hidden). */
  private enterRenderScene() {
    if (!this.envTexture) {                        // build the IBL environment once
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
      pmrem.dispose();
    }
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.viewHelpers.forEach(h => h.visible = false);
    // A real camera/room-interior shot uses a narrower, more "normal lens" field of view
    // than the wide FOV that's convenient for CAD navigation (which needs to see more of
    // the model at once) — the wide FOV is what makes a perspective shot look bulged/
    // fisheye-y near the edges. camera.up is never rotated anywhere in this app (orbit,
    // the custom selection-pivot orbit and the nav-cube tween all preserve it), so
    // verticals already stay vertical on screen regardless of FOV.
    this.perspectiveCamera.fov = 42;   // enterRenderScene only ever runs in 3D — see toggleRender's guard
    this.perspectiveCamera.updateProjectionMatrix();
    if (!this.renderFloor) {
      const geo = new THREE.PlaneGeometry(200000, 200000);
      geo.rotateX(-Math.PI / 2);
      this.renderFloor = new THREE.Mesh(
        geo, new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.95, metalness: 0 }),
      );
      this.renderFloor.position.y = -0.2;          // just under y=0 so slabs/walls aren't z-fought
      this.renderFloor.receiveShadow = true;
    }
    this.updateFloorVisibility();   // plain floor until/unless the reflective one finishes building
    this.ensureFloorReflection();   // lazy-build the reflective floor (async; falls back silently on failure)
    // Env intensity depends on the lighting mode (see applyRenderEnv): low in direct-light mode
    // (the shadowed samples carry the diffuse + AO), high in diffuse-only mode (env lights all).
    this.applyRenderEnv();
    this.keyLightBase.copy(this.keyLight.position);   // remember the un-jittered key-light pose
    // Sun direction + a tangent basis for the soft-sun cone (direct-light mode).
    this.sunDir.copy(this.keyLightBase).normalize();
    this.sunPerpA.crossVectors(this.sunDir, Math.abs(this.sunDir.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)).normalize();
    this.sunPerpB.crossVectors(this.sunDir, this.sunPerpA).normalize();
    // Small, not the old flat 3mm — that was enough to "peter-pan" contact shadows away
    // from the base of an object (exactly the tight AO crease that reads as a grounded,
    // real edge); fitShadowFrustum() below shrinks the shadow camera to the scene's own
    // size, so the per-texel world size drops enough that a small bias still hides acne.
    this.keyLight.shadow.normalBias = 0.5;
    // fitShadowFrustum() runs from refreshAllObjects() instead (below, same toggleRender()
    // call) — objectMap here still holds the pre-rebuild CAD objects.
    this.accumDirty = true;
    this.ensureAccum();     // lazy-build the progressive-accumulation targets (async, safe if it fails)
    this.loadHdri();        // upgrade RoomEnvironment → studio HDRI once it loads (async)
    this.ensureSSAO();      // lazy-build the SSAO pass (async, gated by its own runtime smoke test)
  }

  /**
   * Shrink the key light's orthographic shadow frustum to fit the current scene's own
   * bounding sphere (instead of a fixed ±8000mm box sized for a worst-case large scene).
   * The light swings to a different hemisphere/sun direction every accumulated sample, so
   * a *sphere* (not just the camera-facing extent) is what has to stay covered. A tighter
   * frustum raises the shadow map's effective resolution per mm, which is what actually
   * resolves tight contact shadows at panel/door seams — at the old ±8000mm box and 2048
   * texels, each texel was ~7.8mm, coarser than most of the gaps/reveals it needed to
   * shadow, which is why contact shadows (and the edges they sit at) read as flat.
   */
  private fitShadowFrustum() {
    const half = this.sceneBoundingSphere().radius;
    const cam = this.keyLight.shadow.camera;
    cam.left = cam.bottom = -half;
    cam.right = cam.top = half;
    cam.updateProjectionMatrix();
  }

  /** World-space bounding sphere over every currently spawned object (padded, with a
   *  sane floor for a tiny/empty scene) — sizes both the Render-mode shadow frustum
   *  (fitShadowFrustum) and the 2D plan/elevation view's ortho frustum (setViewPlane)
   *  to whatever's actually in the scene. */
  private sceneBoundingSphere(): THREE.Sphere {
    const box = new THREE.Box3();
    this.objectMap.forEach(o => { o.updateMatrixWorld(true); box.union(new THREE.Box3().setFromObject(o)); });
    if (box.isEmpty()) return new THREE.Sphere(new THREE.Vector3(0, 0, 0), 4000);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    sphere.radius = Math.max(1500, sphere.radius * 1.15);
    return sphere;
  }

  /**
   * Switch between the normal 3D CAD view and a true flattened 2D line drawing in a
   * given plane: an orthographic camera locked to look straight along that plane's
   * normal (an orthographic projection IS, mathematically, "drop everything onto the
   * view plane"), with every mesh's shaded faces hidden and only its existing isEdge
   * wireframe shown (applyViewPlaneVisuals) — no new projection/geometry math, this is
   * a camera + visibility switch. Mutually exclusive with Render mode (toggleRender
   * forces back to 3D first if needed; this forces Render off first, symmetrically).
   */
  setViewPlane(mode: MovePlane | '3D' | 'current') {
    if (this.renderMode) this.toggleRender();
    this.viewPlane = mode;
    if (mode === '3D') {
      this.camera = this.perspectiveCamera;
      this.controls.object = this.camera;
      this.controls.enableRotate = true;
      this.controls.update();
      this.applyViewPlaneVisuals();
      return;
    }

    // Centred on the scene's own bounding sphere — NOT controls.target, which is
    // wherever the 3D orbit happened to leave off (often still the world origin) and
    // can easily sit far from the actual content, taking it clean out of frame (this
    // is why 2D views first came up empty). camDir is the unit vector from that centre
    // TO the camera (so `position = origin + camDir*dist`), not the viewing direction.
    const sphere = this.sceneBoundingSphere();
    const origin = sphere.center.clone();
    const camDir = new THREE.Vector3();
    const up = new THREE.Vector3();
    if (mode === 'XZ') { camDir.set(0, 1, 0); up.set(0, 0, -1); }           // plan/top: camera above, looking down
    else if (mode === 'YZ') { camDir.set(1, 0, 0); up.set(0, 1, 0); }       // side: camera on +X, looking toward -X
    else if (mode === 'XY') { camDir.set(0, 0, 1); up.set(0, 1, 0); }       // front: camera on +Z, looking toward -Z
    else {
      const plane = this.currentPlane ?? this.selectedInstance?.plane;
      if (!plane) return;   // the dropdown's own option is disabled when inapplicable
      camDir.set(plane.normal.x, plane.normal.y, plane.normal.z).normalize();
      const u = new THREE.Vector3(plane.uAxis.x, plane.uAxis.y, plane.uAxis.z);
      // Looking from the +normal side (camDir = normal) with a camera's standard
      // right/up/backward basis (right × up = backward), screen-right works out to
      // normal × uAxis — NOT uAxis × normal (that gives -uAxis, i.e. a mirrored view:
      // confirmed both algebraically — right = cross(up, camDir), and up = uAxis×normal
      // reduces that to -uAxis via the vector triple product — and against a concrete
      // case: a door face normal pointing outward (+Z) with uAxis pointing toward
      // ДЯСНА (+X) must put ДЯСНА on-screen-right, which only this order does).
      up.crossVectors(camDir, u).normalize();
    }

    const canvas = this.canvasRef.nativeElement;
    const aspect = (canvas.clientWidth || 800) / (canvas.clientHeight || 600);
    if (!this.orthoCamera) this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 100000);
    const cam = this.orthoCamera;
    cam.top = sphere.radius; cam.bottom = -sphere.radius;
    cam.left = -sphere.radius * aspect; cam.right = sphere.radius * aspect;
    cam.near = 1; cam.far = sphere.radius * 10;
    cam.position.copy(origin).addScaledVector(camDir, sphere.radius * 3);
    cam.up.copy(up);
    cam.lookAt(origin);
    cam.updateProjectionMatrix();

    this.camera = cam;
    this.controls.object = cam;
    this.controls.target.copy(origin);
    this.controls.enableRotate = false;
    this.controls.update();
    this.applyViewPlaneVisuals();
  }

  /** Hide every mesh's shaded faces and show only its isEdge wireframe while a 2D plan/
   *  elevation view is active — restores normal face visibility back in 3D. Skips the
   *  Line family's own invisible pick-target tube (isLinePickTarget, webcad-geometry.ts)
   *  which must never become visible. A known, accepted limitation: an FBX import has
   *  no isEdge wireframe at all (excluded from addEdges elsewhere), so it simply has
   *  nothing to show in 2D. */
  private applyViewPlaneVisuals() {
    this.objectMap.forEach(obj => this.setMeshFacesVisible(obj, this.viewPlane === '3D'));
  }

  /**
   * Hide/show every mesh's shaded FACES under `root`, toggling each `.material.visible`
   * rather than the mesh's own `Object3D.visible` — critical, since every mesh's isEdge
   * wireframe is added as its CHILD (`addEdges`, webcad-object3d.ts): a child's render
   * visibility is gated by its *ancestors'* `Object3D.visible` too, so setting the mesh
   * itself invisible would have also hidden its wireframe, leaving nothing to see at all
   * (exactly what happened before this fix — a 2D view showed a genuinely empty
   * viewport, not just "faces missing"). `Material.visible` only gates that mesh's own
   * draw call, never cascading to children. Skips the Line family's own invisible
   * pick-target tube (isLinePickTarget), whose material must stay permanently
   * invisible regardless of 2D/3D.
   */
  private setMeshFacesVisible(root: THREE.Object3D, visible: boolean) {
    root.traverse(child => {
      if (!(child instanceof THREE.Mesh) || child.userData['isEdge'] || child.userData['isLinePickTarget']) return;
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(m => { m.visible = visible; });
    });
  }

  private exitRenderScene() {
    this.scene.environment = null;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.perspectiveCamera.fov = 55;   // exitRenderScene only ever runs in 3D — see toggleRender's guard
    this.perspectiveCamera.updateProjectionMatrix();
    this.viewHelpers.forEach(h => h.visible = true);
    if (this.renderFloor) this.scene.remove(this.renderFloor);
    if (this.floorReflector) this.scene.remove(this.floorReflector);
    if (this.floorShadowCatcher) this.scene.remove(this.floorShadowCatcher);
    // Restore the key light to its plain CAD state (renderAccum leaves it coloured/rotated).
    this.keyLight.position.copy(this.keyLightBase);
    this.keyLight.color.setRGB(1, 1, 1);
    this.keyLight.target.position.set(0, 0, 0);
    this.keyLight.target.updateMatrixWorld();
    this.renderer.setRenderTarget(null);
  }

  /** Shows exactly one floor look: the reflective one (once built) when `floorReflections`
   *  is on, otherwise the plain matte fallback — a free, no-rebuild toggle either way. */
  private updateFloorVisibility() {
    if (!this.renderMode) return;
    if (this.floorReflections && this.floorReflector) {
      this.scene.add(this.floorReflector);
      this.scene.add(this.floorShadowCatcher!);
      this.scene.remove(this.renderFloor!);
    } else {
      this.scene.add(this.renderFloor!);
      if (this.floorReflector) this.scene.remove(this.floorReflector);
      if (this.floorShadowCatcher) this.scene.remove(this.floorShadowCatcher);
    }
  }

  /** The floor-reflections escape-hatch checkbox. */
  setFloorReflections(on: boolean) {
    this.floorReflections = on;
    this.updateFloorVisibility();
    this.accumDirty = true;
  }

  /**
   * Lazy-build the reflective floor once: a `THREE.Reflector` (mirrored-camera render-to-
   * texture, self-visibility hiding and the oblique clip plane are all its proven logic,
   * untouched) with a custom shader that samples a pre-blurred copy of its reflection
   * (softer, satin look) blended with a dark base tint via a view-angle Fresnel term. The
   * blur reuses `bloomBlurQuad` (built in `ensureAccum`) — it's just a full-screen quad;
   * only its uniforms/target change between the two uses, both within the same frame.
   */
  private async ensureFloorReflection() {
    if (this.floorReflector || this.floorLoading) return;
    this.floorLoading = true;
    try {
      await this.ensureAccum();
      if (!this.bloomBlurQuad) return;   // accumulation pipeline unavailable — keep the plain floor
      const { Reflector } = await import('three/examples/jsm/objects/Reflector.js');
      const [rw, rh] = this.floorReflectionSize();

      const geo = new THREE.PlaneGeometry(200000, 200000);
      geo.rotateX(-Math.PI / 2);
      const vert = `
        uniform mat4 textureMatrix;
        varying vec4 vUv;
        varying vec3 vWorldPosition;
        #include <common>
        #include <logdepthbuf_pars_vertex>
        void main() {
          vUv = textureMatrix * vec4( position, 1.0 );
          vWorldPosition = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
          gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
          #include <logdepthbuf_vertex>
        }`;
      const frag = `
        uniform vec3 color;
        uniform sampler2D tDiffuse;
        uniform sampler2D tBlurred;
        varying vec4 vUv;
        varying vec3 vWorldPosition;
        #include <logdepthbuf_pars_fragment>
        void main() {
          #include <logdepthbuf_fragment>
          vec3 refl = texture2DProj( tBlurred, vUv ).rgb;
          float fresnel = pow( 1.0 - max( dot( normalize( cameraPosition - vWorldPosition ), vec3( 0.0, 1.0, 0.0 ) ), 0.0 ), 4.0 );
          float mixAmt = mix( 0.35, 0.95, fresnel );
          gl_FragColor = vec4( mix( color, refl, mixAmt ), 1.0 );
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`;

      this.floorBlurA = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.HalfFloatType, depthBuffer: false });
      this.floorBlurB = new THREE.WebGLRenderTarget(rw, rh, { type: THREE.HalfFloatType, depthBuffer: false });

      const reflector = new Reflector(geo, {
        textureWidth: rw, textureHeight: rh, clipBias: 0.003, color: 0x3a3d42,
        shader: {
          name: 'KitchenFloorReflector',
          uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null }, tBlurred: { value: null } },
          vertexShader: vert, fragmentShader: frag,
        },
      });
      reflector.position.y = -0.2;
      (reflector.material as THREE.ShaderMaterial).uniforms['tBlurred'].value = this.floorBlurB.texture;

      // Chain our own 2-pass blur onto the reflector's own per-frame render — it fires
      // automatically as part of the main scene's r.render(scene, cam) call already in
      // renderAccum (once per shown frame, same as everything else there), so this needs
      // no extra render-loop wiring. Must restore whatever render target was bound before
      // (renderAccum's frameRT) — the outer render call still has more objects to draw.
      const origOBR = (reflector.onBeforeRender as unknown as (...a: any[]) => void).bind(reflector);
      reflector.onBeforeRender = ((renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, ...rest: any[]) => {
        origOBR(renderer, scene, camera, ...rest);
        const prevTarget = renderer.getRenderTarget();
        const bm = this.bloomBlurQuad!.material as THREE.ShaderMaterial;
        bm.uniforms['uRadius'].value = 2.5;   // softer than bloom's — a satin reflection, not a mirror
        bm.uniforms['tInput'].value = reflector.getRenderTarget().texture;
        bm.uniforms['uDir'].value.set(1 / rw, 0);
        renderer.setRenderTarget(this.floorBlurA!);
        this.bloomBlurQuad!.render(renderer);
        bm.uniforms['tInput'].value = this.floorBlurA!.texture;
        bm.uniforms['uDir'].value.set(0, 1 / rh);
        renderer.setRenderTarget(this.floorBlurB!);
        this.bloomBlurQuad!.render(renderer);
        renderer.setRenderTarget(prevTarget);
      }) as any;
      this.floorReflector = reflector;

      this.floorShadowCatcher = new THREE.Mesh(geo.clone(), new THREE.ShadowMaterial({ opacity: 0.35 }));
      this.floorShadowCatcher.position.y = -0.15;   // just above the reflector, just below real geometry
      this.floorShadowCatcher.receiveShadow = true;

      this.updateFloorVisibility();
      this.accumDirty = true;
    } catch (e) {
      console.error('[render] floor reflection unavailable — keeping the plain floor', e);
    } finally {
      this.floorLoading = false;
    }
  }

  /**
   * Build the progressive-accumulation targets and full-screen quads once, lazy-importing
   * `FullScreenQuad` so it stays out of the initial bundle. Three HalfFloat targets: one
   * MSAA sample buffer and a ping/pong pair holding the running average. A blend quad folds
   * each new sample in (`mix(avg, sample, 1/(n+1))`), a show quad tone-maps (ACES) the
   * average to screen. HalfFloat + plain scene renders are well supported on integrated GPUs.
   */
  private async ensureAccum() {
    if (this.accumBlendQuad || this.ppLoading) return;
    this.ppLoading = true;
    try {
      const { FullScreenQuad } = await import('three/examples/jsm/postprocessing/Pass.js');
      const [w, h] = this.accumSize();
      this.frameRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4 });
      this.accumA = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });
      this.accumB = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false });

      const vert = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
      this.accumBlendQuad = new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: { tAccum: { value: null }, tFrame: { value: null }, uWeight: { value: 1 } },
        vertexShader: vert,
        fragmentShader: `
          varying vec2 vUv; uniform sampler2D tAccum; uniform sampler2D tFrame; uniform float uWeight;
          void main(){ gl_FragColor = mix(texture2D(tAccum, vUv), texture2D(tFrame, vUv), uWeight); }`,
      }));
      this.accumShowQuad = new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: { tDiffuse: { value: null }, tBloom: { value: null }, tAO: { value: null }, uExposure: { value: 1 }, uBloomStrength: { value: 0 } },
        vertexShader: vert,
        fragmentShader: `
          varying vec2 vUv; uniform sampler2D tDiffuse; uniform sampler2D tBloom; uniform sampler2D tAO;
          uniform float uExposure; uniform float uBloomStrength;
          void main(){
            // tAO (screen-space ambient occlusion, see computeSSAO) multiplies ONLY the diffuse
            // term — bloom represents already-emitted/bright light, which real contact occlusion
            // doesn't dim. Defaults to a plain white 1×1 texture (whiteTex) when SSAO is off/
            // unsupported/not yet loaded, making this line a no-op and the look identical to
            // before SSAO existed. The pow() steepens the raw occlusion ratio: SSAOShader's own
            // output is a fairly gentle 0..1 fraction (fraction of kernel samples that found an
            // occluder), which on its own still reads close to flat white outside the tightest
            // creases — raising it to a power >1 pulls every partially-occluded pixel darker
            // (1.0 stays 1.0; 0.6 drops to ~0.26), so the broad, gradual falloff across a whole
            // panel (kernelRadius, see ensureSSAO) actually shows up as visible tonal variation
            // instead of washing back out to uniform white once lit.
            vec3 ao = pow(texture2D(tAO, vUv).rgb, vec3(1.8));
            vec3 c = (texture2D(tDiffuse, vUv).rgb * ao + texture2D(tBloom, vUv).rgb * uBloomStrength) * uExposure;
            c = (c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14);  // ACES filmic (Narkowicz)
            c = clamp(c, 0.0, 1.0);
            c = pow(c, vec3(1.0 / 2.2));                                    // linear → sRGB
            float vig = smoothstep(0.95, 0.35, length(vUv - 0.5));        // subtle camera-lens vignette
            c *= mix(0.78, 1.0, vig);
            gl_FragColor = vec4(c, 1.0);
          }`,
      }));
      this.whiteTex = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
      this.whiteTex.needsUpdate = true;
      (this.accumShowQuad.material as THREE.ShaderMaterial).uniforms['tAO'].value = this.whiteTex;

      // Bloom: quarter-res bright-pass + a reusable separable-Gaussian blur quad (also used,
      // unmodified, by the floor reflection's blur — see ensureFloorReflection).
      const [bw, bh] = [Math.max(1, Math.ceil(w / 4)), Math.max(1, Math.ceil(h / 4))];
      this.bloomBright = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false });
      this.bloomA = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false });
      this.bloomB = new THREE.WebGLRenderTarget(bw, bh, { type: THREE.HalfFloatType, depthBuffer: false });
      this.bloomExtractQuad = new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: { tInput: { value: null }, uThreshold: { value: 1 } },
        vertexShader: vert,
        fragmentShader: `
          varying vec2 vUv; uniform sampler2D tInput; uniform float uThreshold;
          void main(){ gl_FragColor = vec4(max(texture2D(tInput, vUv).rgb - uThreshold, 0.0), 1.0); }`,
      }));
      this.bloomBlurQuad = new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: { tInput: { value: null }, uDir: { value: new THREE.Vector2() }, uRadius: { value: 1 } },
        vertexShader: vert,
        fragmentShader: `
          varying vec2 vUv; uniform sampler2D tInput; uniform vec2 uDir; uniform float uRadius;
          void main(){
            float w0 = 0.227027, w1 = 0.1945946, w2 = 0.1216216, w3 = 0.054054, w4 = 0.016216;
            vec3 sum = texture2D(tInput, vUv).rgb * w0;
            vec2 o1 = uDir * uRadius, o2 = uDir * uRadius * 2.0, o3 = uDir * uRadius * 3.0, o4 = uDir * uRadius * 4.0;
            sum += (texture2D(tInput, vUv + o1).rgb + texture2D(tInput, vUv - o1).rgb) * w1;
            sum += (texture2D(tInput, vUv + o2).rgb + texture2D(tInput, vUv - o2).rgb) * w2;
            sum += (texture2D(tInput, vUv + o3).rgb + texture2D(tInput, vUv - o3).rgb) * w3;
            sum += (texture2D(tInput, vUv + o4).rgb + texture2D(tInput, vUv - o4).rgb) * w4;
            gl_FragColor = vec4(sum, 1.0);
          }`,
      }));

      this.accumDirty = true;
    } catch (e) {
      console.error('[render] accumulation unavailable — using basic render', e);
    } finally {
      this.ppLoading = false;
    }
  }

  /**
   * Lazy-build the SSAO pass once (see the field-level doc comment above for why this is
   * gated the way it is). WebGL2 is checked up front — depth textures are core spec there,
   * not the flakier optional WebGL1 extension — before even attempting to build anything;
   * on WebGL1 this commits straight to `ssaoSupported = false` with no further cost.
   * `kernelRadius`/`minDistance`/`maxDistance` are retuned from Three's own defaults
   * (written for a roughly 1-unit-per-metre scene with near/far ~0.1/1000): this app's
   * world units are millimetres with a camera near/far of 1/100000, and SSAOShader's
   * min/maxDistance are normalised-depth thresholds (fractions of the near→far range, NOT
   * literal view-space mm — confirmed by reading SSAOShader's own `viewZToOrthographicDepth`
   * delta test) — at this near/far ratio the stock 0.005/0.1 defaults correspond to
   * roughly 500mm/10000mm, which is in the right ballpark but was picked blind; deriving
   * them explicitly from the camera's own near/far makes the real-mm intent legible
   * instead of two magic fractions. `kernelRadius` itself IS literal view-space mm (used
   * directly, not through the normalised-depth path), so 60 is just "a furniture-edge-scale
   * contact radius", picked directly.
   */
  private async ensureSSAO() {
    if (this.ssaoPass || this.ssaoLoading || this.ssaoSupported === false) return;
    if (!this.renderer.capabilities.isWebGL2) { this.ssaoSupported = false; return; }
    this.ssaoLoading = true;
    try {
      const { SSAOPass } = await import('three/examples/jsm/postprocessing/SSAOPass.js');
      const { FullScreenQuad } = await import('three/examples/jsm/postprocessing/Pass.js');
      const [w, h] = this.accumSize();
      const pass = new SSAOPass(this.scene, this.perspectiveCamera, w, h, 32);
      const cam = this.perspectiveCamera;
      const range = cam.far - cam.near;
      // kernelRadius is intentionally broad (not just a hairline at seams): a large hemisphere
      // samples a wide swath of neighbouring geometry per pixel, so a whole panel reads a soft
      // gradient toward every nearby wall/corner/neighbour — not only a thin dark line exactly
      // at the touching edge. Pushed up from an initial 60mm (which only ever caught the tight
      // seam itself, leaving the rest of every surface perfectly flat) after exactly that
      // flatness was reported as still looking wrong. maxDistance is raised to match — it has
      // to stay comfortably larger than kernelRadius or a 200mm-reach sample's occlusion test
      // gets clipped away before it can register. kernelSize (32, up from 16) keeps the now-
      // much-wider hemisphere from reading noisy at this radius (the blur pass only removes
      // high-frequency speckle, it doesn't compensate for too few samples over a bigger area).
      pass.kernelRadius = 200;            // literal view-space mm — spans most of a cabinet panel
      pass.minDistance = 2 / range;       // ≈2mm real occlusion floor, in SSAOShader's normalised-depth units
      pass.maxDistance = 900 / range;     // ≈900mm real occlusion ceiling, same units
      this.ssaoPass = pass;

      // Tiny readable copy target: doubles as (a) the dummy write/read target for the
      // pass's own public render() API (its final "output visualisation" copy step is
      // unused here — we read blurRenderTarget.texture directly below — so it's given
      // the cheapest possible destination) and (b) the smoke-test readback in verifySSAO.
      this.ssaoReadbackRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType });
      this.ssaoCopyQuad = new FullScreenQuad(new THREE.ShaderMaterial({
        uniforms: { tInput: { value: null } },
        vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
        fragmentShader: `varying vec2 vUv; uniform sampler2D tInput; void main(){ gl_FragColor = vec4(texture2D(tInput, vUv).rgb, 1.0); }`,
      }));
    } catch (e) {
      console.error('[render] SSAO unavailable — falling back to no-AO Render look', e);
      this.ssaoSupported = false;
    } finally {
      this.ssaoLoading = false;
    }
  }

  /**
   * Compute SSAO for the current camera/scene — once per SHOWN frame (unlike the per-
   * sample hemisphere lights in renderAccum, AO only depends on camera + geometry, not on
   * which light direction is being sampled). No-ops (leaving accumShowQuad's tAO at its
   * white default) while disabled, on an empty scene (nothing to meaningfully test), or
   * once the runtime smoke test below has found it unreliable.
   */
  private computeSSAO() {
    if (!this.ssaoEnabled || this.ssaoSupported === false || this.instances.length === 0) return;
    if (!this.ssaoPass) { this.ensureSSAO(); return; }   // still loading — no AO this frame
    const cam = this.perspectiveCamera;   // Render mode is always the 3D perspective camera (see setViewPlane)
    const u = this.ssaoPass.ssaoMaterial.uniforms;
    u['cameraProjectionMatrix'].value.copy(cam.projectionMatrix);
    u['cameraInverseProjectionMatrix'].value.copy(cam.projectionMatrixInverse);
    this.ssaoPass.render(this.renderer, this.ssaoReadbackRT!, this.ssaoReadbackRT!, 0, false);
    if (this.ssaoSupported === null && this.accumN <= 1 && this.ssaoFailCount < 5) this.verifySSAO();
  }

  /**
   * Runtime smoke test (see the field-level doc comment for the rationale): copies the
   * just-computed blurred AO map down to a 4×4 readable target and reads it back. A real
   * pass against real geometry virtually always varies pixel-to-pixel across that spread
   * of sample points; a uniformly flat readback — every sampled texel bit-identical — is
   * what a broken depth-texture pipeline tends to produce instead (SSAOShader's per-sample
   * "is this point occluded" test then fails the same way everywhere). One real success
   * locks SSAO on permanently (hardware capability doesn't fluctuate frame to frame);
   * repeated flat results (5, across different camera framings as the user orbits/idles —
   * guards against one unlucky all-flat framing, e.g. a single panel filling the screen)
   * turn it off for the rest of the session.
   */
  private verifySSAO() {
    const r = this.renderer;
    try {
      const cm = this.ssaoCopyQuad!.material as THREE.ShaderMaterial;
      cm.uniforms['tInput'].value = this.ssaoPass!.blurRenderTarget.texture;
      r.setRenderTarget(this.ssaoReadbackRT!);
      this.ssaoCopyQuad!.render(r);
      const buf = new Uint8Array(4 * 4 * 4);
      r.readRenderTargetPixels(this.ssaoReadbackRT!, 0, 0, 4, 4, buf);
      r.setRenderTarget(null);
      let min = 255, max = 0;
      for (let i = 0; i < buf.length; i += 4) { min = Math.min(min, buf[i]); max = Math.max(max, buf[i]); }
      if (max - min > 2) {
        this.ssaoSupported = true;
      } else {
        this.ssaoFailCount++;
        if (this.ssaoFailCount >= 5) {
          console.warn('[render] SSAO looked flat on every attempt — disabling for this session');
          this.ssaoSupported = false;
        }
      }
    } catch (e) {
      console.error('[render] SSAO smoke test failed — disabling', e);
      this.ssaoSupported = false;
    }
  }

  /** The SSAO escape-hatch checkbox (Settings dialog). */
  setSsao(on: boolean) {
    this.ssaoEnabled = on;
    this.accumDirty = true;
  }

  /** Back-buffer size in device pixels (matches the renderer's drawing buffer). */
  private accumSize(): [number, number] {
    const v = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    return [Math.max(1, v.x), Math.max(1, v.y)];
  }

  /** Reflection render-target size: half the back buffer (plenty for a blurred, non-mirror
   *  reflection), capped so it stays cheap at very large/high-DPI canvas sizes. */
  private floorReflectionSize(): [number, number] {
    const [w, h] = this.accumSize();
    return [Math.min(1536, Math.max(256, Math.round(w / 2))), Math.min(1536, Math.max(256, Math.round(h / 2)))];
  }

  /** Van der Corput / Halton low-discrepancy sample in a given base. */
  private halton(index: number, base: number): number {
    let f = 1, r = 0, i = index + 1;
    while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
    return r;
  }

  /**
   * Load the studio HDRI once and upgrade the environment from the synthetic RoomEnvironment
   * to it: a PMREM env map drives reflections, and the raw float equirect is kept for CPU
   * direction sampling in renderAccum. Async; on failure we simply keep RoomEnvironment.
   */
  private async loadHdri() {
    if (this.hdriData || this.hdriLoading) return;
    this.hdriLoading = true;
    try {
      const { HDRLoader } = await import('three/examples/jsm/loaders/HDRLoader.js');
      const loader = new HDRLoader();
      loader.setDataType(THREE.FloatType);      // Float32 pixels so we can sample directions on the CPU
      const tex = await loader.loadAsync('assets/images/3D/studio.hdr') as THREE.DataTexture;
      const img = tex.image as { data: Float32Array; width: number; height: number };
      this.hdriData = { data: img.data, w: img.width, h: img.height };

      tex.mapping = THREE.EquirectangularReflectionMapping;
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      pmrem.compileEquirectangularShader();
      this.envTexture = pmrem.fromEquirectangular(tex).texture;   // reflections
      pmrem.dispose();
      tex.dispose();                             // GPU copy no longer needed (data + PMREM kept)
      if (this.renderMode) this.scene.environment = this.envTexture;
      this.accumDirty = true;                    // re-accumulate with the real HDRI
    } catch (e) {
      console.error('[render] HDRI load failed — keeping RoomEnvironment', e);
    } finally {
      this.hdriLoading = false;
    }
  }

  /** Radiance of the HDRI in a world direction (equirect lookup on the kept float data). */
  private sampleHdri(dx: number, dy: number, dz: number): [number, number, number] {
    const d = this.hdriData;
    if (!d) return [1, 1, 1];
    const len = Math.hypot(dx, dy, dz) || 1; dx /= len; dy /= len; dz /= len;
    const u = Math.atan2(dz, dx) / (2 * Math.PI) + 0.5;
    const v = 1 - (Math.asin(Math.max(-1, Math.min(1, dy))) / Math.PI + 0.5);  // row 0 = top of image
    let px = Math.floor(u * d.w) % d.w; if (px < 0) px += d.w;
    const py = Math.max(0, Math.min(d.h - 1, Math.floor(v * d.h)));
    const i = (py * d.w + px) * 4;
    // clamp to tame the odd very-bright texel (firefly) into the average
    return [Math.min(8, d.data[i]), Math.min(8, d.data[i + 1]), Math.min(8, d.data[i + 2])];
  }

  /**
   * One frame of Render mode. While the view keeps changing we show a single fresh sample
   * (responsive) lit by a neutral key; once it settles we fold in up to `accumMax` samples,
   * each lighting the scene from one hemisphere direction coloured by the HDRI and
   * shadow-mapped (so occluded points miss those directions → ray-cast ambient occlusion),
   * plus sub-pixel camera jitter for anti-aliasing. Then we just keep displaying the converged
   * average. Exposure is applied at display time, so the brightness slider never forces a restart.
   */
  private renderAccum() {
    const r = this.renderer;
    if (this.navTween) this.accumDirty = true;          // nav-cube fly-to moves the camera directly
    if (this.accumDirty) { this.accumN = 0; this.accumDirty = false; }

    if (this.accumN < this.accumMax) {
      const [w, h] = this.accumSize();
      if (w !== this.frameRT!.width || h !== this.frameRT!.height) {
        this.frameRT!.setSize(w, h); this.accumA!.setSize(w, h); this.accumB!.setSize(w, h);
        this.ssaoPass?.setSize(w, h);
        this.accumN = 0;
      }
      const n = this.accumN, cam = this.camera;

      // Sub-pixel camera jitter (skip on the very first sample so a still frame is centred).
      cam.updateProjectionMatrix();
      if (n > 0) {
        cam.projectionMatrix.elements[8] += ((this.halton(n, 2) - 0.5) * 2) / w;
        cam.projectionMatrix.elements[9] += ((this.halton(n, 3) - 0.5) * 2) / h;
      }

      // Light the sample. n === 0 (the frame shown while orbiting) uses a neutral key from
      // the base pose for a responsive, evenly-lit preview. n > 0 draws one shadow-mapped
      // directional light from a uniform hemisphere direction, coloured by the HDRI radiance
      // there; averaging these is image-based lighting whose per-direction visibility (the
      // shadow map) yields ray-cast ambient occlusion in the crevices.
      const b = this.cameraBrightness;
      const tgt = this.controls.target;
      // Every sample is ONE shadow-mapped directional light; averaging their per-direction
      // visibility gives soft, realistic shadows + ray-cast AO in BOTH modes. n === 0 (the
      // frame shown while orbiting) is a stable neutral key for a responsive preview.
      // - "sky" samples: uniform upper hemisphere, coloured by the HDRI → soft overcast shadows.
      // - "sun" samples (direct-light mode only, ~45% of samples): a tight cone around the sun
      //   direction → a defined, only-slightly-soft primary shadow on top of the soft fill.
      let dx: number, dy: number, dz: number, cr = 1, cg = 1, cb = 1, inten: number;
      if (n === 0) {
        dx = this.sunDir.x; dy = this.sunDir.y; dz = this.sunDir.z; inten = 2.6 * b;
      } else if (this.directLight && this.halton(n, 7) < 0.45) {
        const rr = 0.12 * Math.sqrt(this.halton(n, 5)), a = 2 * Math.PI * this.halton(n, 2);
        this._sampleDir.copy(this.sunDir)
          .addScaledVector(this.sunPerpA, Math.cos(a) * rr)
          .addScaledVector(this.sunPerpB, Math.sin(a) * rr).normalize();
        dx = this._sampleDir.x; dy = this._sampleDir.y; dz = this._sampleDir.z;
        inten = 4.6 * b;                                      // neutral-bright sun
      } else {
        const cosT = this.halton(n, 2);                       // uniform over the upper hemisphere
        const sinT = Math.sqrt(Math.max(0, 1 - cosT * cosT));
        const phi = 2 * Math.PI * this.halton(n, 3);
        dx = sinT * Math.cos(phi); dy = cosT; dz = sinT * Math.sin(phi);
        [cr, cg, cb] = this.sampleHdri(dx, dy, dz);
        inten = (this.directLight ? 3.6 : 4.8) * b;           // brighter sky when there's no sun
      }
      this.keyLight.color.setRGB(cr, cg, cb);
      this.keyLight.intensity = inten;
      this.keyLight.position.set(tgt.x + dx * 9000, tgt.y + dy * 9000, tgt.z + dz * 9000);
      this.keyLight.target.position.copy(tgt);
      this.keyLight.target.updateMatrixWorld();

      // Render one linear sample (tone mapping is applied later, at display).
      const prevTone = r.toneMapping;
      r.toneMapping = THREE.NoToneMapping;
      r.setRenderTarget(this.frameRT!);
      r.clear();
      r.render(this.scene, cam);
      r.toneMapping = prevTone;

      cam.updateProjectionMatrix();                      // undo jitter
      this.keyLight.color.setRGB(1, 1, 1);
      this.keyLight.position.copy(this.keyLightBase);

      // avg' = mix(avg, sample, 1/(n+1)) → accumB, then swap.
      const bm = this.accumBlendQuad!.material as THREE.ShaderMaterial;
      bm.uniforms['tAccum'].value = this.accumA!.texture;
      bm.uniforms['tFrame'].value = this.frameRT!.texture;
      bm.uniforms['uWeight'].value = 1 / (n + 1);
      r.setRenderTarget(this.accumB!);
      this.accumBlendQuad!.render(r);
      const tmp = this.accumA; this.accumA = this.accumB; this.accumB = tmp;
      this.accumN++;
    }

    // Bloom: bright-pass + 2-pass (H, V) blur of the current average, run once per shown
    // frame (not once per sample — it reads the already-averaged accumA).
    const ebm = this.bloomExtractQuad!.material as THREE.ShaderMaterial;
    ebm.uniforms['tInput'].value = this.accumA!.texture;
    ebm.uniforms['uThreshold'].value = 1;
    r.setRenderTarget(this.bloomBright!);
    this.bloomExtractQuad!.render(r);
    const gbm = this.bloomBlurQuad!.material as THREE.ShaderMaterial;
    gbm.uniforms['uRadius'].value = 1;
    gbm.uniforms['tInput'].value = this.bloomBright!.texture;
    gbm.uniforms['uDir'].value.set(1 / this.bloomBright!.width, 0);
    r.setRenderTarget(this.bloomA!);
    this.bloomBlurQuad!.render(r);
    gbm.uniforms['tInput'].value = this.bloomA!.texture;
    gbm.uniforms['uDir'].value.set(0, 1 / this.bloomA!.height);
    r.setRenderTarget(this.bloomB!);
    this.bloomBlurQuad!.render(r);

    // SSAO: computed once per shown frame, not once per accumulated light sample (see
    // computeSSAO's own doc comment). Leaves tAO at its white default when off/
    // unsupported/still loading, so nothing below needs its own conditional.
    this.computeSSAO();

    // Tone-map the current average (+ bloom + AO) to screen.
    const sm = this.accumShowQuad!.material as THREE.ShaderMaterial;
    sm.uniforms['tDiffuse'].value = this.accumA!.texture;
    sm.uniforms['tBloom'].value = this.bloomB!.texture;
    sm.uniforms['tAO'].value = (this.ssaoEnabled && this.ssaoSupported !== false && this.ssaoPass)
      ? this.ssaoPass.blurRenderTarget.texture : this.whiteTex;
    sm.uniforms['uExposure'].value = this.cameraBrightness;
    sm.uniforms['uBloomStrength'].value = this.bloomStrength;
    r.setRenderTarget(null);
    this.accumShowQuad!.render(r);
  }

  // ── Visualisation menu / theme / camera settings ──────────────────────────────

  toggleVisMenu() { this.visMenuOpen = !this.visMenuOpen; }
  openSettings() { this.visMenuOpen = false; this.settingsDialogOpen = true; }
  closeSettings() { this.settingsDialogOpen = false; }

  /** Flip the UI between dark and light; the 3D background follows the theme too. */
  toggleTheme() { this.lightTheme = !this.lightTheme; this.applyViewportBackground(); this.rebuildNavCubeFaces(); }

  /** Camera brightness slider changed — re-apply the lighting multiplier live. */
  onBrightnessChange() { this.applyLighting(); }

  /** Toggle directional light (shadows + AO) vs flat diffuse-only environment lighting. */
  setDirectLight(on: boolean) {
    this.directLight = on;
    this.applyRenderEnv();
    this.applyLighting();
    this.accumDirty = true;
  }

  /** Environment (IBL) intensity: kept low in Render so the shadow-mapped samples carry the
   *  diffuse and the soft shadows / AO stay visible (the env is mainly for specular reflections).
   *  Both lighting modes use the sampled shadows, so this no longer depends on `directLight`. */
  private applyRenderEnv() {
    if (!this.scene) return;
    this.scene.environmentIntensity = this.renderMode ? 0.28 : 1.0;
  }

  /** The 3D background: white-ish in light theme, dark otherwise (a touch lighter in Render). */
  private applyViewportBackground() {
    if (!this.scene) return;
    const hex = this.lightTheme ? 0xeef1f5 : (this.renderMode ? 0x20242a : 0x0e0e0e);
    this.scene.background = new THREE.Color(hex);
  }

  /** Scale the scene lights (and Render exposure) by the camera-brightness multiplier. */
  private applyLighting() {
    if (!this.ambientLight) return;
    const b = this.cameraBrightness;
    if (this.renderMode) {
      // Diffuse lighting comes from the per-sample shadow-mapped hemisphere lights in
      // renderAccum (which also produce the AO), so the constant fill is OFF and ambient is
      // barely above zero — a uniform, unshadowed fill would flood crevices and cancel the AO.
      // keyLight's intensity/colour are set per sample in renderAccum; this value only seeds it.
      this.ambientLight.intensity = 0.015 * b;
      this.keyLight.intensity = 2.6 * b;
      this.fillLight.intensity = 0;
      this.renderer.toneMappingExposure = b;
    } else {
      this.ambientLight.intensity = 0.45 * b;
      this.keyLight.intensity = 1.4 * b;
      this.fillLight.intensity = 0.3 * b;
      this.renderer.toneMappingExposure = 1.0;  // NoToneMapping ignores it anyway
    }
  }

  /** Dispose and respawn every object from the data model (re-applies the active look). */
  private refreshAllObjects() {
    const sel = [...this.selectedIds];
    this.objectMap.forEach(o => { this.scene.remove(o); disposeObj(o); });
    this.objectMap.clear();
    this.instances.forEach(inst => this.spawnObject(inst));
    this.applySelect(sel);
    if (this.renderMode) this.fitShadowFrustum();   // scene may have changed shape/extent
    this.accumDirty = true;   // scene changed → restart Render-mode accumulation
  }

  /**
   * Procedural noise used as a bump map — a material's `bump` scales its strength and
   * its `bumpSize` sets the grain (mm per noise tile). The noise image is generated
   * once; one Texture per grain size is cached (they share the canvas but need their
   * own `repeat`).
   *
   * Generated at a deliberately LOW resolution (not a full-size per-pixel-random
   * canvas): bump mapping perturbs the shading normal from the height map's local
   * GRADIENT, so it only reads as visible relief where neighbouring texels actually
   * differ in a correlated way. True per-pixel-random noise has zero spatial
   * correlation — every texel is independent of its neighbours — so as soon as the GPU
   * samples it below full resolution (any normal viewing distance, or just a few mip
   * levels up), averaging drives it straight to flat grey and the bump all but
   * disappears. A small 24×24 grid, left to the GPU's own bilinear `magFilter`
   * interpolation to smooth between grid points, keeps a real (if gentle) undulation
   * visible across a much wider range of zoom instead of only right up against the
   * surface — this was the actual fix for "РЕЛЕФ doesn't look like anything": the
   * magnitude (`bumpScale` below) was never the limiting factor, the noise's total lack
   * of spatial coherence was.
   */
  private bumpCanvas: HTMLCanvasElement | null = null;
  private bumpTexBySize = new Map<number, THREE.Texture>();
  private proceduralBumpTexture(tileMM: number): THREE.Texture {
    const key = Math.max(2, Math.round(tileMM));
    const cached = this.bumpTexBySize.get(key);
    if (cached) return cached;
    if (!this.bumpCanvas) {
      const S = 24;
      const cv = document.createElement('canvas'); cv.width = cv.height = S;
      const ctx = cv.getContext('2d')!;
      const img = ctx.createImageData(S, S);
      for (let i = 0; i < S * S; i++) {
        // Full-contrast per-cell random — the grid itself (not the value spread) is
        // what needs to stay coarse; narrowing the spread here would just make the
        // already-subtle effect even fainter once interpolated.
        const v = (Math.random() * 255) | 0;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255;
      }
      ctx.putImageData(img, 0, 0);
      this.bumpCanvas = cv;
    }
    const tex = new THREE.CanvasTexture(this.bumpCanvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1 / key, 1 / key);       // one noise tile spans `key` mm of real surface
    this.bumpTexBySize.set(key, tex);
    return tex;
  }

  // One cached THREE.Texture per (image data URL + tile size) — a user-supplied bump
  // image (grayscale, or any image: only its red channel is sampled, same convention
  // every renderer's Bump slot uses — see `resolveBumpTexture`'s own doc comment).
  private customBumpCache = new Map<string, THREE.Texture>();
  private customBumpTexture(url: string, tileMM: number): THREE.Texture {
    const key = Math.max(2, Math.round(tileMM));
    const cacheKey = `${url}@${key}`;
    let tex = this.customBumpCache.get(cacheKey);
    if (!tex) {
      tex = new THREE.TextureLoader().load(url);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      // Height data, not colour — must stay linear (THREE defaults to NoColorSpace),
      // unlike the main diffuse texture (materialTexture, above) which needs sRGB.
      tex.repeat.set(1 / key, 1 / key);
      this.customBumpCache.set(cacheKey, tex);
    }
    return tex;
  }

  /**
   * The bump map THIS material actually uses — mimics a renderer's generic "Bump" slot
   * (V-Ray's included): any grayscale image the user supplies via `bumpTexture`
   * (Materials dialog → "Релеф текстура"), tiled at `bumpSize` mm — same real-world
   * tiling convention the main diffuse texture uses (`materialTexture`). Falls back to
   * the built-in procedural noise (`proceduralBumpTexture`) when no custom image is
   * set, so every material still gets a sensible default relief instead of none.
   */
  private resolveBumpTexture(def: MaterialDef): THREE.Texture {
    const size = def.bumpSize ?? 24;
    return def.bumpTexture ? this.customBumpTexture(def.bumpTexture, size) : this.proceduralBumpTexture(size);
  }

  /**
   * CAD-mode indication (not Render): tint each panel's faces with its assigned material's
   * colour — a flat colour swatch so finishes are distinguishable without entering Render.
   * Bands take their `*_КАНТ_МАТЕРИАЛ` colour; the textured chipboard edge keeps its look.
   * Faces with no library material fall back to the neutral COLOR_NORMAL (also clears any
   * lingering selection blue on deselect).
   */
  private cadColorObj(obj: THREE.Object3D, inst: SceneInstance) {
    const toKey = (p: string) => p.replace(/ /g, '_') + '_МАТЕРИАЛ';
    const toKantKey = (p: string) => p.replace(/ /g, '_') + '_КАНТ_МАТЕРИАЛ';
    obj.traverse(child => {
      if (!(child instanceof THREE.Mesh) || child.userData['isEdge']) return;
      let n: THREE.Object3D | null = child, panelName: string | undefined;
      while (n && n !== obj) { if (n.userData['panel']) { panelName = n.userData['panel'].name as string; break; } n = n.parent; }
      // Panel-less families (ПЛОСКОСТ) carry their own МАТЕРИАЛ/МАТЕРИАЛ_КАНТ picks in
      // inst.materials; fall back to the free-text laminate spec (inst.material) for
      // families with neither (СТЕНА/ПЛОЧА) — same rule as applyRenderMaterials below.
      // panelMaterialGroup lets a family share one pick across several panel names
      // (ЧЕКМЕДЖЕ's structural panels) instead of one per name.
      const group = panelName ? panelMaterialGroup(inst.familyId, panelName) : undefined;
      const boardDef = group
        ? this.materialDef(inst.materials?.[toKey(group)])
        : this.materialDef(inst.materials?.['МАТЕРИАЛ'] ?? inst.material);
      const kantDef = group
        ? this.materialDef(inst.materials?.[toKantKey(group)])
        : (inst.materials?.['МАТЕРИАЛ_КАНТ'] ? this.materialDef(inst.materials['МАТЕРИАЛ_КАНТ']) : boardDef);
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      (mats as THREE.MeshPhongMaterial[]).forEach(m => {
        if (m.map) return;                                    // textured chipboard edge — leave it
        const def = m.userData['edgeBand'] ? kantDef : boardDef;
        if (def) m.color.set(def.color); else m.color.setHex(COLOR_NORMAL);
      });
    });
  }

  /**
   * A panel's own wood-grain rotation override (0° or 90°), read from its own
   * ЗАВЪРТЯН_ФЛАДЕР toggle (see KORPUS_PARAMS, webcad-families.ts and
   * `panelGrainParamKey`, webcad-geometry.ts) — rotates the texture about its own
   * centre, about the axis perpendicular to the panel's face, independent of the
   * material's own global ЗАВЪРТАНЕ НА ТЕКСТУРАТА (every panel using that material
   * otherwise shares one rotation). Same toggle also flips which of the panel's two
   * dimensions the cut-list reports as РАЗМЕР 1 — see `collectPanels`'s own grain-swap
   * (webcad-schedule.ts) — both read the identical ON/OFF state, just applied two ways.
   * 0 for a family/panel with no such param (e.g. ПОЛИЦА, ЧЕКМЕДЖЕ) — `params[...]` is
   * simply undefined there.
   */
  private panelGrainRotation(inst: SceneInstance, panelName: string | undefined): number {
    if (!panelName) return 0;
    return inst.params[panelGrainParamKey(panelName)] === 1 ? 90 : 0;
  }

  /**
   * Convert an object's flat MeshPhong materials to MeshStandard (PBR) so they react to
   * the environment, and hide its CAD edge lines. Each panel's chosen МАТЕРИАЛИ drive
   * the look: the board face takes its panel material, PVC bands take the matching
   * `*_КАНТ_МАТЕРИАЛ`, and the exposed chipboard edge keeps its texture. Where no library
   * material is assigned, falls back to sensible roughness per material role.
   */
  private applyRenderMaterials(obj: THREE.Object3D, inst: SceneInstance, dispose = true) {
    const toKey = (panelName: string) => panelName.replace(/ /g, '_') + '_МАТЕРИАЛ';
    const toKantKey = (panelName: string) => panelName.replace(/ /g, '_') + '_КАНТ_МАТЕРИАЛ';
    obj.traverse(child => {
      if (child instanceof THREE.LineSegments && child.userData['isEdge']) { child.visible = false; return; }
      if (!(child instanceof THREE.Mesh) || child.userData['isEdge']) return;

      // Which panel (if any) does this mesh belong to? Walk up to the panel-tagged node.
      let n: THREE.Object3D | null = child, panelName: string | undefined;
      while (n && n !== obj) {
        if (n.userData['panel']) { panelName = n.userData['panel'].name as string; break; }
        n = n.parent;
      }
      // Panel-less families (ПЛОСКОСТ) carry their own МАТЕРИАЛ/МАТЕРИАЛ_КАНТ picks in
      // inst.materials; fall back to the free-text laminate spec (inst.material) for
      // families with neither (СТЕНА/ПЛОЧА). panelMaterialGroup lets a family share one
      // pick across several panel names (ЧЕКМЕДЖЕ's structural panels) instead of one
      // per name — same rule as cadColorObj above.
      const group = panelName ? panelMaterialGroup(inst.familyId, panelName) : undefined;
      const boardDef = group
        ? this.materialDef(inst.materials?.[toKey(group)])
        : this.materialDef(inst.materials?.['МАТЕРИАЛ'] ?? inst.material);
      const kantDef = group
        ? this.materialDef(inst.materials?.[toKantKey(group)])
        : (inst.materials?.['МАТЕРИАЛ_КАНТ'] ? this.materialDef(inst.materials['МАТЕРИАЛ_КАНТ']) : boardDef);

      const conv = (m: THREE.MeshPhongMaterial): THREE.MeshPhysicalMaterial => {
        const isBand = !!m.userData['edgeBand'];
        const def = isBand ? kantDef : boardDef;
        // A flat board face (no .map) may take the material's JPG texture; the chipboard
        // edge (which already has m.map) keeps its own look. The *_ЗАВЪРТЯН_ФЛАДЕР grain-
        // direction override only ever applies to the board face, never the edge band.
        const defTex = !m.map ? this.materialTexture(def, isBand ? 0 : this.panelGrainRotation(inst, panelName)) : null;
        const std = new THREE.MeshPhysicalMaterial({
          // With a texture the colour is white (show the image faithfully); otherwise a
          // flat face takes the def colour, and a textured edge keeps its own colour.
          color: defTex ? new THREE.Color(0xffffff)
               : def && !m.map ? new THREE.Color(def.color)
               : (m.color ? m.color.clone() : new THREE.Color(0xffffff)),
          map: defTex ?? m.map ?? null,
          transparent: def ? def.transparency > 0 : m.transparent,
          opacity: def ? 1 - def.transparency / 100 : m.opacity,
          side: m.side,
          metalness: def ? def.reflection / 100 : 0,
          // clamp roughness away from 0 — a perfect mirror makes the path tracer emit NaNs
          // (which poison the running average → black) on some GPUs (e.g. Intel/ANGLE).
          roughness: Math.max(0.06, def ? 1 - def.glossiness / 100 : (m.userData['edgeBand'] ? (m.map ? 0.85 : 0.3) : 0.5)),
          // Metals (high reflection) get a boosted env intensity so their mirror reflections
          // survive the low scene.environmentIntensity used for AO; a metal has ~no diffuse env
          // term, so this doesn't re-flood matte surfaces or wash out the ambient occlusion.
          envMapIntensity: (def ? 0.4 + def.reflection / 100 : 1) * (def && def.reflection > 50 ? 3.6 : 1),
        });
        // Bump/relief: a procedural noise map perturbs the shading normals for a fine
        // structured surface (e.g. ШАГРЕ / orange-peel), scaled by the material's `bump`.
        if (def?.bump) {
          std.bumpMap = this.resolveBumpTexture(def);
          std.bumpScale = (def.bump / 100) * 1.4;
        }
        // Clearcoat: a thin, perfectly-smooth lacquer layer over the textured/coloured base —
        // the "glossy painted MDF door" look a single roughness value can't reproduce (it has
        // to pick one: either the bump relief shows, or the highlight is mirror-sharp, never
        // both). Only for glossy, non-metal finishes — metals already get a sharp highlight
        // from their own low roughness and don't wear a separate coat.
        if (def && def.glossiness > 50 && def.reflection < 50) {
          std.clearcoat = 1;
          std.clearcoatRoughness = Math.max(0.02, 1 - (def.glossiness - 50) / 50 * 0.95);
        }
        std.userData = { ...m.userData };   // keep edgeBand tag so colorObj still skips bands
        if (dispose) m.dispose();           // skip when converting throwaway clones (shared mats)
        return std;
      };
      child.material = Array.isArray(child.material)
        ? (child.material as THREE.MeshPhongMaterial[]).map(conv)
        : conv(child.material as THREE.MeshPhongMaterial);
    });
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

  /**
   * Scroll-zoom while a command is in progress. OrbitControls handles the wheel when
   * idle (controls enabled); when a tool has disabled them, we dolly the camera
   * ourselves so zoom keeps working between clicks.
   */
  private onCanvasWheel(e: WheelEvent) {
    if (this.controls.enabled) return;   // idle → let OrbitControls do the zoom
    e.preventDefault();
    this.dollyCamera(e.deltaY);
  }

  private onCanvasDown(e: MouseEvent) {
    // Shift + middle (scroll-wheel) drag orbits the camera even while the Measure tool
    // has the OrbitControls disabled, so you can look around between the two clicks —
    // but not in a 2D plan/elevation/Current-Plane view, which must stay perfectly
    // flat (same restriction `setViewPlane` already applies to OrbitControls' own
    // `enableRotate`; these two custom orbit gestures bypass that flag entirely, so
    // they need their own explicit check).
    if (e.button === 1 && e.shiftKey && this.viewPlane === '3D' &&
        (this.mode === 'measure-from' || this.mode === 'measure-to')) {
      e.preventDefault();   // suppress the browser's middle-click autoscroll
      this.orbiting = true;
      this.orbitPrev = { x: e.clientX, y: e.clientY };
      return;
    }
    // Idle right-drag with an active selection: orbit around the selection's centre
    // instead of OrbitControls' own target (see orbitCameraAroundPivot) — the matching
    // capture-phase 'pointerdown' listener in initThree steals this gesture from
    // OrbitControls before it ever sees it. Not in a 2D view — see this method's own
    // doc comment above.
    if (e.button === 2 && this.mode === 'idle' && this.controls.enabled && this.viewPlane === '3D') {
      const center = this.selectionCenter();
      if (center) {
        this.customOrbiting = true;
        this.customOrbitPivot.copy(center);
        this.customOrbitPrev = { x: e.clientX, y: e.clientY };
        this.customOrbitPhi = new THREE.Spherical().setFromVector3(this.camera.position.clone().sub(center)).phi;
        return;
      }
    }
    this.mouseDownAt  = { x: e.clientX, y: e.clientY };
    this.marqueeStart = { x: e.clientX, y: e.clientY };
    this.isMarqueeing = false;
  }

  private onCanvasMove(e: MouseEvent) {
    // Active orbit (Shift + middle drag) takes precedence over any tool preview.
    if (this.orbiting) {
      if (!(e.buttons & 4)) { this.orbiting = false; return; }   // middle button released elsewhere
      this.orbitCamera(e.clientX - this.orbitPrev.x, e.clientY - this.orbitPrev.y);
      this.orbitPrev = { x: e.clientX, y: e.clientY };
      return;
    }

    if (this.customOrbiting) {
      if (!(e.buttons & 2)) { this.customOrbiting = false; return; }   // right button released elsewhere
      this.orbitCameraAroundPivot(e.clientX - this.customOrbitPrev.x, e.clientY - this.customOrbitPrev.y, this.customOrbitPivot);
      this.customOrbitPrev = { x: e.clientX, y: e.clientY };
      return;
    }

    if (this.mode === 'placing') {
      const snap = this.getSnap(e, null, null);
      if (!snap) return;
      if (this.ghost) this.ghost.position.set(snap.pos.x, 0, snap.pos.z);
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'measure-from') {
      const snap = this.measureSnap(e);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'move-from') {
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

    if (this.mode === 'line-plane') {
      const plane = this.pickFacePlane(e);
      this.linePlanePreview = plane;
      this.updatePlaneGhost(plane);
      return;
    }

    if (this.mode === 'pick-plane') {
      const plane = this.pickFacePlane(e);
      this.pickPlanePreview = plane;
      this.updatePlaneGhost(plane);
      return;
    }

    if (this.mode === 'line-from') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'line-to') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      const last = this.linePath[this.linePath.length - 1];
      const pos = e.shiftKey ? this.lockAxisOnPlane(snap.pos, last, this.linePlane!) : snap.pos;
      this.showSnap(pos, snap.type);
      // While picking the arc's own mid-point there's nothing to bulge yet — same
      // straight guide-line preview as a normal segment, it just isn't the final point.
      this.updateLineGhost(last, pos);
      return;
    }

    if (this.mode === 'line-arc-mid') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      const last = this.linePath[this.linePath.length - 1];
      this.updateCurveGhost(last, this.pendingArcMid!, snap.pos);
      return;
    }

    if (this.mode === 'circle-center') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'circle-radius') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      this.updateCircleGhost(snap.pos);
      return;
    }

    if (this.mode === 'line-session') {
      // Left-button drag: a marquee box, same "past a 5px threshold" pattern the
      // idle whole-instance marquee below already uses, just selecting SEGMENTS
      // (performSegmentMarqueeSelect) instead of instances on mouseup.
      if (e.buttons === 1) {
        const dx = e.clientX - this.marqueeStart.x;
        const dy = e.clientY - this.marqueeStart.y;
        if (!this.isMarqueeing && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) this.isMarqueeing = true;
        if (this.isMarqueeing) {
          const r = this.canvasRef.nativeElement.getBoundingClientRect();
          const left = Math.min(this.marqueeStart.x, e.clientX) - r.left;
          const top = Math.min(this.marqueeStart.y, e.clientY) - r.top;
          this.ngZone.run(() => { this.marqueeRect = { left, top, width: Math.abs(dx), height: Math.abs(dy) }; });
          return;
        }
      }
      this.hoverSegIndex = this.pickOverlaySegment(e);
      this.refreshSegmentHighlight();
      return;
    }

    if (this.mode === 'copy-seg-from') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      return;
    }

    if (this.mode === 'copy-seg-to') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      const pos = e.shiftKey ? this.lockAxisOnPlane(snap.pos, this.segmentCopyFrom!, this.linePlane!) : snap.pos;
      this.showSnap(pos, snap.type);
      this.moveFrom.copy(this.segmentCopyFrom!);
      this.showMoveMeasure(e, pos);
      this.updateSegmentCopyGhost(pos);
      return;
    }

    if (this.mode === 'measure-to') {
      // Shift locks the segment parallel to an axis (0x / 0y / 0z) through the first
      // point — but a real point under the cursor still wins, see measureSnapOrAxisLock.
      if (e.shiftKey) {
        const r = this.measureSnapOrAxisLock(e);
        if (!r) return;
        this.showSnap(r.pos, r.type);
        this.showMeasure(r.pos);
        return;
      }
      const snap = this.measureSnap(e);
      if (!snap) return;
      this.showSnap(snap.pos, snap.type);
      this.showMeasure(snap.pos);
      return;
    }

    if (this.mode === 'move-to') {
      if (this.wallEdit) { this.wallEditMove(e); return; }
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
    if (this.orbiting && e.button === 1) { this.orbiting = false; return; }
    if (this.customOrbiting && e.button === 2) { this.customOrbiting = false; return; }
    if (e.button !== 0) return;
    if (this.isMarqueeing && this.mode === 'idle') {
      this.isMarqueeing = false;
      this.performMarqueeSelect(this.marqueeStart, { x: e.clientX, y: e.clientY });
      this.ngZone.run(() => { this.marqueeRect = null; });
    } else if (this.isMarqueeing && this.mode === 'line-session') {
      this.isMarqueeing = false;
      this.performSegmentMarqueeSelect(this.marqueeStart, { x: e.clientX, y: e.clientY });
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
      if (!obj.visible) return;
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

  /** Drag-box multi-select for segments while in `'line-session'` — same screen-space
   *  AABB-overlap test `performMarqueeSelect` already uses for whole instances, just
   *  run against the segment overlay's own pick meshes (already built for raycasting,
   *  so no new sampling needed) instead of `objectMap`. Deliberately ADDITIVE (only
   *  ever adds to `selectedSegmentIndices`, never clears it) rather than replacing,
   *  unlike the whole-instance marquee — segments are small/fiddly to box-select
   *  precisely, so an accidental empty drag shouldn't wipe out a selection already
   *  built up click by click. */
  private performSegmentMarqueeSelect(start: { x: number; y: number }, end: { x: number; y: number }) {
    if (!this.segmentOverlay) return;
    const s = this.clientToNDC(start.x, start.y);
    const f = this.clientToNDC(end.x, end.y);
    const minX = Math.min(s.x, f.x), maxX = Math.max(s.x, f.x);
    const minY = Math.min(s.y, f.y), maxY = Math.max(s.y, f.y);

    const hitKeys: number[] = [];
    this.segmentOverlay.traverse(c => {
      if (!(c instanceof THREE.Mesh)) return;
      c.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(c);
      if (box.isEmpty()) return;
      let oMinX = Infinity, oMaxX = -Infinity, oMinY = Infinity, oMaxY = -Infinity;
      const { min: mn, max: mx } = box;
      for (const cx of [mn.x, mx.x]) for (const cy of [mn.y, mx.y]) for (const cz of [mn.z, mx.z]) {
        const v = new THREE.Vector3(cx, cy, cz).project(this.camera);
        if (v.x < oMinX) oMinX = v.x; if (v.x > oMaxX) oMaxX = v.x;
        if (v.y < oMinY) oMinY = v.y; if (v.y > oMaxY) oMaxY = v.y;
      }
      if (oMaxX >= minX && oMinX <= maxX && oMaxY >= minY && oMinY <= maxY) hitKeys.push(c.userData['segKey'] as number);
    });
    if (hitKeys.length === 0) return;
    this.ngZone.run(() => {
      hitKeys.forEach(k => this.selectedSegmentIndices.add(k));
      this.refreshSegmentHighlight();
      this.syncTrimRadiusFromSelection();
    });
  }

  /** Raycast the cursor against object faces; returns the nearest instance id or null. */
  private pickInstance(e: MouseEvent): number | null {
    this.raycaster.setFromCamera(this.ndc(e), this.camera);
    const meshes: THREE.Mesh[] = [];
    this.objectMap.forEach((obj, id) => {
      if (!obj.visible) return;
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

  private baseEdgeColor(id: number): number {
    if (this.selectedIds.has(id)) return EDGE_SELECTED;
    return this.instances.find(i => i.id === id)?.familyId === 'line' ? LINE_IDLE_COLOR : EDGE_NORMAL;
  }

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
      const inst = this.instances.find(i => i.id === this.hoverId);
      if (inst?.familyId === 'solid' && inst.isVoid) {
        if (!this.selectedIds.has(this.hoverId)) this.setVoidPreview(this.hoverId, false);
      } else {
        const g = this.objectMap.get(this.hoverId);
        if (g) setEdgeColor(g, this.baseEdgeColor(this.hoverId));
        // keep a persistently sub-selected panel highlighted
        if (this.selectedPanelNode) setEdgeColor(this.selectedPanelNode, EDGE_SELECTED);
      }
    }
    this.hoverId = null; this.hoverPanels = []; this.tabIndex = 0;
  }

  /** Track what's under the cursor while idle (drives the TAB cycle + the ТИП readout). */
  private updateHover(e: MouseEvent) {
    const id = this.pickInstance(e);
    if (id !== this.hoverId) {
      this.clearHover();
      this.hoverId = id; this.tabIndex = 0;
      const inst = id === null ? null : (this.instances.find(i => i.id === id) ?? null);
      this.ngZone.run(() => { this.hoveredInst = inst; });
      if (inst?.familyId === 'solid' && inst.isVoid && id !== null && !this.selectedIds.has(id)) this.setVoidPreview(id, true);
    }
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
          this.modeLabel = 'Click the next corner or type a length — hold Shift to lock to X/Z — Esc to finish';
          this.distanceLocked = false; this.distanceStr = ''; this.distFocusPending = true;
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

    if (this.mode === 'line-plane') {
      const plane = this.linePlanePreview ?? this.pickFacePlane(e);
      this.ngZone.run(() => this.commitLinePlane(plane));
      return;
    }

    if (this.mode === 'pick-plane') {
      const plane = this.pickPlanePreview ?? this.pickFacePlane(e);
      this.commitCurrentPlane(plane);
      return;
    }

    if (this.mode === 'line-from') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (snap) {
        this.ngZone.run(() => {
          // Resuming an Edit session (seedFromEditTarget pre-seeded linePath with the
          // WHOLE existing path, length > 1 — a fresh line/curve always starts it
          // empty): addLinePoint always extends the CURRENT LAST point, which is fine
          // when that's the end you clicked near, but clicking back on the path's
          // OTHER open end (its first vertex) means "continue from THAT end instead" —
          // flip the seeded path first, so the new point attaches there instead of
          // also silently drawing a segment from the untouched end to wherever was
          // clicked (points 1 and 3 of a 3-point line getting spuriously connected).
          if (this.linePath.length > 1 && snap.pos.distanceTo(this.linePath[0]) < 1) {
            this.reverseLinePathAndArcs();
          }
          this.addLinePoint(snap.pos);
          this.mode = 'line-to';
          this.modeLabel = 'Click the next corner or type a length — click the first point or Enter to finish';
        });
      }
      return;
    }

    if (this.mode === 'line-to') {
      // Clicking back on the first vertex closes the loop (straight final segment
      // only — closing with a curved final segment isn't supported, see startCurve's
      // own doc comment).
      if (!this.lineNextSegmentCurved && this.nearFirstLineVertex(e)) { this.ngZone.run(() => this.closeLine()); return; }
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      const last = this.linePath[this.linePath.length - 1];
      const pos = e.shiftKey ? this.lockAxisOnPlane(snap.pos, last, this.linePlane!) : snap.pos;
      if (pos.distanceTo(last) < 1) return;
      if (this.lineNextSegmentCurved) {
        this.ngZone.run(() => {
          this.pendingArcMid = pos.clone();
          this.mode = 'line-arc-mid';
          this.modeLabel = 'Click the arc\'s end point — Esc to cancel';
        });
      } else {
        this.ngZone.run(() => this.addLinePoint(pos));
      }
      return;
    }

    if (this.mode === 'line-arc-mid') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      const last = this.linePath[this.linePath.length - 1];
      if (snap.pos.distanceTo(last) < 1) return;
      this.ngZone.run(() => {
        this.addLinePoint(snap.pos, this.pendingArcMid!);
        this.pendingArcMid = null;
        this.mode = 'line-to';
        this.modeLabel = 'Click the next corner or type a length — click the first point or Enter to finish';
      });
      return;
    }

    if (this.mode === 'circle-center') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (snap) this.ngZone.run(() => this.commitCircleCenter(snap.pos));
      return;
    }

    if (this.mode === 'circle-radius') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (snap) this.commitCircle(snap.pos);
      return;
    }

    if (this.mode === 'line-session') {
      const segIndex = this.pickOverlaySegment(e);
      if (segIndex !== null) {
        this.ngZone.run(() => {
          if (this.selectedSegmentIndices.has(segIndex)) this.selectedSegmentIndices.delete(segIndex);
          else this.selectedSegmentIndices.add(segIndex);
          this.refreshSegmentHighlight();
          this.syncTrimRadiusFromSelection();
        });
      }
      return;
    }

    if (this.mode === 'copy-seg-from') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (snap) {
        this.ngZone.run(() => {
          this.segmentCopyFrom = snap.pos.clone();
          this.mode = 'copy-seg-to';
          this.modeLabel = 'Click the destination point (or type a distance) — Esc to cancel';
          this.distFocusPending = true;
        });
      }
      return;
    }

    if (this.mode === 'copy-seg-to') {
      const snap = this.getSnapOnPlane(e, this.linePlane!, null);
      if (!snap) return;
      const pos = e.shiftKey ? this.lockAxisOnPlane(snap.pos, this.segmentCopyFrom!, this.linePlane!) : snap.pos;
      this.ngZone.run(() => this.finishSegmentCopy(pos));
      return;
    }

    if (this.mode === 'measure-from') {
      const snap = this.measureSnap(e);
      if (snap) {
        this.measureFrom.copy(snap.pos);
        this.hideMeasure();   // clear any previous frozen measurement
        this.ngZone.run(() => {
          this.mode = 'measure-to';
          this.modeLabel = 'Click the second point — Shift locks to an axis · Shift+scroll-drag orbits — Esc to finish';
        });
      }
      return;
    }

    if (this.mode === 'measure-to') {
      const pos = e.shiftKey ? this.measureSnapOrAxisLock(e)?.pos : this.measureSnap(e)?.pos;
      if (pos) {
        this.showMeasure(pos);   // freeze the dimension at the clicked point
        this.ngZone.run(() => {
          this.mode = 'measure-from';   // ready for the next measurement (a new first click clears this one)
          this.modeLabel = 'Click the first point — Shift+scroll-drag orbits — Esc to finish';
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
      if (this.wallEdit) {
        const snap = this.getSnap(e, this.groundPlane, new Set([this.wallEdit.instId]));
        if (snap) {
          let pos = e.shiftKey ? this.lockAxisXZ(snap.pos, this.moveFrom) : snap.pos;
          const typed = parseFloat(this.distanceStr);
          if (this.distanceLocked && isFinite(typed) && typed > 0 && this.moveDir.lengthSq() > 1e-9) {
            pos = this.moveFrom.clone().addScaledVector(this.moveDir, typed);
          }
          this.ngZone.run(() => this.finishWallEdit(pos));
        }
        return;
      }
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

    // ── idle: clicking a wall handle picks up that vertex / segment for editing ──
    // (skipped while Shift is held, which is reserved for additive selection.)
    if (this.wallHandleGroup && !e.shiftKey) {
      const h = this.pickWallHandle(e);
      if (h) { this.ngZone.run(() => this.startWallEdit(h.kind, h.index)); return; }
    }

    // ── idle: select a sub-panel (TAB-focused) or the whole instance ────────
    const hitId = this.pickInstance(e);
    // Capture the TAB-focused panel before clearing the hover state.
    const panelNode = this.tabIndex >= 1 ? this.hoverPanels[this.tabIndex - 1] : null;
    const panelInstanceId = this.hoverId;
    this.clearHover();   // selection takes over the edge colours

    // Shift-click is additive: add the clicked instance to the selection, or toggle it
    // out if it is already selected. (Multi-select works on whole instances, so Shift
    // ignores TAB panel focus; clicking empty space keeps the current selection.)
    if (e.shiftKey) {
      if (hitId === null) return;
      this.ngZone.run(() => {
        this.clearSubSelection();
        const ids = new Set(this.selectedIds);
        if (ids.has(hitId)) ids.delete(hitId); else ids.add(hitId);
        this.applySelect([...ids]);
      });
      return;
    }

    this.ngZone.run(() => {
      this.clearSubSelection();
      const hitInst = hitId !== null ? this.instances.find(x => x.id === hitId) : undefined;
      if (panelNode && panelInstanceId !== null) {
        this.applySelect([]);   // a panel isn't an instance — no instance selection
        this.selectSubPanel(panelInstanceId, panelNode);
      } else if (hitInst && hitInst.familyId === 'wall') {
        // Clicking a wall's face never toggles it off — it (re)selects the wall and
        // tries to show a temporary dimension to the nearest parallel surface.
        if (!(this.selectedIds.size === 1 && this.selectedIds.has(hitInst.id))) this.applySelect([hitInst.id]);
        this.tryStartWallFaceDimension(e, hitInst);
      } else if (hitId !== null) {
        this.applySelect(this.selectedIds.size === 1 && this.selectedIds.has(hitId) ? [] : [hitId]);
      } else {
        this.applySelect([]);
      }
    });
  }
}
