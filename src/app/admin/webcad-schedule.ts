/**
 * WebCAD — cut-list (Спецификация) generation. Pure: turns the scene instances into the
 * tab-separated text the shop imports into Excel. The component only handles the download.
 *
 * It lists every ploskost panel in the project — standalone ПЛОСКОСТ objects AND each
 * board that composes a МОДУЛ (via `korpusPanels`, the same decomposition the 3D build
 * uses, so the geometry and the cut-list can never disagree).
 */
import { SceneInstance, MaterialDef } from './webcad.model';
import { korpusPanels, drawerPanels, panelMaterialGroup, panelGrainParamKey, KORPUS_KANT } from './webcad-geometry';

export interface Panel {
  element: string; module: string; material: string; kantMaterial: string; size1: number; size2: number;
  pvc: boolean[]; kant: number; thickness: number;
}

/**
 * This panel's board + edge-band material names, resolved the SAME way the 3D build
 * colours it (cadColorObj/applyRenderMaterials in admin-page.component.ts):
 * panel-based families (МОДУЛ) key their per-panel pick as `<PANEL_NAME>_МАТЕРИАЛ` /
 * `_КАНТ_МАТЕРИАЛ` (spaces → underscores); panel-less families (ПЛОСКОСТ) use the flat
 * `МАТЕРИАЛ`/`МАТЕРИАЛ_КАНТ` keys, falling back to the legacy free-text `material` field
 * for an instance saved before either existed. Blank (not a guess) when nothing resolves.
 */
function resolveMaterials(inst: SceneInstance, panelName: string | null): { board: string; kant: string } {
  if (panelName) {
    // panelMaterialGroup lets a family share one pick across several panel names
    // (ЧЕКМЕДЖЕ's structural panels) instead of one per name — same rule
    // cadColorObj/applyRenderMaterials (admin-page.component.ts) use for the 3D build.
    const group = panelMaterialGroup(inst.familyId, panelName);
    const toKey = group.replace(/ /g, '_') + '_МАТЕРИАЛ';
    const toKantKey = group.replace(/ /g, '_') + '_КАНТ_МАТЕРИАЛ';
    return { board: inst.materials?.[toKey] ?? '', kant: inst.materials?.[toKantKey] ?? '' };
  }
  const board = inst.materials?.['МАТЕРИАЛ'] ?? inst.material ?? '';
  const kant = inst.materials?.['МАТЕРИАЛ_КАНТ'] ?? '';
  return { board, kant };
}

/**
 * Whether this panel's size1/size2 (and banding) need swapping so РАЗМЕР 1 ends up
 * being whichever of its two dimensions the wood grain actually runs along — shops cut
 * along the grain first, so that's what "the first dimension" has to mean in the
 * cut-list, regardless of which one happens to be this panel's own geometric AB.
 *
 * The material's own `grainAxis` ('Ш' = parallel to AB/РАЗМЕР 1, 'В' = parallel to
 * BC/РАЗМЕР 2 — default 'В') names the axis for that material's texture in a panel's
 * UN-rotated orientation; checking that specific panel's own ЗАВЪРТЯН_ФЛАДЕР toggle
 * (same one `panelGrainRotation` in admin-page.component.ts reads, for the Render-mode
 * texture's own 90° spin) flips it. Only matters when the board material actually HAS a
 * texture — a flat colour has no grain to align, so never swaps.
 */
function grainSwap(inst: SceneInstance, panelName: string | null, boardMaterial: string, materialDefs: MaterialDef[]): boolean {
  const def = materialDefs.find(m => m.name === boardMaterial);
  if (!def?.texture) return false;
  const baseAxis = def.grainAxis ?? 'В';
  const rotated = panelName ? inst.params[panelGrainParamKey(panelName)] === 1 : false;
  const effective = rotated ? (baseAxis === 'В' ? 'Ш' : 'В') : baseAxis;
  return effective === 'В';
}

/**
 * Collect every ploskost panel in the project — standalone ПЛОСКОСТ objects AND each
 * board that composes a МОДУЛ/ЧЕКМЕДЖЕ (via `korpusPanels`/`drawerPanels`, the same
 * decomposition the 3D build uses, so the geometry and any export of this list can
 * never disagree) — with its size already reduced by its own banding (`addPanel`'s
 * r1/r2) and, where the grain calls for it, AB/BC (and their banding) already swapped
 * so size1/size2 come out grain-correct (see `grainSwap`). Shared by `buildScheduleText`
 * (the .txt download) and the manufacturer-specific .xlsx exporters
 * (`webcad-export-xlsx.ts`), so every export lists the exact same panels.
 *
 * Each panel also carries its owning instance's own `label` as `module` — for a
 * standalone ПЛОСКОСТ that's the same text as `element` (it IS its own one panel), but
 * for a МОДУЛ/ЧЕКМЕДЖЕ it's what actually ties e.g. every "ТАВАН" row in an itemized
 * list back to which physical cabinet it came from (buildScheduleText's own ЕЛЕМЕНТ
 * column, by itself, can't tell two cabinets' identically-named panels apart).
 */
