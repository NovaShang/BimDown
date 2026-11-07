/**
 * Sheet composition: a sheet (title block + placed viewports) as drawing
 * items in paper millimetres, Y up, origin at the paper's bottom-left — the
 * same item model as plans and sections, so one composition feeds the PDF
 * sheet set, the per-sheet DXF (1:1 mm, plot-ready) and the on-screen sheet
 * editor (which draws each viewport's model-space drawing under a transform,
 * so moving a viewport never re-renders it).
 *
 * Viewports: plans (any level, per discipline, with section marks that name
 * the sheet each section is placed on), sections and elevations (vector line
 * work from drawing/section.ts), schedule tables and a symbol legend. Each
 * gets a Revit-style title: detail number, name, scale. Annotation sizes are
 * paper sizes, so dimensions and notes read the same at 1:50 and 1:200.
 */
import type { CanonicalElement, Point } from '../../model/elements.ts';
import type { GridData, ProjectData } from '../../types.ts';
import { LAYER_STYLES } from '../../types.ts';
import type { SheetDef, ViewportDef, SheetSet } from '../../sheets/sheetTypes.ts';
import { SHEET_PAPERS } from '../../sheets/sheetTypes.ts';
import { SCHEDULES, scheduleRows, sortRows, totalsOf, formatCell, unitSuffix, scheduleGroups, columnDigits } from '../../schedule/schedules.ts';
import { getProjectUnits } from '../../utils/units.ts';
import { sectionFrame } from '../../views/viewGeometry.ts';
import { collectPlan, renderPlan, approxTextWidth, itemsBounds, isoDate, paperMm, type PlanSource } from './plan.ts';
import { collectViewSource, renderView, type ViewSource } from './section.ts';
import { drawingLabel, type DrawingLang } from './labels.ts';
import { LAYERS, type DrawingLayer } from './layers.ts';
import type { Box, DrawItem, LegendEntry, ScaledDrawing } from './types.ts';

// ─── Layers of the sheet itself ─────────────────────────────────────────────

const L = (name: string, color: string, aci: number, weight: number, description: string): DrawingLayer =>
  ({ name, color, aci, weight, dash: 'solid', description });

export const SHEET_LAYERS = {
  frame:  L('G-ANNO-TTLB',      '#000000', 7, 0.5,  'Sheet border and title block'),
  tbLine: L('G-ANNO-TTLB-LINE', '#000000', 7, 0.18, 'Title block cells'),
  tbText: L('G-ANNO-TTLB-TEXT', '#1a1a1a', 7, 0.18, 'Title block text'),
  vpTitle: L('G-ANNO-TITL',     '#000000', 7, 0.35, 'View titles'),
  table:  L('G-ANNO-SCHD',      '#1a1a1a', 7, 0.13, 'Schedules'),
  legend: L('G-ANNO-LEGN',      '#1a1a1a', 7, 0.18, 'Legend'),
  secMark: L('A-SECT-IDEN',     '#000000', 7, 0.35, 'Section marks'),
} satisfies Record<string, DrawingLayer>;

export interface Rect { x: number; y: number; w: number; h: number }

// ─── Geometry of a sheet ────────────────────────────────────────────────────

export interface SheetFrame {
  paper: { w: number; h: number };
  /** Border (Y up, bottom-left corner). */
  frame: Rect;
  /** Title strip on the right of the frame. */
  strip: Rect;
  /** Where viewports go. */
  area: Rect;
  /** Text size factor. */
  k: number;
}

export function sheetFrame(paper: SheetDef['paper']): SheetFrame {
  const p = SHEET_PAPERS[paper];
  const small = paper === 'A4' || paper === 'A3';
  const left = paper === 'A4' ? 15 : 20, other = paper === 'A4' ? 8 : 10;
  const frame = { x: left, y: other, w: p.w - left - other, h: p.h - 2 * other };
  const k = { A0: 1.3, A1: 1.2, A2: 1.05, A3: 0.9, A4: 0.8 }[paper];
  const sw = { A0: 180, A1: 160, A2: 120, A3: 88, A4: 72 }[paper];
  const strip = { x: frame.x + frame.w - sw, y: frame.y, w: sw, h: frame.h };
  const pad = small ? 5 : 8;
  const area = { x: frame.x + pad, y: frame.y + pad, w: frame.w - sw - 2 * pad, h: frame.h - 2 * pad };
  return { paper: p, frame, strip, area, k };
}

// ─── Item transforms ────────────────────────────────────────────────────────

/** Model → paper: `center` (model) lands on `at` (paper mm), 1 paper mm = `pm` model units. */
export interface PlaceTransform { pm: number; center: Point; at: Point }

export function placePoint(t: PlaceTransform, p: Point): Point {
  return { x: t.at.x + (p.x - t.center.x) / t.pm, y: t.at.y + (p.y - t.center.y) / t.pm };
}

