/**
 * WebCAD — manufacturer-specific production-offer request exports (.xlsx). Pure (well,
 * Хосе's needs one fetch): turns the scene instances into a workbook, reusing the same
 * panel list the .txt cut-list uses (`collectPanels`, webcad-schedule.ts) so every
 * export agrees on what's actually in the scene. The component only handles triggering
 * the download (ExcelJS's `writeBuffer` → Blob).
 */
import ExcelJS from 'exceljs';
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

/**
 * Хосе's own template, copied into the repo verbatim as a one-sheet starting point
 * (letterhead, instructions, 3 embedded diagrams, the client-info block and the
 * material/kant summary lines all cleared back to blank, rows 27–54 pre-numbered
 * №1–28 with their borders/number formats intact but no data) — prepared once from
 * D:\WORK_FILES\TONI_SILVIYA\PLOT\Toni_Garderob.xls (see assets/templates/README, if
 * one gets added) and NEVER written back to; `buildHoseWorkbook` only ever reads it.
 */
const HOSE_TEMPLATE_URL = 'assets/templates/hose-template.xlsx';

/**
 * Build a workbook for Хосе's production-offer request — one sheet per board material
 * actually used in the scene, each a clone of the real Хосе template (fetched from
 * `HOSE_TEMPLATE_URL`, read-only — this function never saves back to it): same
 * letterhead, instructions, diagrams, fonts, borders and merges as the original, just
 * with the client-info block left blank (this app has no client/delivery-address field
 * to pull from — the user fills it in by hand) and the material+kant summary line
 * auto-filled from this group's panels ("Вид плоскост/цвят/номер/дебелина:" /
 * "Кант /цвят /номер/ дебелина", per the request), then one row per distinct panel
 * size+banding in this material, merged with a count exactly like the .txt export's
 * "merged" mode (`mergePanels`, webcad-schedule.ts), sorted by size1 then size2 — да/−
 * per edge, same convention as the template (E/F = AB/CD edges "отпред"/"отзад", G/H =
 * BC/DA edges "ляво"/"дясно").
 *
 * Note: we don't track a decor "номер" (board code, e.g. "H2033 ST10") per material —
 * only its name — so the summary line omits that segment rather than inventing one.
 * A material with more than 28 distinct size+banding combos overflows the template's
 * own pre-formatted row range (27–54) — the extra rows still get the right data, just
 * without that range's borders/number formatting (very unlikely in practice: that's
 * already more distinct cuts than any of Хосе's own real past orders had).
 */
export async function buildHoseWorkbook(instances: SceneInstance[]): Promise<ExcelJS.Workbook> {
  const panels = collectPanels(instances);
  const byMaterialGroup = new Map<string, Panel[]>();
  for (const p of panels) {
    const key = p.material || '(без материал)';
    (byMaterialGroup.get(key) ?? byMaterialGroup.set(key, []).get(key)!).push(p);
  }

  const res = await fetch(HOSE_TEMPLATE_URL);
  if (!res.ok) throw new Error(`Не успях да заредя шаблона на Хосе (${HOSE_TEMPLATE_URL}): HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  const template = wb.worksheets[0];
  const templateImages = template.getImages();
  const templateMerges = (template.model as { merges?: string[] }).merges ?? [];

  const materials = [...byMaterialGroup.keys()].sort((a, b) => a.localeCompare(b, 'bg'));
  const usedNames = new Set<string>();

  for (const material of materials) {
    const group = byMaterialGroup.get(material)!;
    const ws = wb.addWorksheet(sanitizeSheetName(material, usedNames));
    ws.columns = template.columns.map(c => ({ width: c.width }));

    // Clone every row's values + styles (NOT a shared object reference — ExcelJS cells
    // hold live back-references to their own worksheet, so sharing one `.model` across
    // sheets corrupts the workbook; copying plain .value/.style per cell is safe).
    template.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const newRow = ws.getRow(rowNumber);
      if (row.height) newRow.height = row.height;
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const newCell = newRow.getCell(colNumber);
        newCell.value = cell.value;
        newCell.style = cell.style;
      });
      newRow.commit();
    });
    for (const range of templateMerges) {
      try { ws.mergeCells(range); } catch { /* already covered by an outer merge */ }
    }
    // exceljs's own .d.ts mistypes getImages()'s imageId as string while addImage()
    // demands a number — the runtime id is interchangeable either way (confirmed by a
    // successful round-trip through real Excel), so this cast just works around the
    // type declaration bug, not an actual type mismatch.
    for (const img of templateImages) ws.addImage(img.imageId as unknown as number, img.range);

    const thickness = mode(group.map(p => p.thickness));
    const kantMaterial = mode(group.map(p => p.kantMaterial)) || '';
    const kantThickness = mode(group.map(p => p.kant));
    ws.getCell('D22').value = `ПДЧ/${material}/${thickness} мм`;
    ws.getCell('D23').value = kantMaterial ? `${kantMaterial} / ${kantThickness}мм` : '';

    const merged = mergePanels(group, (a, c) => a.size1 - c.size1 || a.size2 - c.size2);
    merged.forEach(({ p, count }, i) => {
      const r = 27 + i;
      ws.getCell(`A${r}`).value = i + 1;
      ws.getCell(`B${r}`).value = p.size1;
      ws.getCell(`C${r}`).value = p.size2;
      ws.getCell(`D${r}`).value = count;
      ws.getCell(`E${r}`).value = BAND(p.pvc[0]);
      ws.getCell(`F${r}`).value = BAND(p.pvc[2]);
      ws.getCell(`G${r}`).value = BAND(p.pvc[1]);
      ws.getCell(`H${r}`).value = BAND(p.pvc[3]);
    });
  }

  // Drop the blank source sheet from the download — unless there turned out to be no
  // materials at all, in which case leave it rather than ship a workbook with zero
  // sheets (Excel can't open one).
  if (materials.length > 0) wb.removeWorksheet(template.id);
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
 * template doesn't use one either). No source template to clone here — her sheet has
 * no special formatting worth preserving, so this one's built from scratch.
 */
export async function buildMayaWorkbook(instances: SceneInstance[]): Promise<ExcelJS.Workbook> {
  const panels = collectPanels(instances);
  const merged = mergePanels(panels, (a, c) => a.size2 - c.size2 || a.size1 - c.size1);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.columns = [6, 36, 16, 9, 9, 11, 11, 7].map(width => ({ width }));

  ws.getCell('A1').value = 'Спецификация - Всички Гардероб Модули';
  ['ТИП', 'МАТЕРИАЛ', 'МАТЕРИАЛ_КАНТ', 'BC [mm]', 'AB [mm]', 'КАНТ_ДЪЛГИ', 'КАНТ_КЪСИ', 'БРОЙ']
    .forEach((h, i) => { ws.getRow(2).getCell(i + 1).value = h; });

  let total = 0, rowNum = 4;
  for (const { p, count } of merged) {
    const longCount = (p.pvc[0] ? 1 : 0) + (p.pvc[2] ? 1 : 0);
    const shortCount = (p.pvc[1] ? 1 : 0) + (p.pvc[3] ? 1 : 0);
    const row = ws.getRow(rowNum);
    [ 'ПДЧ', p.material, p.kantMaterial, p.size2, p.size1, LONG_LABEL[longCount], SHORT_LABEL[shortCount], count ]
      .forEach((v, i) => { row.getCell(i + 1).value = v; });
    total += count;
    rowNum++;
  }
  ws.getCell(`A${rowNum}`).value = `Grand total: ${total}`;

  return wb;
}
