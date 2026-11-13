/**
 * WebCAD — the family catalog (the registry of parametric object types).
 *
 * `FAMILIES` is the open/closed extension point: add a new object type by appending a
 * `FamilyDef` here (params + a `buildObject`) — no engine code changes. Families flagged
 * `hidden` are created by a dedicated toolbar tool (СТЕНА/ПЛОЧА) rather than the picker,
 * and build their geometry from `inst.path` via buildWallPath/buildSlabPath instead.
 */
import * as THREE from 'three';
import { FamilyDef, ParamDef, MaterialParamDef, PlaneDesc } from './webcad.model';
import { makeMesh, buildKorpus, buildDrawer, buildWallPath, buildSlabPath, buildLinePath, buildSolidExtrude, buildSpotLightFixture, buildLineLightFixture } from './webcad-geometry';

/** Fallback ground plane for the degenerate (path-less) Line/SOLID buildObject() below. */
const GROUND_PLANE: PlaneDesc = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 }, uAxis: { x: 1, y: 0, z: 0 } };

/**
 * Shared parameter list for the МОДУЛ family (carcass with a front door). С_ТАВАН and
 * С_РЕБРА are mutually exclusive (enforced by `setToggleParam` in
 * admin-page.component.ts): checking one unchecks the other — С_ТАВАН builds one full
 * ТАВАН panel, С_РЕБРА instead builds two narrow ribs (РЕБРО ТАВАН 1/2, their depth set
 * by РЕБРА_ШИРИНА). The door's top/bottom edges always follow the ВРАТИЧКА_ФУГА_ОТГОРЕ/
 * ОТДОЛУ reveal (offset by the ВРАТИЧКА_*_РЪБ_ОФСЕТ params), regardless of С_ТАВАН vs
 * С_РЕБРА. See korpusPanels (webcad-geometry.ts) for the full per-mode geometry rules.
 */