export function placeItems(items: DrawItem[], t: PlaceTransform): DrawItem[] {
  const P = (p: Point) => placePoint(t, p);
  return items.map(it => {
    switch (it.kind) {
      case 'path': return { ...it, pts: it.pts.map(P) };
      case 'circle': return { ...it, center: P(it.center), radius: it.radius / t.pm };
      case 'arc': return { ...it, center: P(it.center), radius: it.radius / t.pm };
      case 'text': return { ...it, at: P(it.at), height: it.height / t.pm };
    }
  });
}

// ─── Drawing cache (shared by the editor canvas and the exports) ────────────

export interface ComposeContext {
  project: ProjectData;
  grids: GridData[];
  lang: DrawingLang;
  /** Title block date when a sheet has no issue date. */
  date: Date;
  /** Default the metadata's project_name. */
  projectName?: string;
  /** Live (unsaved) elements of the level open in the editor. */
  live?: { levelId: string; elements: CanonicalElement[] };
}

/**
 * Builds and keeps the model drawings viewports show, per (kind, id, scale,
 * discipline): one per project state. Plans and section meshes are collected
 * once and rendered per scale.
 */
export class SheetDrawings {
  readonly ctx: ComposeContext;
  private readonly planSources = new Map<string, PlanSource | null>();
  private viewSource: ViewSource | null = null;
  private readonly drawings = new Map<string, ScaledDrawing | null>();

  constructor(ctx: ComposeContext) { this.ctx = ctx; }

  private planSource(levelId: string, discipline: ViewportDef['discipline']): PlanSource | null {
    const key = `${levelId}|${discipline}`;
    if (!this.planSources.has(key)) {
      this.planSources.set(key, collectPlan({
        project: this.ctx.project, levelId, grids: this.ctx.grids, discipline, lang: this.ctx.lang,
      }));
    }
    return this.planSources.get(key) ?? null;
  }

  private views(): ViewSource {
    this.viewSource ??= collectViewSource({ project: this.ctx.project, grids: this.ctx.grids, live: this.ctx.live });
    return this.viewSource;
  }

  /**
   * Model drawing of a plan / section / elevation viewport at a scale (null
   * when it has nothing to show). Plans carry section marks that name the
   * sheet each section is placed on (`placements`).
   */
  drawing(vp: Pick<ViewportDef, 'type' | 'levelId' | 'viewId' | 'discipline'>, scale: number, placements: ViewPlacements = new Map()): ScaledDrawing | null {
    const refs = vp.type === 'plan' ? [...placements].map(([k, v]) => `${k}=${v.detail}/${v.sheet}`).join(';') : '';
    const key = `${vp.type}|${vp.levelId}|${vp.viewId}|${vp.discipline}|${scale}|${refs}`;
    if (this.drawings.has(key)) return this.drawings.get(key) ?? null;
    let d: ScaledDrawing | null = null;
    if (vp.type === 'plan') {
      const src = this.planSource(vp.levelId, vp.discipline);
      if (src) {
        const plan = renderPlan(src, scale);
        plan.items.push(...sectionMarkItems(this.ctx.project, plan.pm, placements));
        plan.bounds = itemsBounds(plan.items);
        d = plan.items.some(i => !i.dxfOnly) ? plan : null;
      }
    } else if (vp.type === 'section' || vp.type === 'elevation') {
      d = renderView(this.views(), { kind: vp.type, id: vp.viewId }, scale, { lang: this.ctx.lang });
    }
    this.drawings.set(key, d);
    return d;
  }

  /** Largest common scale (smallest denominator) at which the view fits `area` (paper mm). */
  fitScale(vp: Pick<ViewportDef, 'type' | 'levelId' | 'viewId' | 'discipline'>, area: { w: number; h: number }): number {
    for (const s of [20, 50, 100, 200, 500, 1000, 2000]) {
      const d = this.drawing(vp, s);
      if (!d?.bounds) return 100;
      const w = (d.bounds.maxX - d.bounds.minX) / d.pm, h = (d.bounds.maxY - d.bounds.minY) / d.pm;
      if (w <= area.w && h <= area.h) return s;
    }
    return 2000;
  }
}

// ─── Section marks on plans ─────────────────────────────────────────────────

/** Where each section / elevation is placed: detail number + sheet number (for marks and titles). */
export type ViewPlacements = Map<string, { detail: number; sheet: string }>;

/** Detail numbers: a viewport's 1-based index among the model views of its sheet. */
export function viewPlacements(set: SheetSet): ViewPlacements {
  const out: ViewPlacements = new Map();
  for (const sheet of set.sheets) {
    let n = 0;
    for (const vp of set.viewports) {
      if (vp.sheetId !== sheet.id || (vp.type !== 'plan' && vp.type !== 'section' && vp.type !== 'elevation')) continue;
      n++;
      const key = vp.type === 'plan' ? `plan:${vp.levelId}` : vp.viewId;
      if (!out.has(key)) out.set(key, { detail: n, sheet: sheet.number });
    }
  }
  return out;
}

