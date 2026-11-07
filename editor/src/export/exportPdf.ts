/**
 * PDF plan sheets: one page per level at a true scale (1:50 / 1:100 / 1:200,
 * or the largest that fits), ISO A4–A2 landscape with a border, title block,
 * north arrow and scale bar. Graphics come from `drawing/plan.ts`; this file
 * only places them on paper. Text outside Latin-1 (e.g. Chinese room names)
 * switches the sheet to an embedded Noto Sans SC subset, loaded on demand.
 */
import type { jsPDF as JsPdf } from 'jspdf';
import type { ProjectData } from '../types.ts';
import type { Point } from '../model/elements.ts';
import { triggerDownload } from './download.ts';
import { collectPlans, renderPlan, isoDate, type PlanExportOptions } from './drawing/plan.ts';
import { sheetLayout, pickScale, scaleBarStep, type PaperSize, type Rect, type SheetLayout } from './drawing/sheet.ts';
import { drawingLabel, drawingLang, type DrawingLang } from './drawing/labels.ts';
import { tint } from './drawing/color.ts';
import { needsUnicodeFont, loadUnicodeFont, CJK_FONT_FILE, CJK_FONT_NAME, type FontLoader } from './drawing/pdfFont.ts';
import type { LineDash } from './drawing/layers.ts';
import type { DrawItem, PlanDrawing } from './drawing/types.ts';

export interface PdfExportOptions extends PlanExportOptions {
  paper?: PaperSize;
  /** Supplies the CJK font bytes (tests); default fetches the bundled asset. */
  fontLoader?: FontLoader;
}

export interface PdfResult {
  bytes: ArrayBuffer;
  pages: number;
  scale: number;
}

const MM_TO_PT = 72 / 25.4;
/** Cap height as a share of the font size (Helvetica 0.72, Noto Sans SC 0.73). */
const CAP = 0.72;

const DASH_MM: Record<LineDash, number[]> = {
  solid: [],
  dashed: [2.0, 1.0],
  hidden: [1.5, 0.8],
  center: [7, 1.2, 1.2, 1.2],
};

interface Fonts { unicode: boolean }

function face(fonts: Fonts, bold: boolean): [string, string] {
  if (fonts.unicode) return [CJK_FONT_NAME, 'normal'];
  return ['helvetica', bold ? 'bold' : 'normal'];
}

/** Text in sheet units (mm). Bold is faked with a stroke for the single-weight CJK font. */
function sheetText(
  doc: JsPdf, fonts: Fonts, text: string, x: number, y: number,
  o: { size: number; bold?: boolean; align?: 'left' | 'center' | 'right'; color?: string; angleDeg?: number; maxWidth?: number },
) {
  if (!text) return;
  const [name, style] = face(fonts, !!o.bold);
  doc.setFont(name, style);
  let size = o.size;
  doc.setFontSize(size * MM_TO_PT / CAP);
  if (o.maxWidth) {
    const w = doc.getTextWidth(text);
    if (w > o.maxWidth) { size *= o.maxWidth / w; doc.setFontSize(size * MM_TO_PT / CAP); }
  }
  const color = o.color ?? '#1a1a1a';
  doc.setTextColor(color);
  const fakeBold = !!o.bold && fonts.unicode;
  if (fakeBold) { doc.setDrawColor(color); doc.setLineWidth(size * 0.07); }
  const w = doc.getTextWidth(text);
  const a = ((o.angleDeg ?? 0) * Math.PI) / 180;
  const shift = o.align === 'center' ? -w / 2 : o.align === 'right' ? -w : 0;
  doc.text(text, x + Math.cos(a) * shift, y - Math.sin(a) * shift, {
    angle: o.angleDeg || 0,
    renderingMode: fakeBold ? 'fillThenStroke' : 'fill',
  } as Parameters<JsPdf['text']>[3]);
}

// ─── Plan graphics on a page ────────────────────────────────────────────────

class PlanPage {
  private readonly ox: number;
  private readonly oy: number;
  private readonly cx: number;
  private readonly cy: number;
  private readonly pm: number;
  private readonly doc: JsPdf;
  private readonly d: PlanDrawing;
  private readonly fonts: Fonts;

  constructor(doc: JsPdf, d: PlanDrawing, area: Rect, fonts: Fonts) {
    this.doc = doc;
    this.d = d;
    this.fonts = fonts;
    this.pm = d.pm;
    const b = d.bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    this.cx = (b.minX + b.maxX) / 2;
    this.cy = (b.minY + b.maxY) / 2;
    this.ox = area.x + area.w / 2;
    this.oy = area.y + area.h / 2;
  }

