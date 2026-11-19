/**
 * Crop region of a sheet viewport: a drawing clipped to a box of its own
 * model coordinates. Lines are cut at the box, filled outlines clipped as
 * polygons (Sutherland–Hodgman), texts / circles / arcs kept when their
 * anchor is inside.
 */
import type { Point } from '../../model/elements.ts';
import type { Box, DrawItem, ScaledDrawing } from './types.ts';

const inside = (p: Point, b: Box) => p.x >= b.minX - 1e-9 && p.x <= b.maxX + 1e-9 && p.y >= b.minY - 1e-9 && p.y <= b.maxY + 1e-9;

/** Part of segment a–b inside the box (Liang–Barsky), or null. */
function clipSegment(a: Point, b: Point, box: Box): [Point, Point] | null {
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const edges: [number, number][] = [[-dx, a.x - box.minX], [dx, box.maxX - a.x], [-dy, a.y - box.minY], [dy, box.maxY - a.y]];
  for (const [p, q] of edges) {
    if (Math.abs(p) < 1e-12) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  return [{ x: a.x + t0 * dx, y: a.y + t0 * dy }, { x: a.x + t1 * dx, y: a.y + t1 * dy }];
}

/** Polygon clipped to the box. */
function clipPolygon(pts: Point[], box: Box): Point[] {
  type Edge = { in: (p: Point) => boolean; cut: (a: Point, b: Point) => Point };
  const lerp = (a: Point, b: Point, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const edges: Edge[] = [
    { in: p => p.x >= box.minX, cut: (a, b) => lerp(a, b, (box.minX - a.x) / (b.x - a.x)) },
    { in: p => p.x <= box.maxX, cut: (a, b) => lerp(a, b, (box.maxX - a.x) / (b.x - a.x)) },
    { in: p => p.y >= box.minY, cut: (a, b) => lerp(a, b, (box.minY - a.y) / (b.y - a.y)) },
    { in: p => p.y <= box.maxY, cut: (a, b) => lerp(a, b, (box.maxY - a.y) / (b.y - a.y)) },
  ];
  let out = pts;
  for (const e of edges) {
    if (out.length === 0) break;
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i], prev = src[(i + src.length - 1) % src.length];
      if (e.in(cur)) {
        if (!e.in(prev)) out.push(e.cut(prev, cur));
        out.push(cur);
      } else if (e.in(prev)) out.push(e.cut(prev, cur));
    }
  }
  return out;
}

export function cropItems(items: readonly DrawItem[], box: Box): DrawItem[] {
  const out: DrawItem[] = [];
  for (const it of items) {
    if (it.kind === 'path') {
      if (it.closed && (it.fill || it.pts.length >= 3) && it.pts.every(p => inside(p, box))) { out.push(it); continue; }
      if (it.closed && it.fill) {
        const pts = clipPolygon(it.pts, box);
        if (pts.length >= 3) out.push({ ...it, pts });
        continue;
      }
      const pts = it.closed ? [...it.pts, it.pts[0]] : it.pts;
      // Runs of the polyline inside the box
      let run: Point[] = [];
      const flush = () => { if (run.length >= 2) out.push({ ...it, pts: run, closed: false, fill: undefined }); run = []; };
      for (let i = 0; i + 1 < pts.length; i++) {
        const seg = clipSegment(pts[i], pts[i + 1], box);
        if (!seg) { flush(); continue; }
        const last = run[run.length - 1];
        if (!last || Math.hypot(last.x - seg[0].x, last.y - seg[0].y) > 1e-9) { flush(); run = [seg[0]]; }
        run.push(seg[1]);
        if (Math.hypot(seg[1].x - pts[i + 1].x, seg[1].y - pts[i + 1].y) > 1e-9) flush();
      }
      flush();
    } else if (it.kind === 'text') {
      if (inside(it.at, box)) out.push(it);
    } else if (it.kind === 'circle' || it.kind === 'arc') {
      if (inside(it.center, box)) out.push(it);
    } else out.push(it);
  }
  return out;
}

/** The drawing limited to the crop box (bounds = the box). */
export function cropDrawing<T extends ScaledDrawing>(d: T, box: Box): T {
  return { ...d, items: cropItems(d.items, box), bounds: { ...box } };
}