export function collectPanels(instances: SceneInstance[], materialDefs: MaterialDef[]): Panel[] {
  const panels: Panel[] = [];
  const addPanel = (element: string, module: string, material: string, kantMaterial: string, AB: number, BC: number, pvc: boolean[], kant: number, thickness: number, swap: boolean) => {
    const ab = swap ? BC : AB, bc = swap ? AB : BC;
    const p2 = swap ? [pvc[1], pvc[0], pvc[3], pvc[2]] : pvc;
    const r1 = kant * ((p2[1] ? 1 : 0) + (p2[3] ? 1 : 0));
    const r2 = kant * ((p2[0] ? 1 : 0) + (p2[2] ? 1 : 0));
    panels.push({ element, module, material, kantMaterial, size1: Math.round(ab - r1), size2: Math.round(bc - r2), pvc: p2, kant, thickness });
  };

  for (const inst of instances) {
    if (inst.familyId === 'ploskost') {
      const p = inst.params;
      const { board, kant: kantMat } = resolveMaterials(inst, null);
      addPanel(inst.label, inst.label, board, kantMat, p['AB'], p['BC'],
        [!!p['pvcAB'], !!p['pvcBC'], !!p['pvcCD'], !!p['pvcDA']], p['kantThickness'] || 0, p['thickness'] || 0,
        grainSwap(inst, null, board, materialDefs));
    } else if (inst.familyId === 'module') {
      const kant = inst.params['КАНТ_ДЕБЕЛИНА'] ?? KORPUS_KANT;
      for (const pan of korpusPanels(inst.params, true)) {
        const { board, kant: kantMat } = resolveMaterials(inst, pan.name);
        addPanel(pan.name, inst.label, board, kantMat, pan.AB, pan.BC, pan.pvc, kant, pan.t, grainSwap(inst, pan.name, board, materialDefs));
      }
    } else if (inst.familyId === 'drawer') {
      const kant = inst.params['КАНТ_ДЕБЕЛИНА'] ?? KORPUS_KANT;
      for (const pan of drawerPanels(inst.params)) {
        const { board, kant: kantMat } = resolveMaterials(inst, pan.name);
        addPanel(pan.name, inst.label, board, kantMat, pan.AB, pan.BC, pan.pvc, kant, pan.t, grainSwap(inst, pan.name, board, materialDefs));
      }
    }
  }
  return panels;
}

// Edge cells in column order: РАЗМЕР 1 ОТПРЕД/ОТЗАД (AB, CD), РАЗМЕР 2 ОТПРЕД/ОТЗАД (BC, DA).
const band = (on: boolean, kant: number) => (on ? String(kant) : '');
export const panelEdges = (p: Panel) =>
  [band(p.pvc[0], p.kant), band(p.pvc[2], p.kant), band(p.pvc[1], p.kant), band(p.pvc[3], p.kant)];

/**
 * Group the sheet by board material (then kant material, then size) so every panel cut
 * from the same board sits together — what the shop actually needs when buying/nesting
 * sheets, instead of whatever order objects happened to be placed in.
 */
export const byMaterial = (a: Panel, c: Panel) =>
  a.material.localeCompare(c.material, 'bg') || a.kantMaterial.localeCompare(c.kantMaterial, 'bg')
  || a.size1 - c.size1 || a.size2 - c.size2;

/**
 * Merge identical panels (same material, kant material, size and banding) into one row
 * each with a piece count — the "merged"/non-itemize convention `buildScheduleText` and
 * the Мая .xlsx export both use. Sorted by whatever comparator the caller passes.
 */
export function mergePanels(panels: Panel[], sortCmp: (a: Panel, c: Panel) => number): { p: Panel; count: number }[] {
  const rows = new Map<string, { p: Panel; count: number }>();
  for (const p of panels) {
    const key = [p.material, p.kantMaterial, p.size1, p.size2, p.thickness, ...panelEdges(p)].join('|');
    const ex = rows.get(key);
    if (ex) ex.count++;
    else rows.set(key, { p, count: 1 });
  }
  return [...rows.values()].sort((a, c) => sortCmp(a.p, c.p));
}