  X(p: Point) { return this.ox + (p.x - this.cx) / this.pm; }
  Y(p: Point) { return this.oy - (p.y - this.cy) / this.pm; }

  private pen(it: DrawItem) {
    const layer = this.d.layers.get(it.layer);
    let color = it.color ?? layer?.color ?? '#000000';
    if (it.halftone) color = tint(color, 0.6);
    const weight = it.weight ?? layer?.weight ?? 0.18;
    const dash = it.dash ?? layer?.dash ?? 'solid';
    this.doc.setDrawColor(color);
    this.doc.setLineWidth(weight);
    this.doc.setLineDashPattern(DASH_MM[dash], 0);
  }

  private fillColor(it: DrawItem & { fill?: string }) {
    const fill = it.fill ?? '#ffffff';
    this.doc.setFillColor(it.halftone ? tint(fill, 0.65) : fill);
  }

  draw() {
    const { doc } = this;
    doc.setLineCap('round');
    doc.setLineJoin('round');
    for (const it of this.d.items) {
      if (it.dxfOnly) continue;
      switch (it.kind) {
        case 'path': {
          if (it.pts.length < 2) break;
          const fill = !!it.fill;
          const stroke = !it.noStroke;
          if (!fill && !stroke) break;
          if (stroke) this.pen(it);
          if (fill) this.fillColor(it);
          doc.moveTo(this.X(it.pts[0]), this.Y(it.pts[0]));
          for (let i = 1; i < it.pts.length; i++) doc.lineTo(this.X(it.pts[i]), this.Y(it.pts[i]));
          if (it.closed) doc.close();
          if (fill && stroke) doc.fillStroke();
          else if (fill) doc.fill();
          else doc.stroke();
          break;
        }
        case 'circle': {
          const r = it.radius / this.pm;
          const stroke = !it.noStroke;
          if (stroke) this.pen(it);
          if (it.fill) this.fillColor(it);
          doc.circle(this.X(it.center), this.Y(it.center), r, it.fill ? (stroke ? 'FD' : 'F') : 'S');
          break;
        }
        case 'arc':
          this.pen(it);
          this.arc(it.center, it.radius, it.start, it.end);
          doc.stroke();
          break;
        case 'text': {
          const layer = this.d.layers.get(it.layer);
          let color = it.color ?? layer?.color ?? '#1a1a1a';
          if (it.halftone) color = tint(color, 0.55);
          const hMm = it.height / this.pm;
          const a = it.rotation ?? 0;
          // Anchor → baseline start: the writer centres on the cap height
          const down = it.valign === 'middle' ? hMm / 2 : 0;
          const x = this.X(it.at) + Math.sin(a) * down;
          const y = this.Y(it.at) + Math.cos(a) * down;
          sheetText(doc, this.fonts, it.text, x, y, { size: hMm, bold: it.bold, align: it.align, color, angleDeg: (a * 180) / Math.PI });
          break;
        }
      }
    }
    doc.setLineDashPattern([], 0);
  }

  /** Arc as cubic Béziers (≤ 90° each), built in model space then mapped. */
  private arc(c: Point, r: number, start: number, end: number) {
    let sweep = end - start;
    while (sweep <= 0) sweep += Math.PI * 2;
    const n = Math.max(1, Math.ceil(sweep / (Math.PI / 2) - 1e-9));
    const step = sweep / n;
    const k = (4 / 3) * Math.tan(step / 4);
    const at = (t: number) => ({ x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) });
    const p0 = at(start);
    this.doc.moveTo(this.X(p0), this.Y(p0));
    for (let i = 0; i < n; i++) {
      const a = start + i * step, b = a + step;
      const pa = at(a), pb = at(b);
      const c1 = { x: pa.x - k * r * Math.sin(a), y: pa.y + k * r * Math.cos(a) };
      const c2 = { x: pb.x + k * r * Math.sin(b), y: pb.y - k * r * Math.cos(b) };
      this.doc.curveTo(this.X(c1), this.Y(c1), this.X(c2), this.Y(c2), this.X(pb), this.Y(pb));
    }
  }
}

// ─── Sheet furniture ────────────────────────────────────────────────────────

interface SheetInfo {
  projectName: string;
  drawingTitle: string;
  levelLine: string;
  scale: number;
  metric: boolean;
  unitLabel: string;
  date: string;
  sheet: string;
  lang: DrawingLang;
}