/** Section lines with heads (name over the sheet reference) and view-direction arrows, model units. */
function sectionMarkItems(project: ProjectData, pm: number, placements: ViewPlacements): DrawItem[] {
  const out: DrawItem[] = [];
  const layer = SHEET_LAYERS.secMark.name;
  for (const s of project.sections ?? []) {
    const f = sectionFrame(s.start, s.end);
    if (!f) continue;
    const r = 4 * pm;
    const u = f.right, d = f.dir;
    out.push({ kind: 'path', layer, pts: [s.start, s.end], closed: false, weight: 0.18, dash: 'center' });
    const ref = placements.get(s.id);
    for (const [p, sign] of [[s.start, -1], [s.end, 1]] as const) {
      // Heavy stub along the line, head beyond the end, arrow on the viewing side
      const stub = { x: p.x - u.x * sign * 6 * pm, y: p.y - u.y * sign * 6 * pm };
      out.push({ kind: 'path', layer, pts: [stub, p], closed: false, weight: 0.5 });
      const c = { x: p.x + u.x * sign * r, y: p.y + u.y * sign * r };
      const tip = { x: c.x + d.x * r * 1.9, y: c.y + d.y * r * 1.9 };
      const b1 = { x: c.x + u.x * r * 0.95, y: c.y + u.y * r * 0.95 };
      const b2 = { x: c.x - u.x * r * 0.95, y: c.y - u.y * r * 0.95 };
      out.push({ kind: 'path', layer, pts: [b1, tip, b2], closed: true, fill: '#000000', noStroke: true });
      out.push({ kind: 'circle', layer, center: c, radius: r, fill: '#ffffff' });
      if (ref) {
        out.push({ kind: 'path', layer, pts: [{ x: c.x - r, y: c.y }, { x: c.x + r, y: c.y }], closed: false, weight: 0.18 });
        out.push({ kind: 'text', layer, at: { x: c.x, y: c.y + r * 0.45 }, text: s.name || s.id, height: 2.2 * pm, align: 'center', valign: 'middle', bold: true });
        out.push({ kind: 'text', layer, at: { x: c.x, y: c.y - r * 0.45 }, text: ref.sheet, height: 1.6 * pm, align: 'center', valign: 'middle' });
      } else {
        out.push({ kind: 'text', layer, at: c, text: s.name || s.id, height: 2.8 * pm, align: 'center', valign: 'middle', bold: true });
      }
    }
  }
  return out;
}

// ─── Text helpers ───────────────────────────────────────────────────────────

/** Greedy word wrap (CJK breaks anywhere) by the approximate glyph widths. */
export function wrapText(text: string, height: number, maxW: number, maxLines = 3): string[] {
  const tokens = text.split(/(\s+|(?<=[⺀-￿]))/).filter(t => t && t.trim() !== '' || t === ' ');
  const lines: string[] = [];
  let cur = '';
  for (const tok of tokens) {
    const next = cur ? (/[⺀-￿]$/.test(cur) || /^[⺀-￿]/.test(tok) ? cur + tok.trim() : `${cur} ${tok.trim()}`) : tok.trim();
    if (!tok.trim()) continue;
    if (approxTextWidth(next, height) > maxW && cur) {
      lines.push(cur);
      cur = tok.trim();
      if (lines.length === maxLines - 1) break;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, maxLines);
}

class Paper {
  readonly items: DrawItem[] = [];
  readonly layers = new Map<string, DrawingLayer>();
  layer(def: DrawingLayer): string {
    if (!this.layers.has(def.name)) this.layers.set(def.name, def);
    return def.name;
  }
  line(def: DrawingLayer, a: Point, b: Point, weight?: number) {
    this.items.push({ kind: 'path', layer: this.layer(def), pts: [a, b], closed: false, ...(weight ? { weight } : {}) });
  }
  rect(def: DrawingLayer, r: Rect, o: { weight?: number; fill?: string; noStroke?: boolean } = {}) {
    this.items.push({
      kind: 'path', layer: this.layer(def), closed: true,
      pts: [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }],
      ...(o.weight ? { weight: o.weight } : {}), ...(o.fill ? { fill: o.fill } : {}), ...(o.noStroke ? { noStroke: true } : {}),
    });
  }
  text(def: DrawingLayer, at: Point, text: string, height: number, o: { align?: 'left' | 'center' | 'right'; bold?: boolean; color?: string; valign?: 'baseline' | 'middle'; maxW?: number } = {}) {
    if (!text) return;
    let h = height;
    if (o.maxW) { const w = approxTextWidth(text, h); if (w > o.maxW) h *= o.maxW / w; }
    this.items.push({
      kind: 'text', layer: this.layer(def), at, text, height: h, align: o.align ?? 'left', valign: o.valign ?? 'baseline',
      ...(o.bold ? { bold: true } : {}), ...(o.color ? { color: o.color } : {}),
    });
  }
}

// ─── Composed sheet ─────────────────────────────────────────────────────────