/**
 * Build the cut-list as a single UTF-8 (BOM-prefixed) tab-separated string.
 *
 * Column → edge mapping for a panel (sides AB, BC, CD, DA):
 *   РАЗМЕР 1 = AB, its parallel edges are AB (ОТПРЕД) and CD (ОТЗАД)
 *   РАЗМЕР 2 = BC, its parallel edges are BC (ОТПРЕД) and DA (ОТЗАД)
 * The cut (core) РАЗМЕР is the nominal size minus the band thickness on each edge
 * PERPENDICULAR to that dimension. An edge cell holds the band thickness (mm) or blank.
 * ДЕБЕЛИНА (mm, `Panel.thickness`) sits right after КАНТ МАТЕРИАЛ and before РАЗМЕР 1 in
 * both layouts below — inserting it shifted the merged layout's БРОЙ column from E to F,
 * so its ОБЩО subtotal formula references F, not E (kept in sync by hand, there's no
 * single source of column letters here).
 *
 * `itemize` off (default): identical panels (same ЕЛЕМЕНТ, material, kant material, size
 * and banding) collapse to one row with a БРОЙ quantity. `itemize` on: one row per
 * physical panel, БРОЙ dropped, ЕЛЕМЕНТ shown.
 *
 * `asFormulas` (default true, the .txt download): each ОБЩО subtotal is a live
 * spreadsheet formula (see `totalLine` below). The dialog's own preview table passes
 * `false` instead, to show the plain already-known number — a formula's literal text
 * (`="ОБЩО …" & SUM(...) & " бр."`) is meant for a spreadsheet to evaluate, not to be
 * read as-is.
 */
export function buildScheduleText(instances: SceneInstance[], itemize: boolean, materialDefs: MaterialDef[], asFormulas = true): string {
  const panels = collectPanels(instances, materialDefs);
  const edges = panelEdges;

  const edgeHeaders = ['КАНТ РАЗМЕР 1 ОТПРЕД', 'КАНТ РАЗМЕР 1 ОТЗАД', 'КАНТ РАЗМЕР 2 ОТПРЕД', 'КАНТ РАЗМЕР 2 ОТЗАД'];
  const lines: string[] = [];
  // `asFormulas`: a live spreadsheet formula (not a number baked in here) so the piece
  // count stays correct if the shop edits/deletes a row after opening the file in
  // Excel/Sheets — both parse a cell starting with "=" as a formula straight out of a
  // tab-separated import, so this needs no extra step on the user's side. `countExpr`
  // ranges over whichever column actually holds a per-row piece count (БРОЙ in merged
  // mode; in itemize mode every row IS one piece, so count the ЕЛЕМЕНТ column instead —
  // see each branch below for its own column letter). `"` inside a material name is
  // doubled, the Excel/Sheets escape for a literal quote inside a formula string.
  // Otherwise (the dialog preview): the already-known `value`, plain text.
  const totalLine = (material: string, countExpr: string, value: number) => {
    const label = material || '(без материал)';
    return asFormulas
      ? `="ОБЩО ${label.replace(/"/g, '""')}: " & ${countExpr} & " бр."`
      : `ОБЩО ${label}: ${value} бр.`;
  };

  if (itemize) {
    // One row per physical panel: ЕЛЕМЕНТ (+ the owning instance's own label, МОДУЛ —
    // what actually tells two cabinets' identically-named panels apart) column present,
    // no БРОЙ. After each material group: a ОБЩО subtotal (=COUNTA over that group's
    // ЕЛЕМЕНТ rows — column A, unaffected by МОДУЛ sitting in B) then a blank separator row.
    lines.push(['ЕЛЕМЕНТ', 'МОДУЛ', 'МАТЕРИАЛ', 'КАНТ МАТЕРИАЛ', 'ДЕБЕЛИНА', 'РАЗМЕР 1', 'РАЗМЕР 2', ...edgeHeaders].join('\t'));
    const sorted = panels.slice().sort(byMaterial);
    let i = 0;
    while (i < sorted.length) {
      const material = sorted[i].material;
      const startRow = lines.length + 1;
      let count = 0;
      while (i < sorted.length && sorted[i].material === material) {
        const p = sorted[i];
        lines.push([p.element, p.module, p.material, p.kantMaterial, p.thickness, p.size1, p.size2, ...edges(p)].join('\t'));
        count++; i++;
      }
      lines.push(totalLine(material, `COUNTA(A${startRow}:A${lines.length})`, count));
      lines.push('');
    }
  } else {
    // Merge identical panels across the whole project: БРОЙ column present, no ЕЛЕМЕНТ.
    // Same per-material ОБЩО subtotal + blank separator as itemize, but the formula
    // sums that group's БРОЙ column (F — a row can represent >1 piece) instead of
    // counting rows.
    lines.push(['МАТЕРИАЛ', 'КАНТ МАТЕРИАЛ', 'ДЕБЕЛИНА', 'РАЗМЕР 1', 'РАЗМЕР 2', 'БРОЙ', ...edgeHeaders].join('\t'));
    const sorted = mergePanels(panels, byMaterial);
    let i = 0;
    while (i < sorted.length) {
      const material = sorted[i].p.material;
      const startRow = lines.length + 1;
      let total = 0;
      while (i < sorted.length && sorted[i].p.material === material) {
        const { p, count } = sorted[i];
        lines.push([p.material, p.kantMaterial, p.thickness, p.size1, p.size2, count, ...edges(p)].join('\t'));
        total += count; i++;
      }
      lines.push(totalLine(material, `SUM(F${startRow}:F${lines.length})`, total));
      lines.push('');
    }
  }

  // Prepend a UTF-8 BOM so Excel reads the Cyrillic headers correctly.
  return String.fromCharCode(0xFEFF) + lines.join('\r\n');
}
