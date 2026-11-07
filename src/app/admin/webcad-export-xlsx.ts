/**
 * WebCAD — manufacturer-specific production-offer request exports (.xlsx). Pure: turns
 * the scene instances into a SheetJS workbook matching each manufacturer's own template
 * exactly, reusing the same panel list the .txt cut-list uses (`collectPanels`,
 * webcad-schedule.ts) so every export agrees on what's actually in the scene. The
 * component only handles triggering the download (XLSX.writeFile).
 */
import * as XLSX from 'xlsx';
import { SceneInstance } from './webcad.model';
import { Panel, collectPanels, mergePanels } from './webcad-schedule';

/** Excel forbids `: \ / ? * [ ]` in a sheet name and caps it at 31 chars; de-duplicate
 *  (two raw material names could collapse to the same sanitized name) by suffixing a
 *  counter. */
function sanitizeSheetName(name: string, used: Set<string>): string {
  const base = (name || '(без материал)').replace(/[:\\/?*[\]]/g, ' ').trim().slice(0, 31) || 'Материал';
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    const suffix = ` ${n}`;
    candidate = base.slice(0, 31 - suffix.length) + suffix;
    n++;
  }
  used.add(candidate);
  return candidate;
}

/** Most common value in a list (ties keep the first occurrence) — used where a
 *  sheet-level summary field (Хосе's Вид плоскост/Кант line) must pick ONE value to
 *  represent a whole material group that could, in this app, mix more than one kant
 *  material or thickness even though the fixed one-line-per-sheet template can't show
 *  that — every row's own да/- banding stays exact regardless; only this summary text
 *  is a best effort in that edge case. */
function mode<T>(values: T[]): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = values[0], bestCount = -1;
  for (const [v, c] of counts) if (c > bestCount) { best = v; bestCount = c; }
  return best;
}

const BAND = (on: boolean) => (on ? 'да' : '-');

/** The fixed ХОСЕ letterhead + cutting instructions + table headers, identical on every
 *  sheet of their template (D:\WORK_FILES\TONI_SILVIYA\PLOT\Toni_Garderob.xls) — kept
 *  verbatim, including its own "рзмер      2 дясно" header typo (H26): their staff
 *  already read the template that way, so "fixing" it would only make this export look
 *  unfamiliar to them. */
const HOSE_BOILERPLATE: [string, string][] = [
  ['C1', 'ХОСЕ '],
  ['C2', 'Гара Искър ул. Неделчо Бончев № 6 склад 3'],
  ['C3', 'тел: 9790063; тел:  9791561; моб. тел: 0894641418'],
  ['C4', ' работно време: от понеделник до петък - 9.00 до 17.30 часа'],
  ['C5', 'www.hosse.bg'],
  ['A6', 'ЗАЯВКА'],
  ['A7', 'РАЗКРОЙ И КАНТИРАНЕ'],
  ['A8', 'забел.: '],
  ['B8', 'Размерите на детайлите се задават в милиметри (мм)'],
  ['B9', 'Размерът на детайлите е без включен кант'],
  ['B10', 'Технологичен отпадък 4см на кантирана страна независимо от дължината на страната'],
  ['B11', 'Минимално разстояние между детайлите 5мм'],
  ['B12', 'Първият размер следва посоката на фладера'],
  ['H12', '               Панти Ø35мм - врата лява и дясна '],
  ['B14', 'Детайли с широчина по-малка от 80мм не се приемат за кантиране'],
  ['B15', 'Фирата от разкроя на плоскостите се получава от клиента (ако остане се пази 5 дни, след това не се носи отговорност)'],
  ['B17', 'Клиент/фирма:'],
  ['B18', 'Адрес за доставка:'],
  ['B19', 'Телефон:'],
  ['B20', 'е-mail:'],
  ['B22', 'Вид плоскост/цвят/номер/дебелина:'],
  ['B23', 'Кант /цвят /номер/ дебелина'],
  ['A25', '№ елемент'], ['B25', 'размер детайл без кант /мм/'], ['D25', 'брой'],
  ['E25', 'кантиране на страна / размер/'], ['I25', 'вид кант '], ['J25', 'без фладер /отметка/'],
  ['K25', 'панти Ø35мм дълга/къса лява/дясна'], ['L25', 'забел.'],
  ['B26', 'размер 1 '], ['C26', 'размер 2'], ['E26', 'размер 1 отпред'], ['F26', 'размер 1 отзад'],
  ['G26', 'размер 2 ляво '], ['H26', 'рзмер      2 дясно'],
];

/** Same merges the original template uses to centre its letterhead/instructions/client-
 *  info text across the sheet's full width — cosmetic only (the `xlsx` package doesn't
 *  carry over fonts/fills on write, just structure), applied identically to every sheet. */
const HOSE_MERGES: XLSX.Range[] = [
  ...[0, 1, 2, 3, 4].map(r => ({ s: { r, c: 2 }, e: { r, c: 11 } })),   // rows 1-5: C:L
  { s: { r: 5, c: 0 }, e: { r: 5, c: 11 } },    // row 6: A:L
  { s: { r: 6, c: 0 }, e: { r: 6, c: 11 } },    // row 7: A:L
  { s: { r: 16, c: 3 }, e: { r: 16, c: 11 } },  // row 17: D:L
  { s: { r: 17, c: 3 }, e: { r: 17, c: 11 } },  // row 18
  { s: { r: 18, c: 3 }, e: { r: 18, c: 11 } },  // row 19
  { s: { r: 19, c: 3 }, e: { r: 19, c: 11 } },  // row 20
  { s: { r: 21, c: 3 }, e: { r: 21, c: 11 } },  // row 22
  { s: { r: 22, c: 3 }, e: { r: 22, c: 11 } },  // row 23
];

