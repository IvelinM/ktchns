import {
  Component, ElementRef, ViewChild, OnInit, OnDestroy, NgZone, HostListener, HostBinding,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// The CAD engine is split into focused modules (see each file's header):
//   webcad.model     — data model & shared constants (the vocabulary; read first)
//   webcad-geometry  — pure solid builders (ploskost, korpus, wall, slab)
//   webcad-families  — the catalog of parametric object types (FAMILIES)
//   webcad-object3d  — Three.js object utilities (dispose, anchor, edges, colours, ghost)
//   webcad-schedule  — cut-list (Спецификация) text generation
// This component is the Angular *interaction controller*: it owns the viewport, the
// scene<->data sync, the toolbar/panel UI, and every mouse/keyboard tool.
import {
  ParamDef, MaterialDef, FamilyDef, BasePoint, WallPoint,
  SceneInstance, SceneSnapshot, PanelInfo, InteractionMode, MovePlane,
  COLOR_NORMAL, COLOR_SELECTED, EDGE_NORMAL, EDGE_SELECTED, EDGE_HOVER,
  CENTRE_ANCHOR, WALL_Y,
} from './webcad.model';
import { makeMesh, buildWallPath, buildSlabPath } from './webcad-geometry';
import { FAMILIES } from './webcad-families';
import { disposeObj, normAnchor, anchorWrap, addEdges, colorObj, setEdgeColor, ghostify } from './webcad-object3d';
import { buildScheduleText } from './webcad-schedule';

// Minimal File System Access API typings — not yet in this project's configured TS/DOM
// lib, and only used for Save/Save as/Open (see the "Save / Load scene" section below).
declare global {
  interface FileSystemFileHandle {
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

/** localStorage key the in-progress scene is autosaved under, so a refresh doesn't lose it. */
const AUTOSAVE_KEY = 'webcad-autosave-v1';
/** How often the autosave safety-net timer writes, in ms (also saved on `beforeunload`). */
const AUTOSAVE_INTERVAL_MS = 5000;

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
  materialDefs: MaterialDef[] = [
    { name: 'ГЛАДКО БЯЛО', color: '#f0f0f0', transparency: 0, reflection: 8, glossiness: 50 },
    { name: 'БЯЛО МАТ',    color: '#e9e9e9', transparency: 0, reflection: 2, glossiness: 18 },
  ];

  // ── Materials dialog ──────────────────────────────────────────────────────────
  materialsDialogOpen = false;
  editingMaterialIndex = 0;

  // ── Visualisation menu / theme / settings ────────────────────────────────────
  /** Light vs dark UI theme; bound to the host so the SCSS variable overrides apply. */
  @HostBinding('class.light') lightTheme = false;
  visMenuOpen = false;            // the toolbar "Visualisation" dropdown
  settingsDialogOpen = false;     // the Settings dialog (camera brightness)
  cameraBrightness = 1.0;         // global light/exposure multiplier (0.2–2.0)

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
  // The file this scene was last saved to (or opened from) via the File System Access
  // API — lets "Save" overwrite it silently. Null until a "Save as…"/Open succeeds with
  // that API, or in browsers that lack it (Firefox/Safari), where "Save" always falls
  // back to "Save as…" (a fresh download) since the page can't get write access otherwise.
  private savedFileHandle: FileSystemFileHandle | null = null;
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
  private orbiting = false;                 // Shift + middle-drag orbit while a tool is active
  private orbitPrev = { x: 0, y: 0 };

  private boundClick!: (e: MouseEvent) => void;
  private boundMove!:  (e: MouseEvent) => void;
  private boundDown!:  (e: MouseEvent) => void;
  private boundUp!:    (e: MouseEvent) => void;
  private boundWheel!: (e: WheelEvent) => void;

  // Autosave: keeps the in-progress scene alive across an accidental refresh/tab close.
  // Independent of Save/Save as/Open — it just mirrors whatever is currently on screen.
  private boundBeforeUnload!: () => void;
  private autosaveIntervalId = 0;

  constructor(private ngZone: NgZone) {}

  ngOnInit() {
    this.resetParams();
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
    const navCv = this.navCubeCanvasRef?.nativeElement;
    navCv?.removeEventListener('mousemove',  this.boundNavMove);
    navCv?.removeEventListener('click',      this.boundNavClick);
    navCv?.removeEventListener('mouseleave', this.boundNavLeave);
    this.navCube?.geometry.dispose();
    (this.navCube?.material as THREE.MeshBasicMaterial[] | undefined)?.forEach(m => { m.map?.dispose(); m.dispose(); });
    this.navRenderer?.dispose();
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
      this.materialsDialogOpen = false; this.settingsDialogOpen = false; return;
    }

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
   * Returns null when the material has no texture.
   */
  private materialTexture(def: MaterialDef | undefined): THREE.Texture | null {
    if (!def?.texture) return null;
    const w = def.textureW && def.textureW > 0 ? def.textureW : 1000;
    const h = def.textureH && def.textureH > 0 ? def.textureH : 1000;
    const rot = ((def.textureRotation ?? 0) * Math.PI) / 180;
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
  }

  // ── Materials dialog ──────────────────────────────────────────────────────────

  toggleMaterials() { this.materialsDialogOpen = !this.materialsDialogOpen; }
  closeMaterials() { this.materialsDialogOpen = false; }

  get editingMaterial(): MaterialDef | undefined { return this.materialDefs[this.editingMaterialIndex]; }
  selectEditingMaterial(i: number) { this.editingMaterialIndex = i; }

  /** Re-skin the scene live while editing a material (only matters in Render mode). */
  onMaterialEdited() {
    this.clearTextureCache();   // a texture/tile change must rebuild the GPU texture
    if (this.renderMode) this.refreshAllObjects();
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

  /** Assign a per-panel material on the selected instance (data only — no geometry rebuild). */
  setMaterial(key: string, value: string) {
    const inst = this.selectedInstance;
    if (!inst) return;
    if (!inst.materials) inst.materials = {};
    inst.materials[key] = value;
    this.commitPendingEdit();
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
    return this.getFamilyDef(inst.familyId).buildObject(inst.params);
  }

  private spawnObject(inst: SceneInstance) {
    this.backfillParams(inst);
    this.backfillMaterials(inst);
    const built = this.buildInstanceObject(inst);
    addEdges(built);
    const obj = anchorWrap(built, inst.anchor, inst.rotY);
    obj.position.set(inst.x, inst.y, inst.z);
    obj.rotation.y = inst.rotY * (Math.PI / 180);
    if (this.renderMode) this.applyRenderMaterials(obj, inst);
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
    this.clearWallDims();
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
    this.updateWallHandles();   // show editable handles when a single wall is selected
  }

  clickList(id: number) {
    this.cancelMode();
    this.applySelect(this.selectedIds.size === 1 && this.selectedIds.has(id) ? [] : [id]);
  }

  // ── Undo history ─────────────────────────────────────────────────────────────

  /** Deep copy of the data model (the source of truth — the 3D scene is derived). */
  private snapshot(): SceneSnapshot {
    return { instances: this.instances.map(i => ({ ...i, params: { ...i.params }, materials: i.materials ? { ...i.materials } : undefined, anchor: i.anchor ? { ...i.anchor } : undefined, path: i.path ? i.path.map(p => ({ ...p })) : undefined })), nextId: this.nextId };
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
    this.instances = snap.instances.map(i => ({ ...i, params: { ...i.params }, materials: i.materials ? { ...i.materials } : undefined, anchor: i.anchor ? { ...i.anchor } : undefined, path: i.path ? i.path.map(p => ({ ...p })) : undefined }));
    this.nextId = snap.nextId;
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
      // Family instances: position, rotation, anchor, every parameter value, the module
      // material name, per-panel МАТЕРИАЛИ picks, and any wall/slab polyline.
      instances: this.instances,
      // The editable material library (name + colour/transparency/reflection/glossiness).
      materials: this.materialDefs,
      // Visualisation + view settings so the scene reopens looking identical.
      view: {
        theme: this.lightTheme ? 'light' : 'dark',
        cameraBrightness: this.cameraBrightness,
        camera: {
          position: { x: cam.position.x, y: cam.position.y, z: cam.position.z },
          target:   { x: tgt.x, y: tgt.y, z: tgt.z },
        },
      },
    };
  }

  /** Fallback save: trigger a browser download of the scene JSON (no file handle to keep). */
  private downloadScene() {
    const blob = new Blob([JSON.stringify(this.buildSceneDoc(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'scene.json';
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
          suggestedName: 'scene.json',
          types: [{ description: 'WebCAD scene', accept: { 'application/json': ['.json'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(this.buildSceneDoc(), null, 2));
        await writable.close();
        this.savedFileHandle = handle;
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

  /** Parse a scene JSON file and recreate every object, coordinate and property. */
  private loadSceneFile(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const { snap, materials, view } = this.parseSceneJson(String(reader.result));
        this.ngZone.run(() => {
          this.pushHistory();   // loading is undoable
          this.restoreScene(snap);
          this.restoreMaterialLibrary(materials);
          this.restoreView(view);
        });
      } catch {
        this.ngZone.run(() => alert('Invalid scene file — expected WebCAD scene JSON.'));
      }
    };
    reader.readAsText(file);
  }

  /** Normalise + validate a scene JSON string into a restorable snapshot; throws on invalid input. */
  private parseSceneJson(text: string): { snap: SceneSnapshot; materials: unknown; view: unknown } {
    const doc = JSON.parse(text);
    const instances = Array.isArray(doc) ? doc : doc.instances;   // accept a bare array too
    if (!Array.isArray(instances)) throw new Error('no instances array');
    // Normalise + validate each instance; coerce missing fields to safe defaults.
    const clean: SceneInstance[] = instances.map((i: Partial<SceneInstance>) => ({
      id: Number(i.id),
      familyId: String(i.familyId),
      label: String(i.label ?? `МОДУЛ ${i.id}`),
      params: { ...(i.params ?? {}) },
      material: String(i.material ?? ''),
      materials: i.materials && typeof i.materials === 'object' ? { ...i.materials } : undefined,
      x: Number(i.x) || 0, y: Number(i.y) || 0, z: Number(i.z) || 0,
      rotY: Number(i.rotY) || 0,
      anchor: normAnchor(i.anchor),
      path: Array.isArray(i.path)
        ? i.path.map((p: Partial<WallPoint>) => ({ x: Number(p?.x) || 0, z: Number(p?.z) || 0 }))
        : undefined,
    })).filter(i => Number.isFinite(i.id) && this.getFamilyDef(i.familyId));
    const maxId = clean.reduce((m, i) => Math.max(m, i.id), 0);
    const nextId = Number(doc.nextId) > maxId ? Number(doc.nextId) : maxId + 1;
    return { snap: { instances: clean, nextId }, materials: doc.materials, view: doc.view };
  }

  // ── Autosave (localStorage) ──────────────────────────────────────────────────
  //
  // Independent of Save/Save as/Open: mirrors whatever is currently on screen so a
  // refresh, an accidental tab close, or a crash doesn't lose in-progress work. Written
  // on a timer and on `beforeunload`; restored once at startup if present.

  /** Serialise the current scene and write it to localStorage; silently no-ops on failure
   *  (storage full, private-browsing mode, or an unserialisable value). */
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
  }

  /** Restore the autosaved scene from localStorage, if any — called once at startup. */
  private restoreAutosave() {
    const text = localStorage.getItem(AUTOSAVE_KEY);
    if (!text) return;
    try {
      const { snap, materials, view } = this.parseSceneJson(text);
      if (snap.instances.length === 0) return;   // nothing worth restoring
      this.restoreScene(snap);
      this.restoreMaterialLibrary(materials);
      this.restoreView(view);
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
        texture: typeof m.texture === 'string' ? m.texture : undefined,
        textureW: Number(m.textureW) > 0 ? Number(m.textureW) : undefined,
        textureH: Number(m.textureH) > 0 ? Number(m.textureH) : undefined,
        textureRotation: Number.isFinite(m.textureRotation as number) ? Number(m.textureRotation) : undefined,
      }));
    if (!clean.length) return;
    this.clearTextureCache();
    this.materialDefs = clean;
    this.editingMaterialIndex = 0;
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
    const cp = view.camera?.position, ct = view.camera?.target;
    if (cp && Number.isFinite(cp.x) && Number.isFinite(cp.y) && Number.isFinite(cp.z)) {
      this.camera.position.set(cp.x, cp.y, cp.z);
    }
    if (ct && Number.isFinite(ct.x) && Number.isFinite(ct.y) && Number.isFinite(ct.z)) {
      this.controls.target.set(ct.x, ct.y, ct.z);
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

  /** Generate the cut-list (see webcad-schedule) and download it as a .txt for the shop. */
  exportSchedule() {
    const blob = new Blob([buildScheduleText(this.instances, this.itemize)], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'schedule.txt';
    a.click();
    URL.revokeObjectURL(url);
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
   * SAME family — you can't match a Ploskost onto a КОРПУС С ВРАТА. Placement
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

  // ── Move / Copy / Array (two-step snap) ────────────────────────────────────

  /** Toolbar tools are available only when something is selected and nothing else is in progress. */
  get canEdit(): boolean { return this.mode === 'idle' && this.selectedIds.size > 0; }

  startMove()  { this.beginMoveOp('move'); }
  startCopy()  { this.beginMoveOp('copy'); }
  startArray() { this.beginMoveOp('array'); }

  private beginMoveOp(kind: 'move' | 'copy' | 'array') {
    if (this.selectedIds.size === 0) return;
    this.clearWallDims();
    this.removeWallHandles();
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
    // Only a real Move shifts the originals (and so must restore them); Copy/Array don't.
    if (this.mode === 'move-to' && !this.isCopy && !this.isArray) {
      this.moveOrigins.forEach((origin, id) => {
        const inst = this.instances.find(i => i.id === id);
        const obj  = this.objectMap.get(id);
        if (inst && obj) { inst.x = origin.x; inst.y = origin.y; inst.z = origin.z; obj.position.copy(origin); }
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
    this.orbiting = false;
    this.snapDot.visible = false;
    this.hideMoveMeasure();
    this.hideMeasure();
    this.mode = 'idle'; this.modeLabel = '';
    this.controls.enabled = true;
    const finishedId = finishedWallId !== null ? finishedWallId : finishedSlabId;
    if (finishedId !== null) this.applySelect([finishedId]);
    this.updateWallHandles();
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

    const dx = raw.x - from.x, dy = raw.y - from.y, dz = raw.z - from.z;
    const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
    const pos = from.clone();                       // the other two coords stay on `from`
    if (ax >= ay && ax >= az)       pos.x = Math.round(from.x + dx);
    else if (ay >= ax && ay >= az)  pos.y = Math.round(from.y + dy);
    else                            pos.z = Math.round(from.z + dz);
    return pos;
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
      params: { ...src.params }, material: src.material, materials: src.materials ? { ...src.materials } : undefined, x, y, z, rotY: src.rotY,
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

    this.ambientLight = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(this.ambientLight);
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(3000, 5000, 3000);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
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
    this.controls.minDistance = 50;
    this.controls.maxDistance = 50000;
    // Keep the wall-face dimension labels glued to their 3D anchors while the user
    // orbits/pans/zooms (idle — OrbitControls stays enabled while they're shown).
    this.controls.addEventListener('change', () => {
      if (this.wallDims.length) this.ngZone.run(() => this.updateWallDimScreens());
    });

    this.boundDown  = (e) => this.onCanvasDown(e);
    this.boundClick = (e) => this.onCanvasClick(e);
    this.boundMove  = (e) => this.onCanvasMove(e);
    this.boundUp    = (e) => this.onCanvasUp(e);
    this.boundWheel = (e) => this.onCanvasWheel(e);
    canvas.addEventListener('mousedown', this.boundDown);
    canvas.addEventListener('click',     this.boundClick);
    canvas.addEventListener('mousemove', this.boundMove);
    canvas.addEventListener('mouseup',   this.boundUp);
    canvas.addEventListener('wheel',     this.boundWheel, { passive: false });

    this.resizeObserver = new ResizeObserver(() => {
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    });
    this.resizeObserver.observe(canvas.parentElement!);

    this.initNavCube();
    this.animate();
  }

  private animate() {
    this.animFrameId = requestAnimationFrame(() => this.animate());
    this.controls.update();
    this.stepNavTween();
    this.renderer.render(this.scene, this.camera);
    this.renderNavCube();
  }

  // ── Navigation cube (Revit-style view-align gizmo) ───────────────────────────

  /** Small always-on-top gizmo: a labelled cube that mirrors the main camera's
   *  orientation; clicking a face snaps the main view to look straight at it. */
  private initNavCube() {
    const canvas = this.navCubeCanvasRef.nativeElement;
    const size = canvas.clientWidth || 84;

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

    this.navRenderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.navRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.navRenderer.setSize(size, size);

    this.boundNavMove  = (e) => this.onNavCubeMove(e);
    this.boundNavClick = (e) => this.onNavCubeClick(e);
    this.boundNavLeave = () => this.setNavHover(-1);
    canvas.addEventListener('mousemove', this.boundNavMove);
    canvas.addEventListener('click',     this.boundNavClick);
    canvas.addEventListener('mouseleave', this.boundNavLeave);
  }

  /** Builds one face's canvas-texture material; `hover` brightens it. */
  private makeNavFaceMaterial(label: string, hover: boolean): THREE.MeshBasicMaterial {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 256;
    const ctx = cv.getContext('2d')!;
    const fill = this.lightTheme ? (hover ? '#dbe4ee' : '#eef1f5') : (hover ? '#3a4048' : '#2b2f36');
    const border = this.lightTheme ? '#aab4c0' : '#4a5058';
    const text = this.lightTheme ? '#2a2f36' : '#e4e7eb';
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, 256, 256);
    ctx.strokeStyle = border;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, 246, 246);
    ctx.fillStyle = text;
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 128, 128);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
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
    this.renderMode = !this.renderMode;
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
    if (!this.renderFloor) {
      const geo = new THREE.PlaneGeometry(200000, 200000);
      geo.rotateX(-Math.PI / 2);
      this.renderFloor = new THREE.Mesh(
        geo, new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.95, metalness: 0 }),
      );
      this.renderFloor.position.y = -0.2;          // just under y=0 so slabs/walls aren't z-fought
      this.renderFloor.receiveShadow = true;
    }
    this.scene.add(this.renderFloor);
  }

  private exitRenderScene() {
    this.scene.environment = null;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.viewHelpers.forEach(h => h.visible = true);
    if (this.renderFloor) this.scene.remove(this.renderFloor);
  }

  // ── Visualisation menu / theme / camera settings ──────────────────────────────

  toggleVisMenu() { this.visMenuOpen = !this.visMenuOpen; }
  openSettings() { this.visMenuOpen = false; this.settingsDialogOpen = true; }
  closeSettings() { this.settingsDialogOpen = false; }

  /** Flip the UI between dark and light; the 3D background follows the theme too. */
  toggleTheme() { this.lightTheme = !this.lightTheme; this.applyViewportBackground(); this.rebuildNavCubeFaces(); }

  /** Camera brightness slider changed — re-apply the lighting multiplier live. */
  onBrightnessChange() { this.applyLighting(); }

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
      this.ambientLight.intensity = 0.12 * b;   // env does the soft lighting
      this.keyLight.intensity = 1.1 * b;
      this.fillLight.intensity = 0.3 * b;
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
      const boardDef = panelName
        ? this.materialDef(inst.materials?.[toKey(panelName)])
        : this.materialDef(inst.material);
      const kantDef = panelName
        ? this.materialDef(inst.materials?.[toKantKey(panelName)])
        : boardDef;

      const conv = (m: THREE.MeshPhongMaterial): THREE.MeshStandardMaterial => {
        const isBand = !!m.userData['edgeBand'];
        const def = isBand ? kantDef : boardDef;
        // A flat board face (no .map) may take the material's JPG texture; the chipboard
        // edge (which already has m.map) keeps its own look.
        const defTex = !m.map ? this.materialTexture(def) : null;
        const std = new THREE.MeshStandardMaterial({
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
          envMapIntensity: def ? 0.4 + def.reflection / 100 : 1,
        });
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
    // has the OrbitControls disabled, so you can look around between the two clicks.
    if (e.button === 1 && e.shiftKey && (this.mode === 'measure-from' || this.mode === 'measure-to')) {
      e.preventDefault();   // suppress the browser's middle-click autoscroll
      this.orbiting = true;
      this.orbitPrev = { x: e.clientX, y: e.clientY };
      return;
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

    if (this.mode === 'measure-to') {
      // Shift locks the segment parallel to an axis (0x / 0y / 0z) through the first point.
      if (e.shiftKey) {
        const pos = this.axisLockedMeasurePoint(e);
        if (!pos) return;
        this.showSnap(pos, 'axis');
        this.showMeasure(pos);
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
      const pos = e.shiftKey ? this.axisLockedMeasurePoint(e) : this.measureSnap(e)?.pos;
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
