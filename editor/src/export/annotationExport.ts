/**
 * Plan annotations (dimensions, text notes, tags) as backend-neutral drawing
 * primitives in model coordinates (Y up), plus SVG and DXF writers, so the
 * PDF / DXF exporters draw exactly what the editor shows.
 *
 *   const prims = drawAnnotations(levelElements, unit);
 *   svgParts.push(annotationsToSvg(prims));          // PDF (svg2pdf), Y flipped
 *   drawAnnotationsDxf(dxf, prims, y => y);          // DXF
 */
import type { CanonicalElement, Point } from '../model/elements.ts';
import type { ProjectUnit } from '../types.ts';
import { isAnnotationTable, isTagPinned } from '../annotation/model.ts';
import {
  resolveDimension, formatDimension, readableAngle, tagLines, tagDefaultPosition, tagBox, elementAnchor,
  metre, add, sub, mul, mid, len, type Lookup,
} from '../annotation/geometry.ts';
import { boundaryWalls, roomPolygon, polygonArea } from '../annotation/rooms.ts';
import { textNoteLines } from '../elements/text_note.tsx';

export interface AnnotationLine { a: Point; b: Point; width: number }
export interface AnnotationText { at: Point; text: string; size: number; angle: number; bold?: boolean }
export interface AnnotationBox { center: Point; w: number; h: number; width: number }
export interface AnnotationPrimitives {
  lines: AnnotationLine[];
  texts: AnnotationText[];
  boxes: AnnotationBox[];
}

/** Dimension, text and tag primitives for one level's elements (the level's own elements, not global/). */
export function drawAnnotations(elements: CanonicalElement[], unit: ProjectUnit): AnnotationPrimitives {
  const out: AnnotationPrimitives = { lines: [], texts: [], boxes: [] };
  const byId = new Map(elements.map(e => [e.id, e]));
  const lookup: Lookup = id => byId.get(id);
  const m = metre(unit);
  const walls = boundaryWalls(elements);
  const sw = 0.02 * m;

  for (const el of elements) {
    if (!isAnnotationTable(el.tableName)) continue;
    if (el.tableName === 'dimension') {
      const g = resolveDimension(el, lookup);
      if (!g) continue;
      for (const [p, d] of [[g.p1, g.d1], [g.p2, g.d2]] as const) {
        const v = sub(d, p);
        const l = len(v);
        if (l < 0.08 * m) continue;
        const dir = mul(v, 1 / l);
        out.lines.push({ a: add(p, mul(dir, 0.08 * m)), b: add(d, mul(dir, 0.1 * m)), width: sw });
      }
      out.lines.push({ a: g.d1, b: g.d2, width: sw });
      const tick = mul(add(g.u, g.n), 0.12 * m / Math.SQRT2);
      for (const d of [g.d1, g.d2]) out.lines.push({ a: sub(d, tick), b: add(d, tick), width: sw * 2.2 });
      const angle = readableAngle(g.u);
      const a = angle * Math.PI / 180;
      out.texts.push({
        at: add(mid(g.d1, g.d2), mul({ x: -Math.sin(a), y: Math.cos(a) }, 0.16 * m)),
        text: (el.attrs.text ?? '').trim() || formatDimension(g.value, unit),
        size: 0.22 * m, angle,
      });
    } else if (el.tableName === 'text_note' && el.geometry === 'point') {
      const lines = textNoteLines(el.attrs.text);
      if (lines.every(l => !l.trim())) continue;
      const size = parseFloat(el.attrs.size ?? '') || 0.25 * m;
      const rot = parseFloat(el.attrs.rotation ?? '') || 0;
      const r = rot * Math.PI / 180;
      lines.forEach((text, i) => {
        const dy = ((lines.length - 1) / 2 - i) * size * 1.25;
        out.texts.push({ at: { x: el.position.x - Math.sin(r) * dy, y: el.position.y + Math.cos(r) * dy }, text, size, angle: rot });
      });
    } else if (el.tableName === 'tag' && el.geometry === 'point') {
      const host = byId.get(el.attrs.host_id ?? '');
      if (!host) continue;
      const room = host.tableName === 'space';
      const poly = room ? roomPolygon(host, walls) : null;
      const lines = tagLines(host, el.attrs.content, poly ? polygonArea(poly) : null, unit);
      const pos = isTagPinned(el) ? el.position : tagDefaultPosition(host, lookup, unit);
      const box = tagBox(lines, room, unit);
      const anchor = elementAnchor(host);
      if (isTagPinned(el) && len(sub(anchor, pos)) > 0.6 * m) out.lines.push({ a: anchor, b: pos, width: 0.015 * m });
      if (!room) out.boxes.push({ center: pos, w: box.w, h: box.h, width: 0.015 * m });
      lines.forEach((text, i) => {
        const dy = ((lines.length - 1) / 2 - i) * box.size * 1.25;
        out.texts.push({ at: { x: pos.x, y: pos.y + dy }, text, size: room && i === 0 ? box.size * 1.1 : box.size, angle: 0, bold: i === 0 });
      });
    }
  }
  return out;
}

