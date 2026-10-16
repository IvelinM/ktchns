/**
 * WebCAD — cut-list (Спецификация) generation. Pure: turns the scene instances into the
 * tab-separated text the shop imports into Excel. The component only handles the download.
 *
 * It lists every ploskost panel in the project — standalone ПЛОСКОСТ objects AND each
 * board that composes a МОДУЛ (via `korpusPanels`, the same decomposition the 3D build
 * uses, so the geometry and the cut-list can never disagree).
 */
import { SceneInstance } from './webcad.model';
import { korpusPanels, KORPUS_KANT } from './webcad-geometry';

interface Panel {
  element: string; material: string; kantMaterial: string; size1: number; size2: number;
  pvc: boolean[]; kant: number;
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
    const toKey = panelName.replace(/ /g, '_') + '_МАТЕРИАЛ';
    const toKantKey = panelName.replace(/ /g, '_') + '_КАНТ_МАТЕРИАЛ';
    return { board: inst.materials?.[toKey] ?? '', kant: inst.materials?.[toKantKey] ?? '' };
  }
  const board = inst.materials?.['МАТЕРИАЛ'] ?? inst.material ?? '';
  const kant = inst.materials?.['МАТЕРИАЛ_КАНТ'] ?? '';
  return { board, kant };
}

/**
 * Build the cut-list as a single UTF-8 (BOM-prefixed) tab-separated string.
 *
 * Column → edge mapping for a panel (sides AB, BC, CD, DA):
 *   РАЗМЕР 1 = AB, its parallel edges are AB (ОТПРЕД) and CD (ОТЗАД)
 *   РАЗМЕР 2 = BC, its parallel edges are BC (ОТПРЕД) and DA (ОТЗАД)
 * The cut (core) РАЗМЕР is the nominal size minus the band thickness on each edge
 * PERPENDICULAR to that dimension. An edge cell holds the band thickness (mm) or blank.
 *
 * `itemize` off (default): identical panels (same ЕЛЕМЕНТ, material, kant material, size
 * and banding) collapse to one row with a БРОЙ quantity. `itemize` on: one row per
 * physical panel, БРОЙ dropped, ЕЛЕМЕНТ shown.
 */
export function buildScheduleText(instances: SceneInstance[], itemize: boolean): string {
  const panels: Panel[] = [];
  const addPanel = (element: string, material: string, kantMaterial: string, AB: number, BC: number, pvc: boolean[], kant: number) => {
    const r1 = kant * ((pvc[1] ? 1 : 0) + (pvc[3] ? 1 : 0));
    const r2 = kant * ((pvc[0] ? 1 : 0) + (pvc[2] ? 1 : 0));
    panels.push({ element, material, kantMaterial, size1: Math.round(AB - r1), size2: Math.round(BC - r2), pvc, kant });
  };

  for (const inst of instances) {
    if (inst.familyId === 'ploskost') {
      const p = inst.params;
      const { board, kant: kantMat } = resolveMaterials(inst, null);
      addPanel(inst.label, board, kantMat, p['AB'], p['BC'],
        [!!p['pvcAB'], !!p['pvcBC'], !!p['pvcCD'], !!p['pvcDA']], p['kantThickness'] || 0);
    } else if (inst.familyId === 'module') {
      const kant = inst.params['КАНТ_ДЕБЕЛИНА'] ?? KORPUS_KANT;
      for (const pan of korpusPanels(inst.params, true)) {
        const { board, kant: kantMat } = resolveMaterials(inst, pan.name);
        addPanel(pan.name, board, kantMat, pan.AB, pan.BC, pan.pvc, kant);
      }
    }
  }

  // Edge cells in column order: РАЗМЕР 1 ОТПРЕД/ОТЗАД (AB, CD), РАЗМЕР 2 ОТПРЕД/ОТЗАД (BC, DA).
  const band = (on: boolean, kant: number) => (on ? String(kant) : '');
  const edges = (p: Panel) =>
    [band(p.pvc[0], p.kant), band(p.pvc[2], p.kant), band(p.pvc[1], p.kant), band(p.pvc[3], p.kant)];

  const edgeHeaders = ['КАНТ РАЗМЕР 1 ОТПРЕД', 'КАНТ РАЗМЕР 1 ОТЗАД', 'КАНТ РАЗМЕР 2 ОТПРЕД', 'КАНТ РАЗМЕР 2 ОТЗАД'];
  const lines: string[] = [];

  if (itemize) {
    // One row per physical panel: ЕЛЕМЕНТ column present, no БРОЙ.
    lines.push(['ЕЛЕМЕНТ', 'МАТЕРИАЛ', 'КАНТ МАТЕРИАЛ', 'РАЗМЕР 1', 'РАЗМЕР 2', ...edgeHeaders].join('\t'));
    for (const p of panels) {
      lines.push([p.element, p.material, p.kantMaterial, p.size1, p.size2, ...edges(p)].join('\t'));
    }
  } else {
    // Merge identical panels across the whole project: БРОЙ column present, no ЕЛЕМЕНТ.
    lines.push(['МАТЕРИАЛ', 'КАНТ МАТЕРИАЛ', 'РАЗМЕР 1', 'РАЗМЕР 2', 'БРОЙ', ...edgeHeaders].join('\t'));
    const rows = new Map<string, { p: Panel; count: number }>();
    for (const p of panels) {
      const key = [p.material, p.kantMaterial, p.size1, p.size2, ...edges(p)].join('|');
      const ex = rows.get(key);
      if (ex) ex.count++;
      else rows.set(key, { p, count: 1 });
    }
    for (const { p, count } of rows.values()) {
      lines.push([p.material, p.kantMaterial, p.size1, p.size2, count, ...edges(p)].join('\t'));
    }
  }

  // Prepend a UTF-8 BOM so Excel reads the Cyrillic headers correctly.
  return String.fromCharCode(0xFEFF) + lines.join('\r\n');
}