export interface PlacedViewport {
  vp: ViewportDef;
  /** Model drawing (plans / sections / elevations), null for tables and legends or empty views. */
  drawing: ScaledDrawing | null;
  /** Model → paper (drawings only). */
  transform: PlaceTransform | null;
  /** Paper items of tables / legends (already placed). */
  paperItems: DrawItem[];
  paperLayers: Map<string, DrawingLayer>;
  /** Paper extent of the view (without its title), Y up. */
  rect: Rect;
  /** Title under the view: detail number, name, scale (paper items). */
  titleItems: DrawItem[];
  title: string;
  detail: number;
}

export interface ComposedSheet {
  sheet: SheetDef;
  frame: SheetFrame;
  /** Border and title block (paper items). */
  items: DrawItem[];
  layers: Map<string, DrawingLayer>;
  viewports: PlacedViewport[];
}

function boxToRect(b: Box): Rect { return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY }; }

function viewName(vp: ViewportDef, d: ScaledDrawing | null, ctx: ComposeContext): string {
  if (vp.title) return vp.title;
  const lang = ctx.lang;
  switch (vp.type) {
    case 'plan': {
      const lv = ctx.project.levels.find(l => l.id === vp.levelId);
      const name = lv?.name || vp.levelId;
      return drawingLabel(lang, `drawing.title.${vp.discipline}`, { level: lang === 'zh' && /[A-Za-z0-9]$/.test(name) ? `${name} ` : name });
    }
    case 'section': case 'elevation':
      return (d as { title?: string } | null)?.title ?? vp.viewId;
    case 'schedule': {
      const cat = SCHEDULES.find(c => c.key === vp.schedule);
      return cat ? drawingLabel(lang, 'drawing.scheduleOf', { name: drawingLabel(lang, cat.label) }) : vp.schedule;
    }
    case 'legend':
      return drawingLabel(lang, 'drawing.legend');
  }
}

/** Title under a viewport: number bubble, bold name with a double underline, scale under it. */
function titleBlockOf(rect: Rect, detail: number, title: string, scaleText: string, k: number): Paper {
  const p = new Paper();
  const def = SHEET_LAYERS.vpTitle;
  const r = 3.6 * k;
  const y = rect.y - 4 * k - r;
  const cx = rect.x + r;
  p.items.push({ kind: 'circle', layer: p.layer(def), center: { x: cx, y }, radius: r, weight: 0.25 });
  p.text(def, { x: cx, y }, String(detail), 3 * k, { align: 'center', valign: 'middle', bold: true });
  const tx = cx + r + 2.5 * k;
  const th = 3.4 * k;
  p.text(def, { x: tx, y: y + 0.6 * k }, title, th, { bold: true, maxW: Math.max(rect.w - (tx - rect.x), 60 * k) });
  const w = Math.min(Math.max(approxTextWidth(title, th) + 6 * k, 40 * k), Math.max(rect.w - (tx - rect.x), 60 * k) + 6 * k);
  p.line(def, { x: tx, y: y - 0.9 * k }, { x: tx + w, y: y - 0.9 * k }, 0.5);
  p.line(def, { x: tx, y: y - 1.7 * k }, { x: tx + w, y: y - 1.7 * k }, 0.18);
  if (scaleText) p.text(def, { x: tx, y: y - 5.2 * k }, scaleText, 2.4 * k);
  return p;
}

