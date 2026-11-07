/**
 * Plan annotations (dimensions, text notes, tags) as backend-neutral drawing
 * primitives in model coordinates (Y up), so the PDF / DXF plan exports draw
 * exactly what the editor shows. `planAnnotator` turns them into plan drawing
 * items (export/drawing): registered once, every PDF sheet and DXF file gets
 * them on G-ANNO-DIMS / G-ANNO-TEXT, and their text goes through the sheet's
 * font handling (the CJK font when a label needs it).
 */
import type { CanonicalElement, Point } from '../model/elements.ts';
import type { ProjectUnit } from '../types.ts';
import { isAnnotationTable, isTagPinned } from '../annotation/model.ts';
import {
  resolveDimension, formatDimension, readableAngle, tagLines, tagDefaultPosition, tagBox, elementAnchor,
  metre, add, sub, mul, mid, len, type Lookup,
} from '../annotation/geometry.ts';
import { boundaryWalls, roomPolygon } from '../annotation/rooms.ts';
import { roomAreas } from '../geometry/roomArea.ts';
import { textNoteLines } from '../elements/text_note.tsx';
import { registerPlanAnnotator, type PlanAnnotator } from './drawing/annotations.ts';
import { LAYERS } from './drawing/layers.ts';

/** `dim`: part of a dimension (G-ANNO-DIMS); otherwise text / tag (G-ANNO-TEXT). */
export interface AnnotationLine { a: Point; b: Point; width: number; dim?: boolean }
export interface AnnotationText { at: Point; text: string; size: number; angle: number; bold?: boolean; dim?: boolean }
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
        out.lines.push({ a: add(p, mul(dir, 0.08 * m)), b: add(d, mul(dir, 0.1 * m)), width: sw, dim: true });
      }
      out.lines.push({ a: g.d1, b: g.d2, width: sw, dim: true });
      const tick = mul(add(g.u, g.n), 0.12 * m / Math.SQRT2);
      for (const d of [g.d1, g.d2]) out.lines.push({ a: sub(d, tick), b: add(d, tick), width: sw * 2.2, dim: true });
      const angle = readableAngle(g.u);
      const a = angle * Math.PI / 180;
      out.texts.push({
        at: add(mid(g.d1, g.d2), mul({ x: -Math.sin(a), y: Math.cos(a) }, 0.16 * m)),
        text: (el.attrs.text ?? '').trim() || formatDimension(g.value, unit),
        size: 0.22 * m, angle, dim: true,
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
      const lines = tagLines(host, el.attrs.content, poly ? roomAreas(poly, walls, m).area : null, unit);
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

/** Cap height as a share of the font size (Helvetica ≈ 0.72). */
const CAP = 0.72;

/**
 * Plan drawing items for a level's dimensions, text notes and tags. Sizes are
 * the editor's (model units), so a sheet shows them as on screen; dimension
 * ticks and tag leaders keep their heavier pen. Tag boxes get a white mask
 * (PDF only) so they read over the walls they sit on.
 */
export const planAnnotator: PlanAnnotator = ctx => {
  if (!ctx.elements.some(e => isAnnotationTable(e.tableName))) return;
  const p = drawAnnotations(ctx.elements, ctx.unit);
  const dims = ctx.layer(LAYERS.annoDims), text = ctx.layer(LAYERS.annoText);
  const m = metre(ctx.unit);
  for (const l of p.lines) {
    ctx.add({ kind: 'path', layer: l.dim ? dims : text, pts: [l.a, l.b], closed: false, ...(l.width > 0.03 * m ? { weight: 0.35 } : {}) });
  }
  for (const b of p.boxes) {
    const x0 = b.center.x - b.w / 2, x1 = b.center.x + b.w / 2, y0 = b.center.y - b.h / 2, y1 = b.center.y + b.h / 2;
    ctx.add({ kind: 'path', layer: text, pts: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], closed: true, fill: '#ffffff' });
  }
  for (const t of p.texts) {
    ctx.add({
      kind: 'text', layer: t.dim ? dims : text, at: t.at, text: t.text, height: t.size * CAP,
      align: 'center', valign: 'middle', rotation: (t.angle * Math.PI) / 180, bold: t.bold,
    });
  }
};

registerPlanAnnotator(planAnnotator);