const KORPUS_PARAMS: ParamDef[] = [
  { key: 'ШИРИНА',             label: 'ШИРИНА',             defaultValue: 800, min: 37, step: 1, unit: 'mm' },
  { key: 'ВИСОЧИНА',           label: 'ВИСОЧИНА',           defaultValue: 720, min: 37, step: 1, unit: 'mm' },
  { key: 'ДЪЛБОЧИНА',          label: 'ДЪЛБОЧИНА',          defaultValue: 550, min: 19, step: 1, unit: 'mm' },
  { key: 'ПЛОСКОСТ_ДЕБЕЛИНА',  label: 'ПЛОСКОСТ ДЕБЕЛИНА',  defaultValue: 18,  min: 1,   step: 1,   unit: 'mm' },
  { key: 'ГРЪБ_ДЕБЕЛИНА',      label: 'ГРЪБ ДЕБЕЛИНА',      defaultValue: 18,  min: 1,   step: 1,   unit: 'mm' },
  { key: 'КАНТ_ДЕБЕЛИНА',      label: 'КАНТ ДЕБЕЛИНА',      defaultValue: 1,   min: 0.1, step: 0.1, unit: 'mm' },
  { key: 'РЕБРА_ШИРИНА',       label: 'РЕБРА ШИРИНА',       defaultValue: 100, min: 1,   step: 1,   unit: 'mm' },
  { key: 'С_ГРЪБ',           label: 'С ГРЪБ',           defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ЛЯВА_СТРАНИЦА',  label: 'С ЛЯВА СТРАНИЦА',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ДЯСНА_СТРАНИЦА', label: 'С ДЯСНА СТРАНИЦА', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ТАВАН',          label: 'С ТАВАН',          defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_РЕБРА',          label: 'С РЕБРА',          defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ДЪНО',           label: 'С ДЪНО',           defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ВРАТИЧКА',       label: 'С ВРАТИЧКА',       defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_ВИДИМ_КАНТ_ОТЛЯВО',  label: 'ГРЪБ ВИДИМ КАНТ ОТЛЯВО',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_ВИДИМ_КАНТ_ОТДЯСНО', label: 'ГРЪБ ВИДИМ КАНТ ОТДЯСНО', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_ВИДИМ_КАНТ_ОТГОРЕ',  label: 'ГРЪБ ВИДИМ КАНТ ОТГОРЕ',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_ВИДИМ_КАНТ_ОТДОЛУ',  label: 'ГРЪБ ВИДИМ КАНТ ОТДОЛУ',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_ВИДИМ_КАНТ_ОТЛЯВО',  label: 'ТАВАН ВИДИМ КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_ВИДИМ_КАНТ_ОТДЯСНО', label: 'ТАВАН ВИДИМ КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_ВИДИМ_КАНТ_ОТПРЕД',  label: 'ТАВАН ВИДИМ КАНТ ОТПРЕД',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  // With a full С_ТАВАН panel: negative pulls its FRONT edge inward (shrinking depth
  // by that many mm) while the back edge — against ГРЪБ, or the module's rear face —
  // stays put; positive extends it forward instead. With С_РЕБРА instead (mutually
  // exclusive with С_ТАВАН): slides the front rib (РЕБРО ТАВАН 1) along its depth axis
  // by that many mm — negative toward the back, positive toward the front — the back
  // rib is never affected. See korpusPanels (webcad-geometry.ts).
  { key: 'ТАВАН_ОФСЕТ_ОТПРЕД',       label: 'ТАВАН ОФСЕТ ОТПРЕД',       defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ДЪНО_ВИДИМ_КАНТ_ОТЛЯВО',  label: 'ДЪНО ВИДИМ КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_ВИДИМ_КАНТ_ОТДЯСНО', label: 'ДЪНО ВИДИМ КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_ВИДИМ_КАНТ_ОТПРЕД',  label: 'ДЪНО ВИДИМ КАНТ ОТПРЕД',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ВРАТИЧКА_ФУГА_ОТЛЯВО',  label: 'ВРАТИЧКА ФУГА ОТЛЯВО',  defaultValue: 1, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_ФУГА_ОТДЯСНО', label: 'ВРАТИЧКА ФУГА ОТДЯСНО', defaultValue: 1, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_ФУГА_ОТГОРЕ',  label: 'ВРАТИЧКА ФУГА ОТГОРЕ',  defaultValue: 0, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_ФУГА_ОТДОЛУ',  label: 'ВРАТИЧКА ФУГА ОТДОЛУ',  defaultValue: 0, min: 0, step: 0.5, unit: 'mm' },
  // Width of the reveal between the two ДВОЙНА_ВРАТИЧКА leaves — only matters (and is
  // only shown — see admin-page.component.ts paramRowVisible) once ДВОЙНА ВРАТИЧКА is
  // checked. See korpusPanels (webcad-geometry.ts).
  { key: 'ФУГА_МЕЖДУ_ВРАТИЧКИ', label: 'ФУГА МЕЖДУ ВРАТИЧКИ', defaultValue: 3, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_С_КАНТ_ОТГОРЕ', label: 'ВРАТИЧКА С КАНТ ОТГОРЕ', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ВРАТИЧКА_С_КАНТ_ОТДОЛУ', label: 'ВРАТИЧКА С КАНТ ОТДОЛУ', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ВРАТИЧКА_ГОРЕН_РЪБ_ОФСЕТ', label: 'ВРАТИЧКА ГОРЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ВРАТИЧКА_ДОЛЕН_РЪБ_ОФСЕТ', label: 'ВРАТИЧКА ДОЛЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  // Render mode only (see materialTexture/applyRenderMaterials, admin-page.component.ts):
  // rotates this panel's wood-grain texture 90° about its own centre, about the axis
  // perpendicular to the panel's own face — independent of the material's own global
  // ЗАВЪРТАНЕ НА ТЕКСТУРАТА (Materials dialog), which every panel using that material
  // shares. Both leaves of a ДВОЙНА_ВРАТИЧКА share this one toggle (same 'ВРАТИЧКА' name).
  { key: 'ВРАТИЧКА_ЗАВЪРТЯН_ФЛАДЕР', label: 'ВРАТИЧКА ЗАВЪРТЯН ФЛАДЕР', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  // Splits the single ВРАТИЧКА into two leaves (ЛЯВА/ДЯСНА), separated by a small fixed
  // reveal — ЛЯВА ВРАТИЧКА ШИРИНА only matters (and is only shown — see
  // admin-page.component.ts paramRowVisible) once ДВОЙНА ВРАТИЧКА is checked; the right
  // leaf always takes whatever width remains. See korpusPanels (webcad-geometry.ts).
  { key: 'ДВОЙНА_ВРАТИЧКА',       label: 'ДВОЙНА ВРАТИЧКА',       defaultValue: 0,   min: 0, step: 1,   unit: '',   type: 'toggle' },
  // true (default) = the two leaves sit side by side, divided by a VERTICAL fugue
  // (ЛЯВА/ДЯСНА, split along X — the original/only behaviour); false = they're stacked
  // one above the other instead, divided by a HORIZONTAL fugue (split along Y). Only
  // matters once ДВОЙНА ВРАТИЧКА is checked. See korpusPanels (webcad-geometry.ts).
  { key: 'ДВОЙНА_ВРАТИЧКА_С_ВЕРТИКАЛНА_ФУГА', label: 'ДВОЙНА ВРАТИЧКА С ВЕРТИКАЛНА ФУГА', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_ВРАТИЧКА_ШИРИНА',  label: 'ЛЯВА ВРАТИЧКА ШИРИНА',  defaultValue: 400, min: 1, step: 1,   unit: 'mm' },
  // Hinge prep marking for the Хосе/Мая shop exports (hingeInfo, webcad-schedule.ts) —
  // doesn't affect the 3D geometry at all, purely cut-list metadata. С ПАНТИ gates
  // whether a ВРАТИЧКА panel gets marked at all (off for e.g. push-to-open doors with no
  // visible hinges). БРОЙ ПАНТИ is the hinge count per panel — Хосе doesn't use it
  // directly (its К column just names a length/side), but Мая's own ПАНТИ column
  // aggregates it across merged panels ("2 по дълга", "4 по дълга", …).
  { key: 'ВРАТИЧКА_С_ПАНТИ',     label: 'ВРАТИЧКА С ПАНТИ',     defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ВРАТИЧКА_БРОЙ_ПАНТИ',  label: 'ВРАТИЧКА БРОЙ ПАНТИ',  defaultValue: 2, min: 1, step: 1, unit: '' },
  // Which side the hinge mounts on — only consulted at all when ДВОЙНА_ВРАТИЧКА is on (a
  // single door never names a side, see hingeInfo's own doc comment), and even then only
  // for a stacked (horizontal-fugue) pair, which has no inherent left/right of its own;
  // a side-by-side (vertical-fugue) pair's two leaves are instead forced by their own
  // position (set by korpusPanels as each leaf's `doorSide`), ignoring this entirely.
  { key: 'ВРАТИЧКА_ПАНТИ_ОТДЯСНО', label: 'ВРАТИЧКА ПАНТИ ОТДЯСНО', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_С_КАНТ_ОТПРЕД',  label: 'ТАВАН С КАНТ ОТПРЕД',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_С_КАНТ_ОТЛЯВО',  label: 'ТАВАН С КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_С_КАНТ_ОТДЯСНО', label: 'ТАВАН С КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'РЕБРО_ТАВАН_1_С_КАНТ_ОТПРЕД', label: 'РЕБРО ТАВАН 1 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'РЕБРО_ТАВАН_2_С_КАНТ_ОТПРЕД', label: 'РЕБРО ТАВАН 2 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  // Render mode only (see applyRenderMaterials, admin-page.component.ts): rotates this
  // panel's wood-grain texture 90° about its own centre (the axis perpendicular to its
  // own face) — applies to whichever top treatment is actually built (the full ТАВАН
  // panel, or both РЕБРО ТАВАН ribs when С_РЕБРА is active instead — see korpusPanels).
  { key: 'ТАВАН_ЗАВЪРТЯН_ФЛАДЕР', label: 'ТАВАН ЗАВЪРТЯН ФЛАДЕР', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_С_КАНТ_ОТПРЕД',   label: 'ДЪНО С КАНТ ОТПРЕД',   defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_С_КАНТ_ОТЛЯВО',   label: 'ДЪНО С КАНТ ОТЛЯВО',   defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_С_КАНТ_ОТДЯСНО',  label: 'ДЪНО С КАНТ ОТДЯСНО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  // Render mode only: same per-panel 90° grain rotation as ТАВАН/ЛЯВА СТРАНИЦА/etc above.
  { key: 'ДЪНО_ЗАВЪРТЯН_ФЛАДЕР', label: 'ДЪНО ЗАВЪРТЯН ФЛАДЕР', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_С_КАНТ_ОТПРЕД',  label: 'ЛЯВА СТРАНИЦА С КАНТ ОТПРЕД',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_С_КАНТ_ОТГОРЕ',  label: 'ЛЯВА СТРАНИЦА С КАНТ ОТГОРЕ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_С_КАНТ_ОТДОЛУ',  label: 'ЛЯВА СТРАНИЦА С КАНТ ОТДОЛУ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД', label: 'ЛЯВА СТРАНИЦА ВИДИМ КАНТ ОТПРЕД', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_ГОРЕН_РЪБ_ОФСЕТ', label: 'ЛЯВА СТРАНИЦА ГОРЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ЛЯВА_СТРАНИЦА_ДОЛЕН_РЪБ_ОФСЕТ', label: 'ЛЯВА СТРАНИЦА ДОЛЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  // Render mode only: same per-panel 90° grain rotation as ТАВАН/ДЪНО/etc above.
  { key: 'ЛЯВА_СТРАНИЦА_ЗАВЪРТЯН_ФЛАДЕР', label: 'ЛЯВА СТРАНИЦА ЗАВЪРТЯН ФЛАДЕР', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_С_КАНТ_ОТПРЕД', label: 'ДЯСНА СТРАНИЦА С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_С_КАНТ_ОТГОРЕ', label: 'ДЯСНА СТРАНИЦА С КАНТ ОТГОРЕ', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_С_КАНТ_ОТДОЛУ', label: 'ДЯСНА СТРАНИЦА С КАНТ ОТДОЛУ', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД', label: 'ДЯСНА СТРАНИЦА ВИДИМ КАНТ ОТПРЕД', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_ГОРЕН_РЪБ_ОФСЕТ', label: 'ДЯСНА СТРАНИЦА ГОРЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ДЯСНА_СТРАНИЦА_ДОЛЕН_РЪБ_ОФСЕТ', label: 'ДЯСНА СТРАНИЦА ДОЛЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  // Render mode only: same per-panel 90° grain rotation as ТАВАН/ДЪНО/etc above.
  { key: 'ДЯСНА_СТРАНИЦА_ЗАВЪРТЯН_ФЛАДЕР', label: 'ДЯСНА СТРАНИЦА ЗАВЪРТЯН ФЛАДЕР', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТГОРЕ',  label: 'ГРЪБ С КАНТ ОТГОРЕ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТДОЛУ',  label: 'ГРЪБ С КАНТ ОТДОЛУ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТЛЯВО',  label: 'ГРЪБ С КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТДЯСНО', label: 'ГРЪБ С КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  // Splits the single ГРЪБ into two leaves, ALWAYS touching with zero gap (unlike
  // ДВОЙНА_ВРАТИЧКА's configurable reveal — see korpusPanels, webcad-geometry.ts) —
  // ВИСОЧИНА_ГОРЕН_ГРЪБ/ШИРИНА_ЛЯВ_ГРЪБ only matter (and are only shown — see
  // admin-page.component.ts paramRowVisible) once ДВОЕН ГРЪБ is checked.
  { key: 'ДВОЕН_ГРЪБ', label: 'ДВОЕН ГРЪБ', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  // true (default) = stacked one above the other, divided by a HORIZONTAL fugue (split
  // along Y — opposite default from ДВОЙНА_ВРАТИЧКА_С_ВЕРТИКАЛНА_ФУГА); false = side by
  // side, divided by a VERTICAL fugue (split along X).
  { key: 'ГРЪБ_С_ХОРИЗОНТАЛНА_ФУГА', label: 'ГРЪБ С ХОРИЗОНТАЛНА ФУГА', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ВИСОЧИНА_ГОРЕН_ГРЪБ', label: 'ВИСОЧИНА ГОРЕН ГРЪБ', defaultValue: 360, min: 1, step: 1, unit: 'mm' },
  { key: 'ШИРИНА_ЛЯВ_ГРЪБ',     label: 'ШИРИНА ЛЯВ ГРЪБ',     defaultValue: 400, min: 1, step: 1, unit: 'mm' },
  // Render mode only: same per-panel 90° grain rotation as ТАВАН/ДЪНО/etc above. Both
  // leaves of a ДВОЕН_ГРЪБ share this one toggle (same 'ГРЪБ' name).
  { key: 'ГРЪБ_ЗАВЪРТЯН_ФЛАДЕР', label: 'ГРЪБ ЗАВЪРТЯН ФЛАДЕР', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  // ПОЛИЦИ: up to 10 independent shelf panels, each toggled on/off and positioned by
  // its own ОФСЕТ ОТДОЛУ (mm from the module's nominal bottom to the shelf's own
  // bottom/finished edge); С КАНТ ОТПРЕД bands its front edge. See korpusPanels
  // (webcad-geometry.ts). Materials (default ГЛАДКО БЯЛО) live in KORPUS_MATERIAL_PARAMS
  // below, each shown only while its shelf's toggle is checked (admin-page.component.html).
  { key: 'С_ПОЛИЦА_1',  label: 'С ПОЛИЦА 1',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_1_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 1 ОФСЕТ ОТДОЛУ',  defaultValue: 100,  min: -1000, step: 1, unit: 'mm' },
  // Same semantics as ТАВАН_ОФСЕТ_ОТПРЕД (frontD/frontZ, korpusPanels): negative pulls
  // the shelf's front edge inward (shrinking its depth), positive extends it forward
  // past the door's rear face.
  { key: 'ПОЛИЦА_1_ОФСЕТ_ОТПРЕД',  label: 'ПОЛИЦА 1 ОФСЕТ ОТПРЕД',  defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_1_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 1 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_2',  label: 'С ПОЛИЦА 2',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_2_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 2 ОФСЕТ ОТДОЛУ',  defaultValue: 200,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_2_ОФСЕТ_ОТПРЕД',  label: 'ПОЛИЦА 2 ОФСЕТ ОТПРЕД',  defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_2_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 2 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_3',  label: 'С ПОЛИЦА 3',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_3_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 3 ОФСЕТ ОТДОЛУ',  defaultValue: 300,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_3_ОФСЕТ_ОТПРЕД',  label: 'ПОЛИЦА 3 ОФСЕТ ОТПРЕД',  defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_3_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 3 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_4',  label: 'С ПОЛИЦА 4',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_4_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 4 ОФСЕТ ОТДОЛУ',  defaultValue: 400,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_4_ОФСЕТ_ОТПРЕД',  label: 'ПОЛИЦА 4 ОФСЕТ ОТПРЕД',  defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_4_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 4 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_5',  label: 'С ПОЛИЦА 5',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_5_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 5 ОФСЕТ ОТДОЛУ',  defaultValue: 500,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_5_ОФСЕТ_ОТПРЕД',  label: 'ПОЛИЦА 5 ОФСЕТ ОТПРЕД',  defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_5_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 5 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_6',  label: 'С ПОЛИЦА 6',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_6_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 6 ОФСЕТ ОТДОЛУ',  defaultValue: 600,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_6_ОФСЕТ_ОТПРЕД',  label: 'ПОЛИЦА 6 ОФСЕТ ОТПРЕД',  defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_6_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 6 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_7',  label: 'С ПОЛИЦА 7',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_7_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 7 ОФСЕТ ОТДОЛУ',  defaultValue: 700,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_7_ОФСЕТ_ОТПРЕД',  label: 'ПОЛИЦА 7 ОФСЕТ ОТПРЕД',  defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_7_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 7 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_8',  label: 'С ПОЛИЦА 8',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_8_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 8 ОФСЕТ ОТДОЛУ',  defaultValue: 800,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_8_ОФСЕТ_ОТПРЕД',  label: 'ПОЛИЦА 8 ОФСЕТ ОТПРЕД',  defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_8_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 8 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_9',  label: 'С ПОЛИЦА 9',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_9_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 9 ОФСЕТ ОТДОЛУ',  defaultValue: 900,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_9_ОФСЕТ_ОТПРЕД',  label: 'ПОЛИЦА 9 ОФСЕТ ОТПРЕД',  defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_9_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 9 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_10', label: 'С ПОЛИЦА 10', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_10_ОФСЕТ_ОТДОЛУ', label: 'ПОЛИЦА 10 ОФСЕТ ОТДОЛУ', defaultValue: 1000, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_10_ОФСЕТ_ОТПРЕД', label: 'ПОЛИЦА 10 ОФСЕТ ОТПРЕД', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_10_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 10 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
];

/** МАТЕРИАЛИ: board + edge-band material per panel of a МОДУЛ. Defaults to ГЛАДКО БЯЛО.
 *  Carries both the ТАВАН-panel and РЕБРО-ТАВАН picks — only whichever mode is active
 *  (С_ТАВАН vs С_РЕБРА) ever actually renders. */
const KORPUS_MATERIAL_PARAMS: MaterialParamDef[] = [
  { key: 'ЛЯВА_СТРАНИЦА_МАТЕРИАЛ',       label: 'ЛЯВА СТРАНИЦА МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ЛЯВА_СТРАНИЦА_КАНТ_МАТЕРИАЛ',  label: 'ЛЯВА СТРАНИЦА КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ДЯСНА_СТРАНИЦА_МАТЕРИАЛ',      label: 'ДЯСНА СТРАНИЦА МАТЕРИАЛ',      default: 'gladko-byalo' },
  { key: 'ДЯСНА_СТРАНИЦА_КАНТ_МАТЕРИАЛ', label: 'ДЯСНА СТРАНИЦА КАНТ МАТЕРИАЛ', default: 'gladko-byalo' },
  { key: 'ТАВАН_МАТЕРИАЛ',              label: 'ТАВАН МАТЕРИАЛ',              default: 'gladko-byalo' },
  { key: 'ТАВАН_КАНТ_МАТЕРИАЛ',         label: 'ТАВАН КАНТ МАТЕРИАЛ',         default: 'gladko-byalo' },
  { key: 'РЕБРО_ТАВАН_1_МАТЕРИАЛ',      label: 'РЕБРО ТАВАН 1 МАТЕРИАЛ',      default: 'gladko-byalo' },
  { key: 'РЕБРО_ТАВАН_1_КАНТ_МАТЕРИАЛ', label: 'РЕБРО ТАВАН 1 КАНТ МАТЕРИАЛ', default: 'gladko-byalo' },
  { key: 'РЕБРО_ТАВАН_2_МАТЕРИАЛ',      label: 'РЕБРО ТАВАН 2 МАТЕРИАЛ',      default: 'gladko-byalo' },
  { key: 'РЕБРО_ТАВАН_2_КАНТ_МАТЕРИАЛ', label: 'РЕБРО ТАВАН 2 КАНТ МАТЕРИАЛ', default: 'gladko-byalo' },
  { key: 'ДЪНО_МАТЕРИАЛ',               label: 'ДЪНО МАТЕРИАЛ',               default: 'gladko-byalo' },
  { key: 'ДЪНО_КАНТ_МАТЕРИАЛ',          label: 'ДЪНО КАНТ МАТЕРИАЛ',          default: 'gladko-byalo' },
  { key: 'ГРЪБ_МАТЕРИАЛ',               label: 'ГРЪБ МАТЕРИАЛ',               default: 'gladko-byalo' },
  { key: 'ГРЪБ_КАНТ_МАТЕРИАЛ',          label: 'ГРЪБ КАНТ МАТЕРИАЛ',          default: 'gladko-byalo' },
  { key: 'ВРАТИЧКА_МАТЕРИАЛ',           label: 'ВРАТИЧКА МАТЕРИАЛ',           default: 'gladko-byalo' },
  { key: 'ВРАТИЧКА_КАНТ_МАТЕРИАЛ',      label: 'ВРАТИЧКА КАНТ МАТЕРИАЛ',      default: 'gladko-byalo' },
  // ПОЛИЦА 1..10: each pair only shown (admin-page.component.html) while that shelf's
  // own С_ПОЛИЦА_n toggle is checked.
  { key: 'ПОЛИЦА_1_МАТЕРИАЛ',       label: 'ПОЛИЦА 1 МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_1_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 1 КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_2_МАТЕРИАЛ',       label: 'ПОЛИЦА 2 МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_2_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 2 КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_3_МАТЕРИАЛ',       label: 'ПОЛИЦА 3 МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_3_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 3 КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_4_МАТЕРИАЛ',       label: 'ПОЛИЦА 4 МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_4_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 4 КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_5_МАТЕРИАЛ',       label: 'ПОЛИЦА 5 МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_5_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 5 КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_6_МАТЕРИАЛ',       label: 'ПОЛИЦА 6 МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_6_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 6 КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_7_МАТЕРИАЛ',       label: 'ПОЛИЦА 7 МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_7_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 7 КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_8_МАТЕРИАЛ',       label: 'ПОЛИЦА 8 МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_8_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 8 КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_9_МАТЕРИАЛ',       label: 'ПОЛИЦА 9 МАТЕРИАЛ',       default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_9_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 9 КАНТ МАТЕРИАЛ',  default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_10_МАТЕРИАЛ',      label: 'ПОЛИЦА 10 МАТЕРИАЛ',      default: 'gladko-byalo' },
  { key: 'ПОЛИЦА_10_КАНТ_МАТЕРИАЛ', label: 'ПОЛИЦА 10 КАНТ МАТЕРИАЛ', default: 'gladko-byalo' },
];

/**
 * ЧЕКМЕДЖЕ (drawer box): six fixed ПЛОСКОСТ panels, no С_* toggles — see drawerPanels
 * (webcad-geometry.ts) for the layout. ВРАТИЧКА_ОФСЕТ_ОТГОРЕ/ОТДОЛУ default to a
 * symmetric 20 mm overlay (ЧЕЛО extends 20 mm past the box's own top AND bottom),
 * same sign convention as the МОДУЛ family's ВРАТИЧКА_*_РЪБ_ОФСЕТ (positive moves an
 * edge up).
 */
const DRAWER_PARAMS: ParamDef[] = [
  { key: 'ШИРИНА_ЧЕКМЕДЖЕ',    label: 'ШИРИНА ЧЕКМЕДЖЕ',    defaultValue: 400, min: 37, step: 1, unit: 'mm' },
  { key: 'ВИСОЧИНА_ЧЕКМЕДЖЕ',  label: 'ВИСОЧИНА ЧЕКМЕДЖЕ',  defaultValue: 150, min: 37, step: 1, unit: 'mm' },
  { key: 'ДЪЛБОЧИНА_ЧЕКМЕДЖЕ', label: 'ДЪЛБОЧИНА ЧЕКМЕДЖЕ', defaultValue: 450, min: 37, step: 1, unit: 'mm' },
  { key: 'ПЛОСКОСТ_ДЕБЕЛИНА',  label: 'ПЛОСКОСТ ДЕБЕЛИНА',  defaultValue: 16,  min: 1,   step: 1,   unit: 'mm' },
  { key: 'КАНТ_ДЕБЕЛИНА',      label: 'КАНТ ДЕБЕЛИНА',      defaultValue: 1,   min: 0.1, step: 0.1, unit: 'mm' },
  { key: 'ВРАТИЧКА_ОФСЕТ_ОТГОРЕ', label: 'ВРАТИЧКА ОФСЕТ ОТГОРЕ', defaultValue: 20,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ВРАТИЧКА_ОФСЕТ_ОТДОЛУ', label: 'ВРАТИЧКА ОФСЕТ ОТДОЛУ', defaultValue: -20, min: -1000, step: 1, unit: 'mm' },
];

/** МАТЕРИАЛИ for ЧЕКМЕДЖЕ: one shared pick for every structural/corpus panel (ДЪНО,
 *  ЛЯВА/ДЯСНА СТРАНИЦА, ГРЪБ, КОНСТРУКТИВНО ЧЕЛО) and a separate one for the visible
 *  ЧЕЛО face — see panelMaterialGroup (webcad-geometry.ts), which groups those five
 *  structural panel names onto the КОРПУС_* keys below. */
const DRAWER_MATERIAL_PARAMS: MaterialParamDef[] = [
  { key: 'КОРПУС_МАТЕРИАЛ',      label: 'МАТЕРИАЛ КОРПУС',      default: 'gladko-byalo' },
  { key: 'КОРПУС_КАНТ_МАТЕРИАЛ', label: 'МАТЕРИАЛ КОРПУС КАНТ', default: 'gladko-byalo' },
  { key: 'ЧЕЛО_МАТЕРИАЛ',        label: 'ЧЕЛО',                 default: 'gladko-byalo' },
  { key: 'ЧЕЛО_КАНТ_МАТЕРИАЛ',   label: 'ЧЕЛО КАНТ',            default: 'gladko-byalo' },
];

export const FAMILIES: FamilyDef[] = [
  // ── Ploskost (a single board with optional PVC edge bands) ──────────────────
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
      // Tilts the panel about the horizontal axis that lies IN its own face (i.e.
      // perpendicular to world Y) and runs through its centre — think of it hinging
      // forward/back, as opposed to rotY which spins it about the vertical world axis.
      { key: 'tilt', label: 'НАКЛОН', defaultValue: 0, min: -180, max: 180, step: 1, unit: '°', type: 'slider' },
    ],
    materialParams: [
      { key: 'МАТЕРИАЛ',      label: 'МАТЕРИАЛ',      default: 'gladko-byalo' },
      { key: 'МАТЕРИАЛ_КАНТ', label: 'МАТЕРИАЛ КАНТ', default: 'gladko-byalo' },
    ],
    buildObject(p) {
      const obj = makeMesh(
        p['AB'], p['BC'], p['angle'] ?? 90, p['thickness'],
        [Boolean(p['pvcAB']), Boolean(p['pvcBC']), Boolean(p['pvcCD']), Boolean(p['pvcDA'])],
        p['kantThickness'] ?? 1,
      );
      const tilt = p['tilt'] ?? 0;
      if (tilt) obj.rotateX(tilt * Math.PI / 180);
      return obj;
    },
  },

  // ── МОДУЛ (carcass with a front door — either a full ТАВАН panel or two РЕБРА ribs,
  // mutually exclusive via С_ТАВАН/С_РЕБРА; see KORPUS_PARAMS and korpusPanels) ──────
  {
    id: 'module',
    name: 'МОДУЛ',
    params: KORPUS_PARAMS,
    materialParams: KORPUS_MATERIAL_PARAMS,
    buildObject(p) { return buildKorpus(p, true); },
  },

  // ── ЧЕКМЕДЖЕ (drawer box) — six fixed ПЛОСКОСТ panels (ДЪНО, ЛЯВА/ДЯСНА СТРАНИЦА,
  // ГРЪБ, КОНСТРУКТИВНО ЧЕЛО, ЧЕЛО), no С_* toggles; see DRAWER_PARAMS and drawerPanels. ──
  {
    id: 'drawer',
    name: 'ЧЕКМЕДЖЕ',
    params: DRAWER_PARAMS,
    materialParams: DRAWER_MATERIAL_PARAMS,
    buildObject(p) { return buildDrawer(p); },
  },

  // ── СПОТ (spot light) — a real local light for Render mode (see buildSpotLightFixture's
  // own doc comment, webcad-geometry.ts): fills in the specular highlights/falloff
  // gradients a single sampled "sun" direction can't. Invisible to CAD-mode shading
  // (toggled off there by admin-page.component.ts — CAD's flat tinting still responds to
  // scene lights, unlike Render's PBR swap). Horizontal aim reuses the instance's own
  // rotY like every other family; НАКЛОН tilts the beam from straight down. СЯНКА is
  // real cost, not just a look — each shadow-casting light adds its own shadow-map
  // render pass to every accumulated Render-mode sample, so leave it off on fixtures
  // where a hard shadow doesn't matter.
  {
    id: 'spot-light',
    name: 'СПОТ',
    params: [
      { key: 'ИНТЕНЗИТЕТ',           label: 'ИНТЕНЗИТЕТ',           defaultValue: 400,  min: 0, step: 10, unit: '' },
      { key: 'ЪГЪЛ',                 label: 'ЪГЪЛ',                 defaultValue: 30,   min: 5, max: 80, step: 1, unit: '°', type: 'slider' },
      { key: 'ЗАТИХВАНЕ',            label: 'ЗАТИХВАНЕ',            defaultValue: 0.3,  min: 0, max: 1, step: 0.05, unit: '', type: 'slider' },
      { key: 'ОБХВАТ',               label: 'ОБХВАТ',               defaultValue: 0,    min: 0, step: 100, unit: 'mm' },   // 0 = no distance falloff cutoff
      { key: 'ЦВЕТНА_ТЕМПЕРАТУРА',   label: 'ЦВЕТНА ТЕМПЕРАТУРА',   defaultValue: 3000, min: 2000, max: 10000, step: 100, unit: 'K', type: 'slider' },
      { key: 'НАКЛОН',               label: 'НАКЛОН',               defaultValue: 0,    min: -89, max: 89, step: 1, unit: '°', type: 'slider' },
      { key: 'СЯНКА',                label: 'СЯНКА',                defaultValue: 1,    min: 0, step: 1, unit: '', type: 'toggle' },
    ],
    buildObject(p) { return buildSpotLightFixture(p); },
  },

  // ── ЛЕД ЛЕНТА (LED strip / line light) — a configurable-length area light for Render
  // mode. No СЯНКА toggle: THREE.RectAreaLight has no shadow support at all (a Three.js
  // limitation, not a setting), so a line light only ever softens/fills, never casts a
  // hard shadow of its own.
  {
    id: 'line-light',
    name: 'ЛЕД ЛЕНТА',
    params: [
      { key: 'ДЪЛЖИНА',              label: 'ДЪЛЖИНА',              defaultValue: 600,  min: 50, step: 10, unit: 'mm' },
      { key: 'ШИРИНА',               label: 'ШИРИНА',               defaultValue: 15,   min: 5,  step: 1, unit: 'mm' },
      { key: 'ИНТЕНЗИТЕТ',           label: 'ИНТЕНЗИТЕТ',           defaultValue: 1500, min: 0,  step: 50, unit: '' },
      { key: 'ЦВЕТНА_ТЕМПЕРАТУРА',   label: 'ЦВЕТНА ТЕМПЕРАТУРА',   defaultValue: 4000, min: 2000, max: 10000, step: 100, unit: 'K', type: 'slider' },
      { key: 'НАКЛОН',               label: 'НАКЛОН',               defaultValue: 0,    min: -89, max: 89, step: 1, unit: '°', type: 'slider' },
    ],
    buildObject(p) { return buildLineLightFixture(p); },
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
    // A wall has no panels for cadColorObj/applyRenderMaterials to tag by name (unlike
    // ПЛОСКОСТ/МОДУЛ's per-panel picks) — a single library pick under this exact key is
    // its own panel-less lookup, same as SOLID's identical entry below.
    materialParams: [
      { key: 'МАТЕРИАЛ', label: 'МАТЕРИАЛ', default: 'gladko-byalo' },
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
    // Same panel-less single pick as СТЕНА just above.
    materialParams: [
      { key: 'МАТЕРИАЛ', label: 'МАТЕРИАЛ', default: 'gladko-byalo' },
    ],
    // Degenerate fallback (path-less slab): a 600×600 square. Real slabs go through buildSlabPath.
    buildObject(p) { return buildSlabPath([{ x: 0, z: 0 }, { x: 600, z: 0 }, { x: 600, z: 600 }, { x: 0, z: 600 }], p['ДЕБЕЛИНА']); },
  },

  // ── Line — a generic polyline sketch drawn on an ARBITRARY construction plane
  // (`inst.plane`), picked by hovering any existing surface (or a quick XZ/XY/YZ pick)
  // when the Line toolbar tool starts. No numeric params of its own — geometry is
  // fully path/plane/fillet driven, built by buildLinePath (not buildObject). A
  // closed Line can be turned into a SOLID via the "Extrude" button when selected.
  {
    id: 'line',
    name: 'Line',
    hidden: true,
    params: [],
    // Degenerate fallback (path-less line): a single 1 m segment on the ground.
    buildObject() { return buildLinePath([{ x: 0, z: 0 }, { x: 1000, z: 0 }], false, GROUND_PLANE); },
  },

  // ── SOLID — the generic result of extruding a closed Line (see `extrudeLine` in
  // admin-page.component.ts). Self-contained: its own copy of the source Line's
  // path/plane, independent of it from then on (no live re-link back to the sketch).
  // Labeled sequentially ("SOLID 1", "SOLID 2", …) rather than per-family, since any
  // number of different sketches can produce one. Hidden — only ever created by
  // Extrude, never the FAMILY picker.
  {
    id: 'solid',
    name: 'SOLID',
    hidden: true,
    params: [
      { key: 'ДЪЛБОЧИНА', label: 'ДЪЛБОЧИНА', defaultValue: 18, min: 1, step: 1, unit: 'mm' },
    ],
    // A SOLID has no panels for `cadColorObj`/`applyRenderMaterials` to tag by name
    // (unlike ПЛОСКОСТ/МОДУЛ's per-panel picks) — a single library pick under this
    // exact key is already their own panel-less fallback lookup
    // (`inst.materials?.['МАТЕРИАЛ'] ?? inst.material`), so this is the only entry
    // needed to make a SOLID's own "МАТЕРИАЛИ" section appear and actually take effect.
    materialParams: [
      { key: 'МАТЕРИАЛ', label: 'МАТЕРИАЛ', default: 'gladko-byalo' },
    ],
    // Degenerate fallback (path-less solid): a small square on the ground.
    buildObject(p) { return buildSolidExtrude([{ x: 0, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 300 }, { x: 0, z: 300 }], p['ДЪЛБОЧИНА'], GROUND_PLANE); },
  },

  // ── FBX import — a single instance wrapping an imported .fbx file's whole scene
  // graph, labelled after the imported filename. Its real geometry is parsed fresh
  // from `inst.fbxData` on every spawn (see parseFbxDataUrl, webcad-fbx.ts), not built
  // from `params` like every other family here — `buildObject` below is purely the
  // degenerate fallback for a corrupt/missing fbxData. Hidden — only ever created by
  // the File menu's "Import FBX…", never the FAMILY picker.
  {
    id: 'fbx-import',
    name: 'FBX',
    hidden: true,
    params: [],
    buildObject() { return new THREE.Group(); },
  },
];