const HOSE_COL_WIDTHS = [6, 14, 12, 7, 9, 9, 9, 9, 10, 12, 16, 14].map(wch => ({ wch }));

/**
 * Build a workbook for Хосе's production-offer request — one sheet per board material
 * actually used in the scene, each a copy of their own template's layout: fixed company
 * letterhead + instructions (rows 1–15), a blank client-info block (rows 17–20 — left
 * for the user to fill in by hand; this app has no client/delivery-address field to pull
 * from), the material+kant summary line auto-filled from this group's panels (rows
 * 22–23 — "Вид плоскост/цвят/номер/дебелина:" / "Кант /цвят /номер/ дебелина", per the
 * request), the table headers (rows 25–26), then one row per distinct panel size+
 * banding in this material, merged with a count exactly like the .txt export's "merged"
 * mode (`mergePanels`, webcad-schedule.ts), sorted by size1 then size2 (matching the
 * example's own row order) — banding shown as да/- per edge, same convention as the
 * template (E/F = AB/CD edges "отпред"/"отзад", G/H = BC/DA edges "ляво"/"дясно").
 *
 * Note: we don't track a decor "номер" (board code, e.g. "H2033 ST10") per material —
 * only its name — so D22/D23 omit that segment rather than inventing one.
 */
export function buildHoseWorkbook(instances: SceneInstance[]): XLSX.WorkBook {
  const panels = collectPanels(instances);
  const byMaterialGroup = new Map<string, Panel[]>();
  for (const p of panels) {
    const key = p.material || '(без материал)';
    (byMaterialGroup.get(key) ?? byMaterialGroup.set(key, []).get(key)!).push(p);
  }

  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();
  const materials = [...byMaterialGroup.keys()].sort((a, b) => a.localeCompare(b, 'bg'));

  for (const material of materials) {
    const group = byMaterialGroup.get(material)!;
    const ws = XLSX.utils.aoa_to_sheet([]);
    for (const [addr, val] of HOSE_BOILERPLATE) XLSX.utils.sheet_add_aoa(ws, [[val]], { origin: addr });

    const thickness = mode(group.map(p => p.thickness));
    const kantMaterial = mode(group.map(p => p.kantMaterial)) || '';
    const kantThickness = mode(group.map(p => p.kant));
    XLSX.utils.sheet_add_aoa(ws, [[`ПДЧ/${material}/${thickness} мм`]], { origin: 'D22' });
    XLSX.utils.sheet_add_aoa(ws, [[kantMaterial ? `${kantMaterial} / ${kantThickness}мм` : '']], { origin: 'D23' });

    const merged = mergePanels(group, (a, c) => a.size1 - c.size1 || a.size2 - c.size2);
    merged.forEach(({ p, count }, i) => {
      XLSX.utils.sheet_add_aoa(ws, [[
        i + 1, p.size1, p.size2, count,
        BAND(p.pvc[0]), BAND(p.pvc[2]), BAND(p.pvc[1]), BAND(p.pvc[3]),
      ]], { origin: `A${27 + i}` });
    });

    ws['!cols'] = HOSE_COL_WIDTHS;
    ws['!merges'] = HOSE_MERGES;
    XLSX.utils.book_append_sheet(wb, ws, sanitizeSheetName(material, usedNames));
  }

  return wb;
}

const LONG_LABEL = ['-', '1 ДЪЛЪГ', '2 ДЪЛГИ'];
const SHORT_LABEL = ['-', '1 КЪС', '2 КЪСИ'];

/**
 * Build a workbook for Мая's production-offer request — a single "Sheet1" matching her
 * own template's layout (D:\WORK_FILES\APARTAMENT_SLAV_KARASLAVOV\PLOT\СЛАВ КАРАСЛАВОВ -
 * ГАРДЕРОБ 1.xlsx): a title row, the column headers (ТИП/МАТЕРИАЛ/МАТЕРИАЛ_КАНТ/BC/AB/
 * КАНТ_ДЪЛГИ/КАНТ_КЪСИ/БРОЙ), a blank spacer row, then every distinct panel size+
 * banding across the WHOLE project (her template interleaves materials, not split into
 * sheets like Хосе's), merged with a count exactly like the .txt export's "merged" mode,
 * sorted by BC then AB (matching the example's own row order) — and a final
 * "Grand total: N" row, a literal count exactly like the example (not a formula; her
 * template doesn't use one either).
 */
export function buildMayaWorkbook(instances: SceneInstance[]): XLSX.WorkBook {
  const panels = collectPanels(instances);
  const merged = mergePanels(panels, (a, c) => a.size2 - c.size2 || a.size1 - c.size1);

  const rows: (string | number)[][] = [
    ['Спецификация - Всички Гардероб Модули'],
    ['ТИП', 'МАТЕРИАЛ', 'МАТЕРИАЛ_КАНТ', 'BC [mm]', 'AB [mm]', 'КАНТ_ДЪЛГИ', 'КАНТ_КЪСИ', 'БРОЙ'],
    [],
  ];
  let total = 0;
  for (const { p, count } of merged) {
    const longCount = (p.pvc[0] ? 1 : 0) + (p.pvc[2] ? 1 : 0);
    const shortCount = (p.pvc[1] ? 1 : 0) + (p.pvc[3] ? 1 : 0);
    rows.push(['ПДЧ', p.material, p.kantMaterial, p.size2, p.size1, LONG_LABEL[longCount], SHORT_LABEL[shortCount], count]);
    total += count;
  }
  rows.push([`Grand total: ${total}`]);

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [6, 36, 16, 9, 9, 11, 11, 7].map(wch => ({ wch }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return wb;
}
