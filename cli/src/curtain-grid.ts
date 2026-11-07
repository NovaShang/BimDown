/**
 * Curtain wall grid + panel layout (spec readme "Curtain Wall Grids and
 * Panels"). Mirrors the editor's elements/curtainWallLayout.ts; keep the two
 * in step.
 *
 * Columns run along the wall from its start, rows up from its base. Explicit
 * `v_grids` / `u_grids` (semicolon lists) win over `*_grid_count` (a cell
 * count), which wins over `*_spacing`; nothing set → 3 cells.
 */

export const PANEL_KINDS = ['glass', 'solid', 'door', 'double_door', 'empty'] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];

const EPS = 1e-3;
const DEFAULT_CELLS = 3;

/** `1.2;2.4` → numbers; tokens that are not finite numbers land in `bad`. */
export function parseNumberList(raw: string | undefined): { values: number[]; bad: string[] } {
  const values: number[] = [];
  const bad: string[] = [];
  for (const tok of (raw ?? '').split(';')) {
    const s = tok.trim();
    if (!s) continue;
    const n = Number(s);
    if (Number.isFinite(n)) values.push(n);
    else bad.push(s);
  }
  return { values, bad };
}

export interface PanelRule { col: number | '*'; row: number | '*'; kind: string }

const RULE = /^(\d+|\*)\s*[:,]\s*(\d+|\*)\s*=\s*([a-z_]+)$/;

/** `*:0=solid;1:0=door` → rules in order; malformed tokens land in `bad`. */
export function parsePanels(raw: string | undefined): { rules: PanelRule[]; bad: string[] } {
  const rules: PanelRule[] = [];
  const bad: string[] = [];
  for (const tok of (raw ?? '').split(';')) {
    const s = tok.trim();
    if (!s) continue;
    const m = RULE.exec(s);
    if (!m) { bad.push(s); continue; }
    rules.push({
      col: m[1] === '*' ? '*' : Number(m[1]),
      row: m[2] === '*' ? '*' : Number(m[2]),
      kind: m[3],
    });
  }
  return { rules, bad };
}

/**
 * Interior grid line positions over `extent` (wall length or height).
 * `explicit` non-blank → its values inside (0, extent), sorted, deduplicated.
 */
export function gridLines(explicit: string | undefined, count: string | undefined, spacing: string | undefined, extent: number): number[] {
  if ((explicit ?? '').trim() !== '') {
    const vals = parseNumberList(explicit).values.filter((v) => v > EPS && v < extent - EPS).sort((a, b) => a - b);
    return vals.filter((v, i) => i === 0 || v - vals[i - 1] > EPS);
  }
  let cells = DEFAULT_CELLS;
  if ((count ?? '').trim() !== '') {
    cells = Math.max(1, parseInt(count!, 10) || DEFAULT_CELLS);
  } else {
    const sp = parseFloat(spacing ?? '');
    if (sp > EPS && extent > 0) {
      const out: number[] = [];
      for (let t = sp; t < extent - EPS && out.length < 1000; t += sp) out.push(t);
      return out;
    }
  }
  return Array.from({ length: cells - 1 }, (_, i) => (extent * (i + 1)) / cells);
}

/** Kind per cell, `[col][row]`; rules outside the grid or with unknown kinds are skipped. */
export function cellKinds(rules: PanelRule[], cols: number, rows: number): PanelKind[][] {
  const out: PanelKind[][] = Array.from({ length: cols }, () => Array<PanelKind>(rows).fill('glass'));
  for (const r of rules) {
    if (!(PANEL_KINDS as readonly string[]).includes(r.kind)) continue;
    for (let c = 0; c < cols; c++) {
      if (r.col !== '*' && r.col !== c) continue;
      for (let w = 0; w < rows; w++) {
        if (r.row !== '*' && r.row !== w) continue;
        out[c][w] = r.kind as PanelKind;
      }
    }
  }
  return out;
}