/** Schedule table (paper mm) centred on `at`. */
function scheduleTable(vp: ViewportDef, ctx: ComposeContext, k: number): Paper {
  const p = new Paper();
  const cat = SCHEDULES.find(c => c.key === vp.schedule);
  if (!cat) return p;
  const { lang, project } = ctx;
  const unit = getProjectUnits({ project });
  const displayName = (table: string) => {
    const s = LAYER_STYLES[table];
    return s ? drawingLabel(lang, `display.${s.displayName}`) : table;
  };
  let rows = sortRows(scheduleRows(cat, project, unit, displayName, ctx.live?.levelId, ctx.live ? new Map(ctx.live.elements.map(e => [e.id, e])) : undefined, lang),
    { key: cat.columns.some(c => c.key === 'number') ? 'number' : cat.columns[0].key, dir: 1 });
  // Printed door / window schedules list types (one row per mark and size, with a count);
  // other schedules list every element. Host ids mean nothing on paper.
  const byType = vp.schedule === 'doors' || vp.schedule === 'windows';
  const columns = cat.columns.filter(c => c.key !== 'host_id' && (byType ? c.key !== 'level' && (c.defaultOn !== false || c.key === 'count') : c.defaultOn !== false));
  const header = columns.map(c => {
    const u = unitSuffix(c.kind, unit);
    return u ? `${drawingLabel(lang, c.label)} (${u})` : drawingLabel(lang, c.label);
  });
  // Aggregated schedules (MEP runs) print one row per group, like the Schedule view
  if (cat.itemize === false && cat.groupBy) rows = scheduleGroups(rows, columns, cat.groupBy, null, false)[0].rows;
  let cells = rows.map(r => columns.map(c => formatCell(r.values[c.key], c.kind, unit, columnDigits(c, unit))));
  const totals = totalsOf(rows, columns);
  if (byType) {
    const ci = columns.findIndex(c => c.key === 'count');
    const groups = new Map<string, string[]>();
    for (const row of cells) {
      const key = row.filter((_, i) => i !== ci).join('\u0000');
      const g = groups.get(key);
      if (g) g[ci] = String(Number(g[ci]) + 1);
      else groups.set(key, [...row]);
    }
    cells = [...groups.values()];
  }
  const th = 2.0 * k, rowH = 5.2 * k, pad = 1.6 * k;
  const totalRow = columns.map((c, i) => (i === 0 ? drawingLabel(lang, 'schedule.total') : c.total ? formatCell(totals[c.key], c.kind, unit, columnDigits(c, unit)) : ''));
  const widths = columns.map((_, i) => Math.min(70 * k, Math.max(
    approxTextWidth(header[i], th) * 1.05, ...cells.map(r => approxTextWidth(r[i], th)), approxTextWidth(totalRow[i], th),
  ) + 2 * pad));
  const W = widths.reduce((a, b) => a + b, 0);
  const nRows = cells.length + 2; // header + rows + total
  const H = nRows * rowH;
  const x0 = vp.x - W / 2, top = vp.y + H / 2;
  const def = SHEET_LAYERS.table;
  p.rect(def, { x: x0, y: top - H, w: W, h: H }, { weight: 0.35 });
  p.rect(def, { x: x0, y: top - rowH, w: W, h: rowH }, { fill: '#e8e8e8', noStroke: true });
  p.line(def, { x: x0, y: top - rowH }, { x: x0 + W, y: top - rowH }, 0.35);
  p.line(def, { x: x0, y: top - H + rowH }, { x: x0 + W, y: top - H + rowH }, 0.25);
  for (let i = 2; i < nRows - 1; i++) p.line(def, { x: x0, y: top - i * rowH }, { x: x0 + W, y: top - i * rowH });
  let x = x0;
  const numeric = columns.map(c => c.kind !== 'text');
  widths.forEach((w, i) => {
    if (i > 0) p.line(def, { x, y: top }, { x, y: top - H });
    const write = (row: number, text: string, bold = false) => {
      const y = top - (row + 0.5) * rowH;
      const right = numeric[i] && row > 0;
      p.text(def, { x: right ? x + w - pad : x + pad, y }, text, th, { valign: 'middle', align: right ? 'right' : 'left', bold, maxW: w - 2 * pad });
    };
    write(0, header[i], true);
    cells.forEach((r, j) => write(j + 1, r[i]));
    write(nRows - 1, totalRow[i], true);
    x += w;
  });
  if (!cells.length) p.text(def, { x: x0 + pad, y: top - 1.5 * rowH }, drawingLabel(lang, 'drawing.noRows'), th, { valign: 'middle', color: '#777777' });
  return p;
}