/** Rooms labelled by a tag (exporters skip their plain room label). */
export function taggedRoomIds(elements: CanonicalElement[]): Set<string> {
  return new Set(elements.filter(e => e.tableName === 'tag').map(e => e.attrs.host_id ?? ''));
}

const f = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : '0');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** SVG markup in the PDF exporter's frame: x as is, y negated (SVG is Y down). */
export function annotationsToSvg(p: AnnotationPrimitives, ink = '#1d3557'): string {
  const parts: string[] = ['<g data-table="annotation">'];
  for (const l of p.lines) {
    parts.push(`<line x1="${f(l.a.x)}" y1="${f(-l.a.y)}" x2="${f(l.b.x)}" y2="${f(-l.b.y)}" stroke="${ink}" stroke-width="${f(l.width)}" fill="none"/>`);
  }
  for (const b of p.boxes) {
    parts.push(`<rect x="${f(b.center.x - b.w / 2)}" y="${f(-b.center.y - b.h / 2)}" width="${f(b.w)}" height="${f(b.h)}" fill="white" stroke="${ink}" stroke-width="${f(b.width)}"/>`);
  }
  for (const t of p.texts) {
    // Baseline-centred: svg2pdf ignores dominant-baseline, so shift by ~0.35 em
    parts.push(`<text x="0" y="${f(t.size * 0.35)}" transform="translate(${f(t.at.x)},${f(-t.at.y)}) rotate(${f(-t.angle)})" font-size="${f(t.size)}" font-family="Helvetica, Arial, sans-serif"${t.bold ? ' font-weight="bold"' : ''} fill="${ink}" text-anchor="middle">${esc(t.text)}</text>`);
  }
  parts.push('</g>');
  return parts.join('\n');
}

/** Draw primitives with a dxf-writer Drawing; `mapY` converts model Y to the drawing's Y. */
export function drawAnnotationsDxf(
  dxf: { drawLine(x1: number, y1: number, x2: number, y2: number): unknown; drawText(x: number, y: number, h: number, rot: number, text: string, hAlign?: string, vAlign?: string): unknown; drawRect(x1: number, y1: number, x2: number, y2: number): unknown },
  p: AnnotationPrimitives,
  mapY: (y: number) => number = y => y,
): void {
  for (const l of p.lines) dxf.drawLine(l.a.x, mapY(l.a.y), l.b.x, mapY(l.b.y));
  for (const b of p.boxes) dxf.drawRect(b.center.x - b.w / 2, mapY(b.center.y - b.h / 2), b.center.x + b.w / 2, mapY(b.center.y + b.h / 2));
  const flipped = mapY(1) < mapY(0);
  for (const t of p.texts) dxf.drawText(t.at.x, mapY(t.at.y), t.size, flipped ? -t.angle : t.angle, t.text, 'center', 'middle');
}
