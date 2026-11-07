/**
 * Curtain wall grid, panels and members (spec readme "Curtain Wall Grids and
 * Panels"). Pure: shared by the 2D / 3D draw, the properties-panel editor and
 * the IFC / plan / glTF exports. The CLI mirrors the parsing in
 * bimdown-spec/cli/src/curtain-grid.ts; keep the two in step.
 *
 * Columns run along the wall from its start, rows up from its base. Explicit
 * `v_grids` / `u_grids` (semicolon lists) win over `*_grid_count` (a cell
 * count, as the editor has always read it), which wins over `*_spacing`;
 * nothing set → 3 cells.
 */
import type { Point } from '../model/elements.ts';

export const PANEL_KINDS = ['glass', 'solid', 'door', 'double_door', 'empty'] as const;
export type PanelKind = (typeof PANEL_KINDS)[number];
export type GridAxis = 'v' | 'u';

const EPS = 1e-3;
const DEFAULT_CELLS = 3;
/** Smallest cell the editor lets a grid edit create. */
export const MIN_CELL = 0.05;

export const DEFAULT_MULLION = 0.05;
export const GLASS_THICKNESS = 0.006;
export const DEFAULT_SOLID_MATERIAL = 'aluminum';

// ─── Parsing ─────────────────────────────────────────────────────────────────