/** Symbol legend (paper mm) centred on `at`; MEP systems of the sheet's plans appended. */
function legendTable(vp: ViewportDef, lang: DrawingLang, systems: LegendEntry[], k: number): Paper {
  const p = new Paper();
  const def = SHEET_LAYERS.legend;
  const rowH = 7 * k, sw = 14 * k, th = 2.2 * k;
  const entries: { label: string; draw: (x: number, y: number) => void }[] = [];
  const box = (x: number, y: number, fill: string) => p.rect(def, { x, y: y - 2 * k, w: sw, h: 4 * k }, { fill, weight: 0.35 });
  entries.push({ label: drawingLabel(lang, 'drawing.legendWall'), draw: (x, y) => box(x, y, '#4d4d4d') });
  entries.push({ label: drawingLabel(lang, 'drawing.legendStructure'), draw: (x, y) => box(x, y, '#1f1f1f') });
  entries.push({ label: drawingLabel(lang, 'drawing.legendBeyond'), draw: (x, y) => p.line(def, { x, y }, { x: x + sw, y }, 0.18) });
  entries.push({
    label: drawingLabel(lang, 'drawing.legendDoor'), draw: (x, y) => {
      const r = 3.6 * k;
      p.line(def, { x, y: y - 2 * k }, { x: x + sw, y: y - 2 * k }, 0.35);
      p.items.push({ kind: 'arc', layer: p.layer(def), center: { x: x + 3 * k, y: y - 2 * k }, radius: r, start: 0, end: Math.PI / 2, weight: 0.13 });
      p.line(def, { x: x + 3 * k, y: y - 2 * k }, { x: x + 3 * k, y: y - 2 * k + r }, 0.25);
    },
  });
  entries.push({
    label: drawingLabel(lang, 'drawing.legendWindow'), draw: (x, y) => {
      p.rect(def, { x, y: y - 1.5 * k, w: sw, h: 3 * k }, { weight: 0.18 });
      p.line(def, { x, y: y - 0.5 * k }, { x: x + sw, y: y - 0.5 * k }, 0.13);
      p.line(def, { x, y: y + 0.5 * k }, { x: x + sw, y: y + 0.5 * k }, 0.13);
    },
  });
  entries.push({
    label: drawingLabel(lang, 'drawing.legendGrid'), draw: (x, y) => {
      const r = 2.6 * k;
      p.items.push({ kind: 'path', layer: p.layer(LAYERS.grid), pts: [{ x, y }, { x: x + sw - 2 * r, y }], closed: false });
      p.items.push({ kind: 'circle', layer: p.layer(LAYERS.gridIden), center: { x: x + sw - r, y }, radius: r, fill: '#ffffff' });
      p.text(LAYERS.gridIden, { x: x + sw - r, y }, 'A', 2 * k, { align: 'center', valign: 'middle', bold: true });
    },
  });
  entries.push({
    label: drawingLabel(lang, 'drawing.legendLevel'), draw: (x, y) => {
      const w = 1.4 * k, h = 2 * k, xe = x + sw * 0.55;
      p.items.push({ kind: 'path', layer: p.layer(def), pts: [{ x, y: y - h / 2 }, { x: x + sw, y: y - h / 2 }], closed: false, dash: 'center', weight: 0.13 });
      p.items.push({ kind: 'path', layer: p.layer(def), pts: [{ x: xe, y: y - h / 2 }, { x: xe - w, y: y + h / 2 }, { x: xe + w, y: y + h / 2 }], closed: true });
    },
  });
  entries.push({
    label: drawingLabel(lang, 'drawing.legendSection'), draw: (x, y) => {
      const r = 2.6 * k, c = { x: x + sw - r, y };
      p.line(SHEET_LAYERS.secMark, { x, y }, { x: c.x - r, y }, 0.5);
      p.items.push({ kind: 'path', layer: p.layer(SHEET_LAYERS.secMark), pts: [{ x: c.x - r * 0.95, y }, { x: c.x, y: c.y + r * 1.9 }, { x: c.x + r * 0.95, y }], closed: true, fill: '#000000', noStroke: true });
      p.items.push({ kind: 'circle', layer: p.layer(SHEET_LAYERS.secMark), center: c, radius: r, fill: '#ffffff' });
      p.text(SHEET_LAYERS.secMark, c, 'A', 2 * k, { align: 'center', valign: 'middle', bold: true });
    },
  });
  for (const s of systems) {
    entries.push({ label: s.label, draw: (x, y) => p.items.push({ kind: 'path', layer: p.layer(def), pts: [{ x, y }, { x: x + sw, y }], closed: false, color: s.color, weight: 0.7 }) });
  }
  const labelW = Math.max(...entries.map(e => approxTextWidth(e.label, th))) + 4 * k;
  const W = sw + 4 * k + labelW, H = entries.length * rowH;
  const x0 = vp.x - W / 2, top = vp.y + H / 2;
  entries.forEach((e, i) => {
    const y = top - (i + 0.5) * rowH;
    e.draw(x0, y);
    p.text(def, { x: x0 + sw + 4 * k, y }, e.label, th, { valign: 'middle' });
  });
  return p;
}

