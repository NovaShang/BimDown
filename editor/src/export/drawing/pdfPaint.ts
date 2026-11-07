/**
 * Drawing items → jsPDF: pens per layer (ink, weight, linetype), paths with
 * fills, circles, arcs as Béziers and text with the sheet font (the embedded
 * CJK font when a label needs it). Shared by the plan sheets and the sheet
 * set export; the caller supplies the model → paper mapping.
 */
import type { jsPDF as JsPdf } from 'jspdf';
import type { Point } from '../../model/elements.ts';
import { tint } from './color.ts';
import { CJK_FONT_NAME } from './pdfFont.ts';
import type { DrawingLayer, LineDash } from './layers.ts';
import type { DrawItem } from './types.ts';

export const MM_TO_PT = 72 / 25.4;
/** Cap height as a share of the font size (Helvetica 0.72, Noto Sans SC 0.73). */
export const CAP = 0.72;

export const DASH_MM: Record<LineDash, number[]> = {
  solid: [],
  dashed: [2.0, 1.0],
  hidden: [1.5, 0.8],
  center: [7, 1.2, 1.2, 1.2],
};

export interface Fonts { unicode: boolean }

export function face(fonts: Fonts, bold: boolean): [string, string] {
  if (fonts.unicode) return [CJK_FONT_NAME, 'normal'];
  return ['helvetica', bold ? 'bold' : 'normal'];
}

/** Text in sheet units (mm). Bold is faked with a stroke for the single-weight CJK font. */
export function sheetText(
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

/** Where drawing items land on the page: paper mm, Y down (jsPDF). */
export interface PaperMap {
  /** Model units per paper mm. */
  pm: number;
  X(p: Point): number;
  Y(p: Point): number;
}

/** Centre the drawing's extent on `area` (paper mm, Y down) at its own scale. */
export function centredMap(bounds: { minX: number; minY: number; maxX: number; maxY: number } | null, pm: number,
  area: { x: number; y: number; w: number; h: number }): PaperMap {
  const b = bounds ?? { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
  const ox = area.x + area.w / 2, oy = area.y + area.h / 2;
  return { pm, X: p => ox + (p.x - cx) / pm, Y: p => oy - (p.y - cy) / pm };
}

export class ItemPainter {
  private readonly pm: number;
  private readonly doc: JsPdf;
  private readonly layers: Map<string, DrawingLayer>;
  private readonly fonts: Fonts;
  private readonly map: PaperMap;

  constructor(doc: JsPdf, layers: Map<string, DrawingLayer>, map: PaperMap, fonts: Fonts) {
    this.doc = doc;
    this.layers = layers;
    this.fonts = fonts;
    this.map = map;
    this.pm = map.pm;
  }

  X(p: Point) { return this.map.X(p); }
  Y(p: Point) { return this.map.Y(p); }

  private pen(it: DrawItem) {
    const layer = this.layers.get(it.layer);
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

  draw(items: DrawItem[]) {
    const { doc } = this;
    doc.setLineCap('round');
    doc.setLineJoin('round');
    for (const it of items) {
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
          const layer = this.layers.get(it.layer);
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