export function parseNumberList(raw: string | undefined): number[] {
  const out: number[] = [];
  for (const tok of (raw ?? '').split(';')) {
    const s = tok.trim();
    if (!s) continue;
    const n = Number(s);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

export function formatNumberList(values: number[]): string {
  return values.map(v => String(round3(v))).join(';');
}

export interface PanelRule { col: number | '*'; row: number | '*'; kind: string }

const RULE = /^(\d+|\*)\s*[:,]\s*(\d+|\*)\s*=\s*([a-z_]+)$/;

export function parsePanels(raw: string | undefined): PanelRule[] {
  const rules: PanelRule[] = [];
  for (const tok of (raw ?? '').split(';')) {
    const m = RULE.exec(tok.trim());
    if (!m) continue;
    rules.push({ col: m[1] === '*' ? '*' : Number(m[1]), row: m[2] === '*' ? '*' : Number(m[2]), kind: m[3] });
  }
  return rules;
}

/** Interior grid line positions over `extent`; see the file header for precedence. */
export function gridLines(explicit: string | undefined, count: string | undefined, spacing: string | undefined, extent: number): number[] {
  if ((explicit ?? '').trim() !== '') {
    const vals = parseNumberList(explicit).filter(v => v > EPS && v < extent - EPS).sort((a, b) => a - b);
    return vals.filter((v, i) => i === 0 || v - vals[i - 1] > EPS);
  }
  let cells = DEFAULT_CELLS;
  if ((count ?? '').trim() !== '') {
    cells = Math.max(1, parseInt(count!, 10) || DEFAULT_CELLS);
  } else {
    const sp = parseFloat(spacing ?? '');
    if (sp > EPS && extent > 0) {
      const out: number[] = [];
      for (let t = sp; t < extent - EPS && out.length < 500; t += sp) out.push(t);
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

/** `[col][row]` kinds → `panels` text: a uniform non-glass row as `*:row=kind`, else one entry per non-glass cell. */
export function formatPanels(kinds: PanelKind[][]): string {
  const cols = kinds.length;
  const rows = cols > 0 ? kinds[0].length : 0;
  const out: string[] = [];
  for (let r = 0; r < rows; r++) {
    const k0 = kinds[0][r];
    if (cols > 1 && k0 !== 'glass' && kinds.every(col => col[r] === k0)) {
      out.push(`*:${r}=${k0}`);
      continue;
    }
    for (let c = 0; c < cols; c++) if (kinds[c][r] !== 'glass') out.push(`${c}:${r}=${kinds[c][r]}`);
  }
  return out.join(';');
}

export const isDoorKind = (k: PanelKind) => k === 'door' || k === 'double_door';

// ─── Grid ────────────────────────────────────────────────────────────────────

export interface CurtainGrid {
  /** Column boundaries along the wall: 0, interior lines…, length. */
  xs: number[];
  /** Row boundaries above the base: 0, interior lines…, height. */
  ys: number[];
  /** `[col][row]`. */
  kinds: PanelKind[][];
  /** Grid lines come from `v_grids` / `u_grids` (else derived). */
  explicitV: boolean;
  explicitU: boolean;
}

export function curtainGrid(attrs: Record<string, string>, length: number, height: number): CurtainGrid {
  const xs = [0, ...gridLines(attrs.v_grids, attrs.v_grid_count, attrs.v_spacing, length), length];
  const ys = [0, ...gridLines(attrs.u_grids, attrs.u_grid_count, attrs.u_spacing, height), height];
  return {
    xs, ys,
    kinds: cellKinds(parsePanels(attrs.panels), xs.length - 1, ys.length - 1),
    explicitV: (attrs.v_grids ?? '').trim() !== '',
    explicitU: (attrs.u_grids ?? '').trim() !== '',
  };
}

// ─── Grid edits (attr patches) ───────────────────────────────────────────────

const interior = (b: number[]) => b.slice(1, -1);
const transpose = (k: PanelKind[][]) => (k.length === 0 ? [] : k[0].map((_, r) => k.map(col => col[r])));

function linesPatch(axis: GridAxis, lines: number[]): Record<string, string> {
  // No interior line: one cell, which an empty list cannot say (it means "derive").
  return lines.length > 0
    ? { [`${axis}_grids`]: formatNumberList(lines) }
    : { [`${axis}_grids`]: '', [`${axis}_grid_count`]: '1' };
}

/** Kinds as cells along `axis` (outer index), the other axis inner. */
const alongAxis = (g: CurtainGrid, axis: GridAxis) => (axis === 'v' ? g.kinds : transpose(g.kinds));
const fromAxis = (k: PanelKind[][], axis: GridAxis) => (axis === 'v' ? k : transpose(k));

/** Add a grid line at `pos`; the split cell's panel kind goes to both halves. */
export function insertGridLine(g: CurtainGrid, axis: GridAxis, pos: number): Record<string, string> | null {
  const b = axis === 'v' ? g.xs : g.ys;
  const k = b.findIndex(x => x > pos) - 1; // cell being split
  if (k < 0 || pos - b[k] < MIN_CELL || b[k + 1] - pos < MIN_CELL) return null;
  const cells = alongAxis(g, axis).map(c => [...c]);
  cells.splice(k + 1, 0, [...cells[k]]);
  return { ...linesPatch(axis, [...interior(b), pos].sort((x, y) => x - y)), panels: formatPanels(fromAxis(cells, axis)) };
}

/** Remove interior line `i` (0-based); the merged cell keeps the kind of the one before it. */
export function removeGridLine(g: CurtainGrid, axis: GridAxis, i: number): Record<string, string> | null {
  const lines = interior(axis === 'v' ? g.xs : g.ys);
  if (i < 0 || i >= lines.length) return null;
  const cells = alongAxis(g, axis).map(c => [...c]);
  cells.splice(i + 1, 1);
  lines.splice(i, 1);
  return { ...linesPatch(axis, lines), panels: formatPanels(fromAxis(cells, axis)) };
}

/** Move interior line `i` to `pos`, kept between its neighbours. */
export function moveGridLine(g: CurtainGrid, axis: GridAxis, i: number, pos: number): Record<string, string> | null {
  const b = axis === 'v' ? g.xs : g.ys;
  if (i < 0 || i >= b.length - 2) return null;
  const lo = b[i] + MIN_CELL, hi = b[i + 2] - MIN_CELL;
  if (hi < lo) return null;
  const lines = interior(b);
  lines[i] = Math.min(hi, Math.max(lo, pos));
  return linesPatch(axis, lines);
}

/** Back to an even grid with the same number of cells (panel overrides keep their cells). */
export function uniformGrid(g: CurtainGrid): Record<string, string> {
  return {
    v_grids: '', u_grids: '',
    v_grid_count: String(g.xs.length - 1), u_grid_count: String(g.ys.length - 1),
  };
}

export function setPanelKinds(g: CurtainGrid, cells: { col: number; row: number }[], kind: PanelKind): Record<string, string> {
  const k = g.kinds.map(c => [...c]);
  for (const { col, row } of cells) if (k[col]?.[row] !== undefined) k[col][row] = kind;
  return { panels: formatPanels(k) };
}

// ─── Members ─────────────────────────────────────────────────────────────────

export interface MullionSpec {
  /** Face width along the wall (diameter when round). */
  width: number;
  /** Depth across the wall. */
  depth: number;
  profile: 'rect' | 'round';
}

export function mullionSpec(attrs: Record<string, string>): MullionSpec {
  const pos = (v: string | undefined) => { const n = parseFloat(v ?? ''); return n > 0 ? n : DEFAULT_MULLION; };
  return { width: pos(attrs.mullion_width), depth: pos(attrs.mullion_depth), profile: attrs.mullion_profile === 'round' ? 'round' : 'rect' };
}

/** What a wall end gets: its own border mullion, the shared corner post, or nothing (the neighbour owns it). */
export type EndMullion = 'border' | 'corner' | 'none';

export interface CornerPost {
  /** Plan position (the shared endpoint). */
  at: Point;
  baseY: number;
  height: number;
  size: number;
  angle: number;
}

export interface CurtainLayoutInput {
  start: Point;
  length: number;
  angle: number;
  height: number;
  baseY: number;
  grid: CurtainGrid;
  mullion: MullionSpec;
  frameMaterial: string;
  panelMaterial: string;
  solidMaterial: string;
  ends: { start: EndMullion; end: EndMullion };
  corners: CornerPost[];
}

/**
 * One member, panel or door of a curtain wall. Box (or cylinder when `round`):
 * plan centre `c`, bottom `z0`, `along` the wall × `across` × `h` high, turned
 * by `angle`. A round mullion is a vertical cylinder of diameter `along`; a
 * round transom lies along the wall, diameter `h`.
 */
export interface CwPiece {
  role: 'mullion' | 'transom' | 'panel' | 'door';
  index: string;
  c: Point;
  z0: number;
  along: number;
  across: number;
  h: number;
  angle: number;
  round?: boolean;
  material: string;
  kind?: PanelKind;
}

/** Every member and panel, at the positions the 3D view draws (single source for 3D, IFC and glTF). */
export function curtainWallPieces(f: CurtainLayoutInput): CwPiece[] {
  const { xs, ys, kinds } = f.grid;
  const { width: mw, depth: md, profile } = f.mullion;
  const ux = Math.cos(f.angle), uy = Math.sin(f.angle);
  const at = (t: number): Point => ({ x: f.start.x + ux * t, y: f.start.y + uy * t });
  const cols = xs.length - 1, rows = ys.length - 1;
  const out: CwPiece[] = [];

  // Vertical mullions (border ones at the wall ends unless a corner post takes over).
  for (let i = 0; i <= cols; i++) {
    const end = i === 0 ? f.ends.start : i === cols ? f.ends.end : null;
    if (end === 'none' || end === 'corner') continue;
    out.push({
      role: 'mullion', index: `${i}`, c: at(xs[i]), z0: f.baseY, along: mw, across: md, h: f.height,
      angle: f.angle, round: end === null && profile === 'round', material: f.frameMaterial,
    });
  }
  for (const [k, p] of f.corners.entries()) {
    out.push({
      role: 'mullion', index: `corner${k}`, c: p.at, z0: p.baseY, along: p.size, across: p.size, h: p.height,
      angle: p.angle, material: f.frameMaterial,
    });
  }

  // Transoms per grid line, in runs that skip the bottom of door cells.
  for (let j = 0; j <= rows; j++) {
    const border = j === 0 || j === rows;
    let runStart = -1;
    for (let i = 0; i <= cols; i++) {
      const keep = i < cols && !(j < rows && isDoorKind(kinds[i][j]));
      if (keep && runStart < 0) runStart = i;
      if (!keep && runStart >= 0) {
        const t0 = xs[runStart], t1 = xs[i];
        out.push({
          role: 'transom', index: runStart === 0 && i === cols ? `${j}` : `${j}_${runStart}`,
          c: at((t0 + t1) / 2), z0: f.baseY + ys[j] - mw / 2, along: t1 - t0, across: md, h: mw,
          angle: f.angle, round: !border && profile === 'round', material: f.frameMaterial,
        });
        runStart = -1;
      }
    }
  }

  // Panels and doors per cell.
  for (let i = 0; i < cols; i++) {
    const cw = xs[i + 1] - xs[i];
    const c = at((xs[i] + xs[i + 1]) / 2);
    for (let j = 0; j < rows; j++) {
      const kind = kinds[i][j];
      const ch = ys[j + 1] - ys[j];
      if (kind === 'empty') continue;
      if (isDoorKind(kind)) {
        // No transom under a door: the leaf runs from the cell bottom to under the head.
        const h = ch - mw / 2;
        const w = cw - mw;
        if (w > 0.1 && h > 0.1) {
          out.push({
            role: 'door', index: `${i}_${j}`, c, z0: f.baseY + ys[j], along: w, across: md, h,
            angle: f.angle, material: f.panelMaterial, kind,
          });
        }
        continue;
      }
      const pw = cw - mw, ph = ch - mw;
      if (pw <= 0.01 || ph <= 0.01) continue;
      const solid = kind === 'solid';
      out.push({
        role: 'panel', index: `${i}_${j}`, c, z0: f.baseY + ys[j] + (ch - ph) / 2,
        along: pw, across: solid ? Math.min(Math.max(md * 0.5, 0.012), 0.03) : GLASS_THICKNESS, h: ph,
        angle: f.angle, material: solid ? f.solidMaterial : f.panelMaterial, kind,
      });
    }
  }
  return out;
}

// ─── Plan ────────────────────────────────────────────────────────────────────

/** Along-wall stretches of the plan glazing strip: bottom-row door cells stay open. */
export function planStripRuns(g: CurtainGrid): [number, number][] {
  const runs: [number, number][] = [];
  const cols = g.xs.length - 1;
  for (let i = 0; i < cols;) {
    if (isDoorKind(g.kinds[i][0])) { i++; continue; }
    let j = i;
    while (j + 1 < cols && !isDoorKind(g.kinds[j + 1][0])) j++;
    runs.push([g.xs[i], g.xs[j + 1]]);
    i = j + 1;
  }
  return runs;
}

export interface DoorSwing {
  hinge: Point;
  /** Open leaf tip (90° to the wall's left). */
  tip: Point;
  /** Quarter arc from the open tip back to the closed position. */
  arc: Point[];
}

/** Plan swings of the bottom-row door cells: hinged on the cell's start side (both sides for a double door). */
export function doorSwings(f: Pick<CurtainLayoutInput, 'start' | 'angle' | 'grid' | 'mullion'>): DoorSwing[] {
  const { xs, kinds } = f.grid;
  const mw = f.mullion.width;
  const u = { x: Math.cos(f.angle), y: Math.sin(f.angle) };
  const n = { x: -u.y, y: u.x };
  const at = (t: number, s = 0): Point => ({ x: f.start.x + u.x * t + n.x * s, y: f.start.y + u.y * t + n.y * s });
  const out: DoorSwing[] = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const kind = kinds[i][0];
    if (!isDoorKind(kind)) continue;
    const a = xs[i] + mw / 2, b = xs[i + 1] - mw / 2;
    if (b - a < 0.1) continue;
    const leaves = kind === 'double_door'
      ? [{ hinge: a, dir: 1, l: (b - a) / 2 }, { hinge: b, dir: -1, l: (b - a) / 2 }]
      : [{ hinge: a, dir: 1, l: b - a }];
    for (const lf of leaves) {
      const arc: Point[] = [];
      for (let k = 0; k <= 12; k++) {
        const th = (Math.PI / 2) * (1 - k / 12);
        arc.push(at(lf.hinge + lf.dir * lf.l * Math.cos(th), lf.l * Math.sin(th)));
      }
      out.push({ hinge: at(lf.hinge), tip: arc[0], arc });
    }
  }
  return out;
}

// ─── Corners ─────────────────────────────────────────────────────────────────

const JOIN_TOL = 0.01;

export interface CornerWall {
  id: string;
  start: Point;
  end: Point;
  baseY: number;
  height: number;
  mullion: MullionSpec;
}

export interface CornerResult {
  ends: { start: EndMullion; end: EndMullion };
  corners: CornerPost[];
}

/**
 * Where two curtain walls share an endpoint (any angle), the one with the
 * smaller id draws a single square corner post spanning both walls' heights;
 * the other draws no end mullion there.
 */
export function curtainCorners(walls: CornerWall[]): Map<string, CornerResult> {
  const out = new Map<string, CornerResult>();
  for (const w of walls) out.set(w.id, { ends: { start: 'border', end: 'border' }, corners: [] });
  const near = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y) < JOIN_TOL;
  for (const a of walls) {
    for (const side of ['start', 'end'] as const) {
      const p = a[side];
      const mates: { w: CornerWall; side: 'start' | 'end' }[] = [];
      for (const b of walls) {
        if (b.id === a.id) continue;
        if (near(b.start, p)) mates.push({ w: b, side: 'start' });
        else if (near(b.end, p)) mates.push({ w: b, side: 'end' });
      }
      if (mates.length === 0) continue;
      const owner = [a, ...mates.map(m => m.w)].reduce((x, y) => (y.id < x.id ? y : x));
      if (owner.id !== a.id) { out.get(a.id)!.ends[side] = 'none'; continue; }
      out.get(a.id)!.ends[side] = 'corner';
      const all = [a, ...mates.map(m => m.w)];
      const z0 = Math.min(...all.map(w => w.baseY));
      const z1 = Math.max(...all.map(w => w.baseY + w.height));
      out.get(a.id)!.corners.push({
        at: p, baseY: z0, height: z1 - z0,
        size: Math.max(...all.map(w => Math.max(w.mullion.width, w.mullion.depth))),
        angle: Math.atan2(a.end.y - a.start.y, a.end.x - a.start.x),
      });
    }
  }
  return out;
}