/** Title block strip: revision, project, client, address, sheet name, scale / date / drawn / checked, number, north arrow, brand. */
function titleStrip(sheet: SheetDef, F: SheetFrame, ctx: ComposeContext, scaleText: string): Paper {
  const p = new Paper();
  const { k, strip: S } = F;
  const lang = ctx.lang;
  const meta = ctx.project.metadata;
  const lab = (key: string) => drawingLabel(lang, key);
  const line = SHEET_LAYERS.tbLine, text = SHEET_LAYERS.tbText, frame = SHEET_LAYERS.frame;
  const pad = 2.2 * k, capH = 1.7 * k, grey = '#666666';
  const x0 = S.x, x1 = S.x + S.w, inner = S.w - 2 * pad;
  p.line(frame, { x: x0, y: S.y }, { x: x0, y: S.y + S.h }, 0.5);
  const caption = (x: number, yTop: number, s: string) => p.text(text, { x: x + pad, y: yTop - pad - capH }, s, capH, { color: grey });
  // Cells stacked from the bottom
  let y = S.y;
  const cell = (h: number, fill: (yb: number, yt: number) => void) => {
    fill(y, y + h);
    y += h;
    p.line(line, { x: x0, y }, { x: x1, y }, 0.25);
  };
  // Brand + north arrow
  cell(24 * k, (yb, yt) => {
    const r = 7 * k, cx = x0 + pad + r + 1 * k, cy = (yb + yt) / 2 - 1.5 * k;
    p.items.push({ kind: 'circle', layer: p.layer(text), center: { x: cx, y: cy }, radius: r, weight: 0.25 });
    p.items.push({ kind: 'path', layer: p.layer(text), pts: [{ x: cx, y: cy + r * 0.95 }, { x: cx, y: cy - r * 0.55 }, { x: cx - r * 0.45, y: cy - r * 0.8 }], closed: true, fill: '#1a1a1a', noStroke: true });
    p.items.push({ kind: 'path', layer: p.layer(text), pts: [{ x: cx, y: cy + r * 0.95 }, { x: cx, y: cy - r * 0.55 }, { x: cx + r * 0.45, y: cy - r * 0.8 }], closed: true, fill: '#ffffff', weight: 0.18 });
    p.text(text, { x: cx, y: cy + r + 1.4 * k }, lab('drawing.north'), 2.2 * k, { align: 'center', bold: true });
    const bx = x1 - pad;
    p.text(text, { x: bx, y: yb + 13 * k }, 'BimDown', 3.6 * k, { align: 'right', bold: true, color: '#111111' });
    p.text(text, { x: bx, y: yb + 8.6 * k }, 'bim.jouledown.com', 1.7 * k, { align: 'right', color: '#555555' });
    p.text(text, { x: bx, y: yb + 4.6 * k }, lab('drawing.generatedBy'), 1.5 * k, { align: 'right', color: '#888888' });
  });
  // Sheet number
  cell(20 * k, (_yb, yt) => {
    caption(x0, yt, lab('drawing.sheetNumber'));
    p.text(text, { x: x0 + pad, y: yt - 15 * k }, sheet.number, 8 * k, { bold: true, maxW: inner });
  });
  // Scale | Date, Drawn | Checked
  const half = S.w / 2;
  const pair = (h: number, a: [string, string], b: [string, string]) => cell(h, (yb, yt) => {
    p.line(line, { x: x0 + half, y: yb }, { x: x0 + half, y: yt });
    caption(x0, yt, a[0]);
    caption(x0 + half, yt, b[0]);
    p.text(text, { x: x0 + pad, y: yb + pad + 0.6 * k }, a[1], 2.8 * k, { maxW: half - 2 * pad });
    p.text(text, { x: x0 + half + pad, y: yb + pad + 0.6 * k }, b[1], 2.8 * k, { maxW: half - 2 * pad });
  });
  pair(11 * k, [lab('drawing.drawnBy'), sheet.drawnBy], [lab('drawing.checkedBy'), sheet.checkedBy]);
  pair(11 * k, [lab('drawing.scale'), scaleText], [lab('drawing.date'), sheet.issueDate || isoDate(ctx.date)]);
  // Sheet name
  cell(22 * k, (_yb, yt) => {
    caption(x0, yt, lab('drawing.sheetName'));
    wrapText(sheet.name || sheet.number, 4.2 * k, inner, 2).forEach((l, i) => p.text(text, { x: x0 + pad, y: yt - 10 * k - i * 6 * k }, l, 4.2 * k, { bold: true, maxW: inner }));
  });
  // Project block: name + number, client, address
  const projectName = ctx.projectName || meta.project_name || '';
  cell(34 * k, (_yb, yt) => {
    caption(x0, yt, lab('drawing.project'));
    wrapText(projectName, 4.2 * k, inner, 2).forEach((l, i) => p.text(text, { x: x0 + pad, y: yt - 10 * k - i * 5.8 * k }, l, 4.2 * k, { bold: true, maxW: inner }));
    if (meta.project_number) p.text(text, { x: x0 + pad, y: yt - 27 * k }, `${lab('drawing.projectNumber')} ${meta.project_number}`, 2.4 * k, { maxW: inner });
  });
  cell(12 * k, (_yb, yt) => {
    caption(x0, yt, lab('drawing.client'));
    p.text(text, { x: x0 + pad, y: yt - 9 * k }, meta.client || '', 2.8 * k, { maxW: inner });
  });
  cell(16 * k, (_yb, yt) => {
    caption(x0, yt, lab('drawing.address'));
    wrapText(meta.address || '', 2.4 * k, inner, 2).forEach((l, i) => p.text(text, { x: x0 + pad, y: yt - 8.6 * k - i * 3.6 * k }, l, 2.4 * k, { maxW: inner }));
  });
  // Revision table (header + current revision)
  cell(16 * k, (yb, yt) => {
    const c1 = x0 + 12 * k, c2 = x0 + 34 * k;
    caption(x0, yt, lab('drawing.revision'));
    caption(c1 - pad + 1 * k, yt, lab('drawing.revisionDate'));
    caption(c2 - pad + 1 * k, yt, lab('drawing.revisionNote'));
    p.line(line, { x: x0, y: yt - 5 * k }, { x: x1, y: yt - 5 * k });
    p.line(line, { x: c1, y: yb }, { x: c1, y: yt });
    p.line(line, { x: c2, y: yb }, { x: c2, y: yt });
    const ty = yb + 4.2 * k;
    p.text(text, { x: x0 + pad, y: ty }, sheet.revision, 2.6 * k, { bold: true, maxW: c1 - x0 - 2 * pad });
    p.text(text, { x: c1 + pad, y: ty }, sheet.revisionDate, 2.2 * k, { maxW: c2 - c1 - 2 * pad });
    p.text(text, { x: c2 + pad, y: ty }, sheet.revisionNote, 2.2 * k, { maxW: x1 - c2 - 2 * pad });
  });
  return p;
}