function drawFrame(doc: JsPdf, L: SheetLayout) {
  doc.setLineDashPattern([], 0);
  doc.setDrawColor('#000000');
  doc.setLineWidth(0.5);
  doc.rect(L.frame.x, L.frame.y, L.frame.w, L.frame.h, 'S');
}

function northArrow(doc: JsPdf, fonts: Fonts, cx: number, cy: number, r: number, label: string) {
  doc.setLineDashPattern([], 0);
  doc.setDrawColor('#1a1a1a');
  doc.setLineWidth(0.25);
  doc.circle(cx, cy, r, 'S');
  // Half-filled arrow pointing to plan north (+Y)
  doc.setFillColor('#1a1a1a');
  doc.triangle(cx, cy - r * 0.95, cx, cy + r * 0.55, cx - r * 0.45, cy + r * 0.8, 'F');
  doc.setFillColor('#ffffff');
  doc.triangle(cx, cy - r * 0.95, cx, cy + r * 0.55, cx + r * 0.45, cy + r * 0.8, 'FD');
  sheetText(doc, fonts, label, cx, cy - r - 1.2, { size: r * 0.5, bold: true, align: 'center' });
}

function scaleBar(doc: JsPdf, fonts: Fonts, x: number, y: number, maxW: number, info: SheetInfo, k: number) {
  const { step, stepMm } = scaleBarStep(info.scale, info.metric, maxW - 8 * k);
  const h = 1.6 * k;
  doc.setLineDashPattern([], 0);
  doc.setDrawColor('#1a1a1a');
  doc.setLineWidth(0.2);
  for (let i = 0; i < 4; i++) {
    doc.setFillColor(i % 2 ? '#ffffff' : '#1a1a1a');
    doc.rect(x + i * stepMm, y, stepMm, h, 'FD');
  }
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));
  for (let i = 0; i <= 4; i++) {
    sheetText(doc, fonts, fmt(i * step), x + i * stepMm, y + h + 2.6 * k, { size: 1.6 * k, align: 'center' });
  }
  sheetText(doc, fonts, info.metric ? 'm' : 'ft', x + 4 * stepMm + 2.2 * k, y + h, { size: 1.6 * k });
}

function titleBlock(doc: JsPdf, fonts: Fonts, L: SheetLayout, info: SheetInfo) {
  const T = L.titleBlock, k = L.k;
  doc.setLineDashPattern([], 0);
  doc.setDrawColor('#000000');
  doc.setLineWidth(0.35);
  doc.line(T.x, T.y, T.x + T.w, T.y);
  // Cell widths as shares of the strip
  const shares = [0.055, 0.16, 0.23, 0.215, 0.075, 0.08, 0.055, 0.13];
  const xs = [T.x];
  for (const s of shares) xs.push(xs[xs.length - 1] + s * T.w);
  doc.setLineWidth(0.18);
  for (let i = 1; i < shares.length; i++) doc.line(xs[i], T.y, xs[i], T.y + T.h);
  const lab = (key: string) => drawingLabel(info.lang, key);
  const cap = (i: number, label: string) =>
    sheetText(doc, fonts, label, xs[i] + 2 * k, T.y + 3.4 * k, { size: 1.5 * k, color: '#666666' });
  const pad = 2 * k;
  const cellW = (i: number) => xs[i + 1] - xs[i] - 2 * pad;

  northArrow(doc, fonts, (xs[0] + xs[1]) / 2, T.y + T.h / 2 + 1.6 * k, Math.min(cellW(0), T.h) * 0.3, lab('drawing.north'));
  scaleBar(doc, fonts, xs[1] + pad, T.y + T.h / 2, cellW(1), info, k);

  cap(2, lab('drawing.project'));
  sheetText(doc, fonts, info.projectName, xs[2] + pad, T.y + T.h * 0.68, { size: 4 * k, bold: true, maxWidth: cellW(2) });
  cap(3, lab('drawing.drawing'));
  sheetText(doc, fonts, info.drawingTitle, xs[3] + pad, T.y + T.h * 0.6, { size: 3 * k, bold: true, maxWidth: cellW(3) });
  sheetText(doc, fonts, info.levelLine, xs[3] + pad, T.y + T.h * 0.86, { size: 1.8 * k, color: '#444444', maxWidth: cellW(3) });
  cap(4, lab('drawing.scale'));
  sheetText(doc, fonts, `1:${info.scale}`, xs[4] + pad, T.y + T.h * 0.62, { size: 3.4 * k, bold: true, maxWidth: cellW(4) });
  sheetText(doc, fonts, info.unitLabel, xs[4] + pad, T.y + T.h * 0.86, { size: 1.6 * k, color: '#444444', maxWidth: cellW(4) });
  cap(5, lab('drawing.date'));
  sheetText(doc, fonts, info.date, xs[5] + pad, T.y + T.h * 0.66, { size: 2.6 * k, maxWidth: cellW(5) });
  cap(6, lab('drawing.sheet'));
  sheetText(doc, fonts, info.sheet, xs[6] + pad, T.y + T.h * 0.66, { size: 3 * k, bold: true, maxWidth: cellW(6) });
  // Brand
  sheetText(doc, fonts, 'BimDown', xs[7] + pad, T.y + T.h * 0.5, { size: 3.6 * k, bold: true, color: '#111111', maxWidth: cellW(7) });
  sheetText(doc, fonts, 'bim.jouledown.com', xs[7] + pad, T.y + T.h * 0.72, { size: 1.6 * k, color: '#555555', maxWidth: cellW(7) });
  sheetText(doc, fonts, lab('drawing.generatedBy'), xs[7] + pad, T.y + T.h * 0.9, { size: 1.4 * k, color: '#888888', maxWidth: cellW(7) });
}

