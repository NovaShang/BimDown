/**
 * Room areas: one rule for tags, schedules, the properties panel, plan sheets
 * and IFC (mirrored by the CLI's build/room-area.ts for `net_area`).
 *
 * Room outlines are derived along wall centre lines (spaceBoundary.ts, the
 * CLI's space.geojson). Drawings quote the NET area at the wall finish faces
 * (Revit's default): each outline edge moves inward by half the thickness of
 * the wall it lies on (room separators and edges on no wall stay put). The
 * centre-line area is kept as the gross area.
 */
import type { LineElement, Point } from '../model/elements.ts';
import { tessellateArc } from './arc.ts';

/** Edge-on-wall tolerance in metres (scaled by the caller's units per metre). */
const ON_LINE_TOL_M = 0.02;

export interface RoomEdge { a: Point; b: Point; wall: LineElement | null }

export interface RoomAreas {
  /** Net area at the wall faces (falls back to the gross area if the offset degenerates). */
  area: number;
  /** Area of the centre-line outline. */
  grossArea: number;
  /** Net outline, or null when it degenerates. */
  netPolygon: Point[] | null;
}

/** Signed shoelace area (CCW positive). */
export function signedArea(v: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Drop repeated points and the closing duplicate of a ring. */
function cleanRing(pts: readonly Point[], tol = 1e-6): Point[] {
  const out: Point[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > tol) out.push(p);
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= tol) out.pop();
  return out;
}

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

/** Each room outline edge with the boundary line it lies on (null when none does). `upm`: model units per metre. */
export function matchRoomEdges(polygon: readonly Point[], walls: LineElement[], upm = 1): RoomEdge[] {
  const tol = ON_LINE_TOL_M * upm;
  const ring = cleanRing(polygon);
  const segs = walls.map(w => ({ w, segs: lineSegments(w) }));
  const out: RoomEdge[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) < 1e-6 * upm) continue;
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    let wall: LineElement | null = null;
    for (const { w, segs: ss } of segs) {
      if (ss.some(([p, q]) => distToSegment(a, p, q) < tol && distToSegment(b, p, q) < tol && distToSegment(mid, p, q) < tol)) {
        wall = w;
        break;
      }
    }
    out.push({ a, b, wall });
  }
  return out;
}

/** Half the thickness a boundary line takes off the room (room separators: none). */
export function wallHalfThickness(w: LineElement): number {
  return w.tableName === 'room_separator' ? 0 : (w.strokeWidth || 0) / 2;
}

/**
 * Net outline: each edge moved inward by its wall's half thickness, corners
 * re-intersected. Null when the offset degenerates (flips, grows or vanishes).
 */
export function netRoomOutline(edges: RoomEdge[], halfThickness: (w: LineElement) => number = wallHalfThickness): Point[] | null {
  const n = edges.length;
  if (n < 3) return null;
  // CCW outline → the interior is on the left of each edge.
  const sign = signedArea(edges.map(e => e.a)) >= 0 ? 1 : -1;
  const lines = edges.map(e => {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const l = Math.hypot(dx, dy);
    const d = e.wall ? halfThickness(e.wall) : 0;
    const nx = (-dy / l) * sign, ny = (dx / l) * sign;
    return { p: { x: e.a.x + nx * d, y: e.a.y + ny * d }, u: { x: dx / l, y: dy / l } };
  });
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i + n - 1) % n], L2 = lines[i];
    const den = L1.u.x * L2.u.y - L1.u.y * L2.u.x;
    if (Math.abs(den) < 1e-9) { out.push(L2.p); continue; }
    const t = ((L2.p.x - L1.p.x) * L2.u.y - (L2.p.y - L1.p.y) * L2.u.x) / den;
    out.push({ x: L1.p.x + L1.u.x * t, y: L1.p.y + L1.u.y * t });
  }
  const gross = Math.abs(signedArea(edges.map(e => e.a)));
  const net = Math.abs(signedArea(out));
  if (!(net > 0) || net > gross + 1e-9 * Math.max(1, gross) || Math.sign(signedArea(out)) !== sign) return null;
  return out;
}

/** Net (wall-face) and gross (centre-line) area of a room outline bounded by `walls`. */
export function roomAreas(polygon: readonly Point[], walls: LineElement[], upm = 1): RoomAreas {
  const grossArea = Math.abs(signedArea(polygon));
  const netPolygon = netRoomOutline(matchRoomEdges(polygon, walls, upm));
  return { area: netPolygon ? Math.abs(signedArea(netPolygon)) : grossArea, grossArea, netPolygon };
}
