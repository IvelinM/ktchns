/**
 * WebCAD — the family catalog (the registry of parametric object types).
 *
 * `FAMILIES` is the open/closed extension point: add a new object type by appending a
 * `FamilyDef` here (params + a `buildObject`) — no engine code changes. Families flagged
 * `hidden` are created by a dedicated toolbar tool (СТЕНА/ПЛОЧА) rather than the picker,
 * and build their geometry from `inst.path` via buildWallPath/buildSlabPath instead.
 */
import { FamilyDef, ParamDef, MaterialParamDef } from './webcad.model';
import { makeMesh, buildKorpus, buildWallPath, buildSlabPath } from './webcad-geometry';

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
  { key: 'ДЪНО_ВИДИМ_КАНТ_ОТЛЯВО',  label: 'ДЪНО ВИДИМ КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_ВИДИМ_КАНТ_ОТДЯСНО', label: 'ДЪНО ВИДИМ КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_ВИДИМ_КАНТ_ОТПРЕД',  label: 'ДЪНО ВИДИМ КАНТ ОТПРЕД',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ВРАТИЧКА_ФУГА_ОТЛЯВО',  label: 'ВРАТИЧКА ФУГА ОТЛЯВО',  defaultValue: 1, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_ФУГА_ОТДЯСНО', label: 'ВРАТИЧКА ФУГА ОТДЯСНО', defaultValue: 1, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_ФУГА_ОТГОРЕ',  label: 'ВРАТИЧКА ФУГА ОТГОРЕ',  defaultValue: 0, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_ФУГА_ОТДОЛУ',  label: 'ВРАТИЧКА ФУГА ОТДОЛУ',  defaultValue: 0, min: 0, step: 0.5, unit: 'mm' },
  { key: 'ВРАТИЧКА_С_КАНТ_ОТГОРЕ', label: 'ВРАТИЧКА С КАНТ ОТГОРЕ', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ВРАТИЧКА_С_КАНТ_ОТДОЛУ', label: 'ВРАТИЧКА С КАНТ ОТДОЛУ', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ВРАТИЧКА_ГОРЕН_РЪБ_ОФСЕТ', label: 'ВРАТИЧКА ГОРЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ВРАТИЧКА_ДОЛЕН_РЪБ_ОФСЕТ', label: 'ВРАТИЧКА ДОЛЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ТАВАН_С_КАНТ_ОТПРЕД',  label: 'ТАВАН С КАНТ ОТПРЕД',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_С_КАНТ_ОТЛЯВО',  label: 'ТАВАН С КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ТАВАН_С_КАНТ_ОТДЯСНО', label: 'ТАВАН С КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'РЕБРО_ТАВАН_1_С_КАНТ_ОТПРЕД', label: 'РЕБРО ТАВАН 1 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'РЕБРО_ТАВАН_2_С_КАНТ_ОТПРЕД', label: 'РЕБРО ТАВАН 2 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_С_КАНТ_ОТПРЕД',   label: 'ДЪНО С КАНТ ОТПРЕД',   defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_С_КАНТ_ОТЛЯВО',   label: 'ДЪНО С КАНТ ОТЛЯВО',   defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЪНО_С_КАНТ_ОТДЯСНО',  label: 'ДЪНО С КАНТ ОТДЯСНО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_С_КАНТ_ОТПРЕД',  label: 'ЛЯВА СТРАНИЦА С КАНТ ОТПРЕД',  defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_С_КАНТ_ОТГОРЕ',  label: 'ЛЯВА СТРАНИЦА С КАНТ ОТГОРЕ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_С_КАНТ_ОТДОЛУ',  label: 'ЛЯВА СТРАНИЦА С КАНТ ОТДОЛУ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД', label: 'ЛЯВА СТРАНИЦА ВИДИМ КАНТ ОТПРЕД', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ЛЯВА_СТРАНИЦА_ГОРЕН_РЪБ_ОФСЕТ', label: 'ЛЯВА СТРАНИЦА ГОРЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ЛЯВА_СТРАНИЦА_ДОЛЕН_РЪБ_ОФСЕТ', label: 'ЛЯВА СТРАНИЦА ДОЛЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ДЯСНА_СТРАНИЦА_С_КАНТ_ОТПРЕД', label: 'ДЯСНА СТРАНИЦА С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_С_КАНТ_ОТГОРЕ', label: 'ДЯСНА СТРАНИЦА С КАНТ ОТГОРЕ', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_С_КАНТ_ОТДОЛУ', label: 'ДЯСНА СТРАНИЦА С КАНТ ОТДОЛУ', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_ВИДИМ_КАНТ_ОТПРЕД', label: 'ДЯСНА СТРАНИЦА ВИДИМ КАНТ ОТПРЕД', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ДЯСНА_СТРАНИЦА_ГОРЕН_РЪБ_ОФСЕТ', label: 'ДЯСНА СТРАНИЦА ГОРЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ДЯСНА_СТРАНИЦА_ДОЛЕН_РЪБ_ОФСЕТ', label: 'ДЯСНА СТРАНИЦА ДОЛЕН РЪБ ОФСЕТ', defaultValue: 0, min: -1000, step: 1, unit: 'mm' },
  { key: 'ГРЪБ_С_КАНТ_ОТГОРЕ',  label: 'ГРЪБ С КАНТ ОТГОРЕ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТДОЛУ',  label: 'ГРЪБ С КАНТ ОТДОЛУ',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТЛЯВО',  label: 'ГРЪБ С КАНТ ОТЛЯВО',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ГРЪБ_С_КАНТ_ОТДЯСНО', label: 'ГРЪБ С КАНТ ОТДЯСНО', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  // ПОЛИЦИ: up to 10 independent shelf panels, each toggled on/off and positioned by
  // its own ОФСЕТ ОТДОЛУ (mm from the module's nominal bottom to the shelf's own
  // bottom/finished edge); С КАНТ ОТПРЕД bands its front edge. See korpusPanels
  // (webcad-geometry.ts). Materials (default ГЛАДКО БЯЛО) live in KORPUS_MATERIAL_PARAMS
  // below, each shown only while its shelf's toggle is checked (admin-page.component.html).
  { key: 'С_ПОЛИЦА_1',  label: 'С ПОЛИЦА 1',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_1_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 1 ОФСЕТ ОТДОЛУ',  defaultValue: 100,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_1_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 1 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_2',  label: 'С ПОЛИЦА 2',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_2_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 2 ОФСЕТ ОТДОЛУ',  defaultValue: 200,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_2_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 2 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_3',  label: 'С ПОЛИЦА 3',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_3_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 3 ОФСЕТ ОТДОЛУ',  defaultValue: 300,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_3_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 3 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_4',  label: 'С ПОЛИЦА 4',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_4_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 4 ОФСЕТ ОТДОЛУ',  defaultValue: 400,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_4_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 4 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_5',  label: 'С ПОЛИЦА 5',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_5_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 5 ОФСЕТ ОТДОЛУ',  defaultValue: 500,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_5_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 5 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_6',  label: 'С ПОЛИЦА 6',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_6_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 6 ОФСЕТ ОТДОЛУ',  defaultValue: 600,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_6_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 6 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_7',  label: 'С ПОЛИЦА 7',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_7_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 7 ОФСЕТ ОТДОЛУ',  defaultValue: 700,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_7_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 7 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_8',  label: 'С ПОЛИЦА 8',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_8_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 8 ОФСЕТ ОТДОЛУ',  defaultValue: 800,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_8_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 8 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_9',  label: 'С ПОЛИЦА 9',  defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_9_ОФСЕТ_ОТДОЛУ',  label: 'ПОЛИЦА 9 ОФСЕТ ОТДОЛУ',  defaultValue: 900,  min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_9_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 9 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'С_ПОЛИЦА_10', label: 'С ПОЛИЦА 10', defaultValue: 0, min: 0, step: 1, unit: '', type: 'toggle' },
  { key: 'ПОЛИЦА_10_ОФСЕТ_ОТДОЛУ', label: 'ПОЛИЦА 10 ОФСЕТ ОТДОЛУ', defaultValue: 1000, min: -1000, step: 1, unit: 'mm' },
  { key: 'ПОЛИЦА_10_С_КАНТ_ОТПРЕД', label: 'ПОЛИЦА 10 С КАНТ ОТПРЕД', defaultValue: 1, min: 0, step: 1, unit: '', type: 'toggle' },
];

/** МАТЕРИАЛИ: board + edge-band material per panel of a МОДУЛ. Defaults to ГЛАДКО БЯЛО.
 *  Carries both the ТАВАН-panel and РЕБРО-ТАВАН picks — only whichever mode is active
 *  (С_ТАВАН vs С_РЕБРА) ever actually renders. */
const KORPUS_MATERIAL_PARAMS: MaterialParamDef[] = [
  { key: 'ЛЯВА_СТРАНИЦА_МАТЕРИАЛ',       label: 'ЛЯВА СТРАНИЦА МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ЛЯВА_СТРАНИЦА_КАНТ_МАТЕРИАЛ',  label: 'ЛЯВА СТРАНИЦА КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ДЯСНА_СТРАНИЦА_МАТЕРИАЛ',      label: 'ДЯСНА СТРАНИЦА МАТЕРИАЛ',      default: 'ГЛАДКО БЯЛО' },
  { key: 'ДЯСНА_СТРАНИЦА_КАНТ_МАТЕРИАЛ', label: 'ДЯСНА СТРАНИЦА КАНТ МАТЕРИАЛ', default: 'ГЛАДКО БЯЛО' },
  { key: 'ТАВАН_МАТЕРИАЛ',              label: 'ТАВАН МАТЕРИАЛ',              default: 'ГЛАДКО БЯЛО' },
  { key: 'ТАВАН_КАНТ_МАТЕРИАЛ',         label: 'ТАВАН КАНТ МАТЕРИАЛ',         default: 'ГЛАДКО БЯЛО' },
  { key: 'РЕБРО_ТАВАН_1_МАТЕРИАЛ',      label: 'РЕБРО ТАВАН 1 МАТЕРИАЛ',      default: 'ГЛАДКО БЯЛО' },
  { key: 'РЕБРО_ТАВАН_1_КАНТ_МАТЕРИАЛ', label: 'РЕБРО ТАВАН 1 КАНТ МАТЕРИАЛ', default: 'ГЛАДКО БЯЛО' },
  { key: 'РЕБРО_ТАВАН_2_МАТЕРИАЛ',      label: 'РЕБРО ТАВАН 2 МАТЕРИАЛ',      default: 'ГЛАДКО БЯЛО' },
  { key: 'РЕБРО_ТАВАН_2_КАНТ_МАТЕРИАЛ', label: 'РЕБРО ТАВАН 2 КАНТ МАТЕРИАЛ', default: 'ГЛАДКО БЯЛО' },
  { key: 'ДЪНО_МАТЕРИАЛ',               label: 'ДЪНО МАТЕРИАЛ',               default: 'ГЛАДКО БЯЛО' },
  { key: 'ДЪНО_КАНТ_МАТЕРИАЛ',          label: 'ДЪНО КАНТ МАТЕРИАЛ',          default: 'ГЛАДКО БЯЛО' },
  { key: 'ГРЪБ_МАТЕРИАЛ',               label: 'ГРЪБ МАТЕРИАЛ',               default: 'ГЛАДКО БЯЛО' },
  { key: 'ГРЪБ_КАНТ_МАТЕРИАЛ',          label: 'ГРЪБ КАНТ МАТЕРИАЛ',          default: 'ГЛАДКО БЯЛО' },
  { key: 'ВРАТИЧКА_МАТЕРИАЛ',           label: 'ВРАТИЧКА МАТЕРИАЛ',           default: 'ГЛАДКО БЯЛО' },
  { key: 'ВРАТИЧКА_КАНТ_МАТЕРИАЛ',      label: 'ВРАТИЧКА КАНТ МАТЕРИАЛ',      default: 'ГЛАДКО БЯЛО' },
  // ПОЛИЦА 1..10: each pair only shown (admin-page.component.html) while that shelf's
  // own С_ПОЛИЦА_n toggle is checked.
  { key: 'ПОЛИЦА_1_МАТЕРИАЛ',       label: 'ПОЛИЦА 1 МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_1_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 1 КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_2_МАТЕРИАЛ',       label: 'ПОЛИЦА 2 МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_2_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 2 КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_3_МАТЕРИАЛ',       label: 'ПОЛИЦА 3 МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_3_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 3 КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_4_МАТЕРИАЛ',       label: 'ПОЛИЦА 4 МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_4_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 4 КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_5_МАТЕРИАЛ',       label: 'ПОЛИЦА 5 МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_5_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 5 КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_6_МАТЕРИАЛ',       label: 'ПОЛИЦА 6 МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_6_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 6 КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_7_МАТЕРИАЛ',       label: 'ПОЛИЦА 7 МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_7_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 7 КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_8_МАТЕРИАЛ',       label: 'ПОЛИЦА 8 МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_8_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 8 КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_9_МАТЕРИАЛ',       label: 'ПОЛИЦА 9 МАТЕРИАЛ',       default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_9_КАНТ_МАТЕРИАЛ',  label: 'ПОЛИЦА 9 КАНТ МАТЕРИАЛ',  default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_10_МАТЕРИАЛ',      label: 'ПОЛИЦА 10 МАТЕРИАЛ',      default: 'ГЛАДКО БЯЛО' },
  { key: 'ПОЛИЦА_10_КАНТ_МАТЕРИАЛ', label: 'ПОЛИЦА 10 КАНТ МАТЕРИАЛ', default: 'ГЛАДКО БЯЛО' },
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
      { key: 'МАТЕРИАЛ',      label: 'МАТЕРИАЛ',      default: 'ГЛАДКО БЯЛО' },
      { key: 'МАТЕРИАЛ_КАНТ', label: 'МАТЕРИАЛ КАНТ', default: 'ГЛАДКО БЯЛО' },
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