function viewTitle(doc: JsPdf, fonts: Fonts, L: SheetLayout, d: PlanDrawing, info: SheetInfo) {
  const V = L.viewTitle, k = L.k;
  const y = V.y + V.h * 0.55;
  sheetText(doc, fonts, info.drawingTitle, V.x, y, { size: 3.6 * k, bold: true, maxWidth: V.w * 0.5 });
  const [name, style] = face(fonts, true);
  doc.setFont(name, style);
  doc.setFontSize((3.6 * k * MM_TO_PT) / CAP);
  const w = Math.min(doc.getTextWidth(info.drawingTitle), V.w * 0.5);
  doc.setLineDashPattern([], 0);
  doc.setDrawColor('#000000');
  doc.setLineWidth(0.5);
  doc.line(V.x, y + 1.6 * k, V.x + w + 18 * k, y + 1.6 * k);
  doc.setLineWidth(0.18);
  doc.line(V.x, y + 2.4 * k, V.x + w + 18 * k, y + 2.4 * k);
  sheetText(doc, fonts, `1:${info.scale}`, V.x + w + 4 * k, y, { size: 2.6 * k });

  // MEP system legend in rows on the right half of the band
  if (d.legend.length) {
    const size = 1.8 * k, swatch = 5.5 * k, gap = 5 * k;
    const x0 = V.x + Math.max(V.w * 0.42, w + 30 * k), x1 = V.x + V.w;
    const rowH = 3.6 * k;
    const title = `${drawingLabel(info.lang, 'drawing.systems')}:`;
    doc.setFont(...face(fonts, true));
    doc.setFontSize((size * MM_TO_PT) / CAP);
    const left = x0 + doc.getTextWidth(title) + 3 * k;
    sheetText(doc, fonts, title, x0, V.y + rowH, { size, bold: true });
    doc.setFont(...face(fonts, false));
    doc.setFontSize((size * MM_TO_PT) / CAP);
    let x = left, row = 1;
    for (const it of [...d.legend].sort((a, b) => a.label.localeCompare(b.label))) {
      const tw = swatch + 1.5 * k + doc.getTextWidth(it.label);
      if (x + tw > x1 && x > left) { x = left; row++; }
      if (row > Math.floor(V.h / rowH)) break;
      const ty = V.y + row * rowH;
      doc.setLineDashPattern([], 0);
      doc.setDrawColor(it.color);
      doc.setLineWidth(0.8);
      doc.line(x, ty - size / 2, x + swatch, ty - size / 2);
      sheetText(doc, fonts, it.label, x + swatch + 1.5 * k, ty, { size });
      doc.setFont(...face(fonts, false));
      doc.setFontSize((size * MM_TO_PT) / CAP);
      x += tw + gap;
    }
  }
}

// ─── Public ─────────────────────────────────────────────────────────────────

function unitLabel(unit: string, lang: DrawingLang): string {
  const name = { m: 'm', mm: 'mm', ft: 'ft', in: 'in' }[unit] ?? unit;
  return `${drawingLabel(lang, 'drawing.units')}: ${name}`;
}