/** Compose one sheet. `drawings` caches the model views (share one per project state). */
export function composeSheet(sheet: SheetDef, set: SheetSet, drawings: SheetDrawings): ComposedSheet {
  const ctx = drawings.ctx;
  const placements = viewPlacements(set);
  const F = sheetFrame(sheet.paper);
  const viewports: PlacedViewport[] = [];
  const systems = new Map<string, LegendEntry>();
  let detail = 0;
  const own = set.viewports.filter(v => v.sheetId === sheet.id);
  for (const vp of own) {
    if (vp.type === 'schedule' || vp.type === 'legend') continue;
    const d = drawings.drawing(vp, vp.scale, placements);
    detail++;
    if (d) for (const l of d.legend) systems.set(l.label, l);
    let rect: Rect = { x: vp.x - 30, y: vp.y - 20, w: 60, h: 40 };
    let transform: PlaceTransform | null = null;
    if (d?.bounds) {
      const center = { x: (d.bounds.minX + d.bounds.maxX) / 2, y: (d.bounds.minY + d.bounds.maxY) / 2 };
      transform = { pm: d.pm, center, at: { x: vp.x, y: vp.y } };
      const w = (d.bounds.maxX - d.bounds.minX) / d.pm, h = (d.bounds.maxY - d.bounds.minY) / d.pm;
      rect = { x: vp.x - w / 2, y: vp.y - h / 2, w, h };
    }
    const title = viewName(vp, d, ctx);
    const t = titleBlockOf(rect, detail, title, `1:${vp.scale}`, F.k);
    viewports.push({ vp, drawing: d, transform, paperItems: [], paperLayers: new Map(), rect, titleItems: t.items, title, detail });
    for (const [n, l] of t.layers) (viewports[viewports.length - 1].paperLayers).set(n, l);
  }
  for (const vp of own) {
    if (vp.type !== 'schedule' && vp.type !== 'legend') continue;
    const p = vp.type === 'schedule' ? scheduleTable(vp, ctx, F.k) : legendTable(vp, ctx.lang, [...systems.values()], F.k);
    const b = itemsBounds(p.items);
    const rect = b ? boxToRect(b) : { x: vp.x - 30, y: vp.y - 10, w: 60, h: 20 };
    const title = viewName(vp, null, ctx);
    // Tables: the title sits above, like a schedule heading
    const tp = new Paper();
    tp.text(SHEET_LAYERS.vpTitle, { x: rect.x, y: rect.y + rect.h + 2.4 * F.k }, title, 3.2 * F.k, { bold: true });
    const layers = new Map([...p.layers, ...tp.layers]);
    viewports.push({ vp, drawing: null, transform: null, paperItems: p.items, paperLayers: layers, rect, titleItems: tp.items, title, detail: 0 });
  }
  // Keep the sheet's viewport order
  viewports.sort((a, b) => own.indexOf(a.vp) - own.indexOf(b.vp));

  const scales = new Set(viewports.filter(v => v.drawing).map(v => v.vp.scale));
  const scaleText = scales.size === 1 ? `1:${[...scales][0]}` : scales.size === 0 ? '' : drawingLabel(ctx.lang, 'drawing.asIndicated');
  const tb = titleStrip(sheet, F, ctx, scaleText);
  const border = new Paper();
  border.rect(SHEET_LAYERS.frame, F.frame, { weight: 0.5 });
  const layers = new Map([...border.layers, ...tb.layers]);
  return { sheet, frame: F, items: [...border.items, ...tb.items], layers, viewports };
}

/** Every item of a composed sheet in paper mm (for PDF / DXF), and the layers they use. */
export function flattenSheet(c: ComposedSheet): { items: DrawItem[]; layers: Map<string, DrawingLayer> } {
  const items: DrawItem[] = [...c.items];
  const layers = new Map(c.layers);
  for (const v of c.viewports) {
    if (v.drawing && v.transform) {
      items.push(...placeItems(v.drawing.items, v.transform));
      for (const [n, l] of v.drawing.layers) layers.set(n, l);
    }
    items.push(...v.paperItems, ...v.titleItems);
    for (const [n, l] of v.paperLayers) layers.set(n, l);
  }
  return { items, layers };
}

/** Every text on a set of sheets (font selection). */
export function sheetTexts(sheets: ComposedSheet[]): string[] {
  const out: string[] = [];
  for (const s of sheets) for (const it of flattenSheet(s).items) if (it.kind === 'text') out.push(it.text);
  return out;
}

/** Model units per paper mm for a unit / scale (re-exported for the sheet editor). */
export { paperMm };
