/**
 * Room geometry for the IFC export: which wall bounds each edge of a room
 * polygon, which walls face outdoors, and the room's net (wall-face) outline.
 * Uses the same wall graph as the editor's room derivation (spaceBoundary.ts).
 */
import type { LineElement, Point } from '../../model/elements.ts';
import { tessellateArc, pointOnArc } from '../../geometry/arc.ts';
import { pickSpaceFace, type BoundedFace } from '../../geometry/spaceBoundary.ts';
import { cleanRing, polygonArea, type V2 } from './frame.ts';

const ON_LINE_TOL = 0.02;

/** Plan segments of a boundary line (arcs tessellated exactly like spaceBoundary). */
function lineSegments(w: LineElement): [Point, Point][] {
  if (!w.arc) return [[w.start, w.end]];
  const pts = tessellateArc(w.start, w.end, w.arc, 0.25);
  const out: [Point, Point][] = [];
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]);
  return out;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export interface RoomEdge { a: V2; b: V2; wall: LineElement | null }

/** Each room polygon edge with the boundary line it lies on (null when none does). */
export function matchRoomEdges(polygon: V2[], walls: LineElement[]): RoomEdge[] {
  const ring = cleanRing(polygon);
  const segs = walls.map(w => ({ w, segs: lineSegments(w) }));
  const out: RoomEdge[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let wall: LineElement | null = null;
    for (const { w, segs: ss } of segs) {
      if (ss.some(([p, q]) => distToSegment(a, p, q) < ON_LINE_TOL && distToSegment(b, p, q) < ON_LINE_TOL && distToSegment(mid, p, q) < ON_LINE_TOL)) {
        wall = w;
        break;
      }
    }
    out.push({ a, b, wall });
  }
  return out;
}

/**
 * True when some stretch of the wall has open air (no bounded face of the wall
 * graph) on one side: sampled at a quarter, half and three quarters along.
 */
export function isExternalWall(w: LineElement, faces: BoundedFace[]): boolean {
  if (faces.length === 0) return true;
  const eps = 0.05;
  for (const t of [0.25, 0.5, 0.75]) {
    let p: Point, tx: number, ty: number;
    if (w.arc) {
      const r = pointOnArc(w.start, w.end, w.arc, t);
      p = r.point; tx = r.tangent.x; ty = r.tangent.y;
    } else {
      p = { x: w.start.x + (w.end.x - w.start.x) * t, y: w.start.y + (w.end.y - w.start.y) * t };
      tx = w.end.x - w.start.x; ty = w.end.y - w.start.y;
    }
    const l = Math.hypot(tx, ty) || 1;
    const nx = -ty / l, ny = tx / l;
    const left = pickSpaceFace({ x: p.x + nx * eps, y: p.y + ny * eps }, faces);
    const right = pickSpaceFace({ x: p.x - nx * eps, y: p.y - ny * eps }, faces);
    if (!left || !right) return true;
  }
  return false;
}

/**
 * Net outline: each edge moved inward by its half wall thickness (room
 * separators and unmatched edges stay put). Null when the offset degenerates.
 */
export function netRoomPolygon(edges: RoomEdge[], halfThickness: (w: LineElement) => number): V2[] | null {
  const n = edges.length;
  if (n < 3) return null;
  // CCW polygon → interior is on the left of each edge.
  const sign = polygonArea(edges.map(e => e.a)) >= 0 ? 1 : -1;
  const lines = edges.map(e => {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const l = Math.hypot(dx, dy);
    const d = e.wall ? halfThickness(e.wall) : 0;
    const nx = (-dy / l) * sign, ny = (dx / l) * sign;
    return { p: { x: e.a.x + nx * d, y: e.a.y + ny * d }, u: { x: dx / l, y: dy / l } };
  });
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i + n - 1) % n], L2 = lines[i];
    const den = L1.u.x * L2.u.y - L1.u.y * L2.u.x;
    if (Math.abs(den) < 1e-9) { out.push(L2.p); continue; }
    const t = ((L2.p.x - L1.p.x) * L2.u.y - (L2.p.y - L1.p.y) * L2.u.x) / den;
    out.push({ x: L1.p.x + L1.u.x * t, y: L1.p.y + L1.u.y * t });
  }
  const gross = Math.abs(polygonArea(edges.map(e => e.a)));
  const net = Math.abs(polygonArea(out));
  if (!(net > 0) || net > gross + 1e-6 || Math.sign(polygonArea(out)) !== sign) return null;
  return out;
}