/** Scale `auto` resolves to for these options (for the export dialog). */
export function suggestPlanScale(project: ProjectData, opts: PdfExportOptions = {}): number | null {
  const lang = drawingLang(opts.lang);
  const sources = collectPlans(project, opts, lang);
  if (!sources.length) return null;
  const L = sheetLayout(opts.paper ?? 'A3');
  return pickScale(s => sources.map(src => renderPlan(src, s)), L.drawArea).scale;
}

/** Build the PDF; null when no level has anything to draw. */
export async function buildPlanPdf(project: ProjectData, modelName: string, opts: PdfExportOptions = {}): Promise<PdfResult | null> {
  const lang = drawingLang(opts.lang);
  const sources = collectPlans(project, opts, lang);
  if (!sources.length) return null;
  const paper = opts.paper ?? 'A3';
  const L = sheetLayout(paper);
  const fixed = typeof opts.scale === 'number' && opts.scale > 0 ? opts.scale : null;
  const { scale, drawings: all } = fixed
    ? { scale: fixed, drawings: sources.map(s => renderPlan(s, fixed)) }
    : pickScale(s => sources.map(src => renderPlan(src, s)), L.drawArea);
  const drawings = all.filter(d => d.items.some(i => !i.dxfOnly && i.layer !== 'S-GRID' && i.layer !== 'S-GRID-IDEN'));
  if (!drawings.length) return null;

  const discipline = opts.discipline ?? 'all';
  const projectName = opts.projectName || project.metadata.project_name || modelName;
  // zh titles run on ("首层建筑平面图"); keep a space after a Latin level name
  const titleOf = (d: PlanDrawing) => drawingLabel(lang, `drawing.title.${discipline}`, {
    level: lang === 'zh' && /[A-Za-z0-9]$/.test(d.levelName) ? `${d.levelName} ` : d.levelName,
  });
  const date = isoDate(opts.date ?? new Date());

  const texts: string[] = [projectName];
  for (const d of drawings) {
    texts.push(titleOf(d), d.levelName);
    for (const it of d.items) if (it.kind === 'text') texts.push(it.text);
    for (const l of d.legend) texts.push(l.label);
  }
  for (const key of ['drawing.project', 'drawing.drawing', 'drawing.scale', 'drawing.date', 'drawing.sheet',
    'drawing.north', 'drawing.systems', 'drawing.generatedBy', 'drawing.elevation', 'drawing.units']) {
    texts.push(drawingLabel(lang, key));
  }
  const fonts: Fonts = { unicode: needsUnicodeFont(texts) };

  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: paper.toLowerCase(), compress: true });
  if (fonts.unicode) {
    doc.addFileToVFS(CJK_FONT_FILE, await loadUnicodeFont(opts.fontLoader));
    doc.addFont(CJK_FONT_FILE, CJK_FONT_NAME, 'normal');
  }
  doc.setProperties({ title: `${projectName} — ${drawings.map(d => d.levelName).join(', ')}`, creator: 'BimDown (bim.jouledown.com)' });

  drawings.forEach((d, i) => {
    if (i > 0) doc.addPage(paper.toLowerCase(), 'landscape');
    const elevationText = `${drawingLabel(lang, 'drawing.elevation')} ${d.elevation >= 0 ? '+' : ''}${d.elevation.toFixed(d.unit === 'mm' ? 0 : d.unit === 'm' ? 3 : 2)} ${d.unit}`;
    const info: SheetInfo = {
      projectName,
      drawingTitle: titleOf(d),
      levelLine: elevationText,
      scale,
      metric: d.unit === 'm' || d.unit === 'mm',
      unitLabel: unitLabel(d.unit, lang),
      date,
      sheet: `${i + 1}/${drawings.length}`,
      lang,
    };
    drawFrame(doc, L);
    // Plan, clipped to its area
    doc.saveGraphicsState();
    doc.rect(L.drawArea.x, L.drawArea.y, L.drawArea.w, L.drawArea.h, null);
    doc.clip();
    doc.discardPath();
    new PlanPage(doc, d, L.drawArea, fonts).draw();
    doc.restoreGraphicsState();
    viewTitle(doc, fonts, L, d, info);
    titleBlock(doc, fonts, L, info);
  });

  return { bytes: doc.output('arraybuffer'), pages: drawings.length, scale };
}

export async function exportPdf(project: ProjectData, modelName: string, opts: PdfExportOptions = {}): Promise<void> {
  const result = await buildPlanPdf(project, modelName, opts);
  if (!result) return;
  triggerDownload(new Blob([result.bytes], { type: 'application/pdf' }), `${modelName}.pdf`);
}
