/**
 * Grid-driven structural layout (pure geometry, no editor state):
 *   - grid intersections → "columns at grids"
 *   - columns → beams between neighbouring columns along the grid directions
 *   - the grid bay around a point, and a beam system filling a bay
 */
import type { Point } from './elements.ts';
import type { GridData } from '../types.ts';

export type Segment = [Point, Point];

/** UI-only drawing attrs of the beam-system tool (never persisted). */
export const BEAM_SPACING_KEY = '__spacing';
export const BEAM_SPAN_KEY = '__span';

const EPS = 1e-9;
/** Lines within this angle count as parallel (radians). */
const PARALLEL_TOL = Math.sin((1 * Math.PI) / 180);

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const len = (a: Point) => Math.hypot(a.x, a.y);
const unit = (a: Point): Point => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };

function gridSegment(g: GridData): Segment {
  return [{ x: g.x1, y: g.y1 }, { x: g.x2, y: g.y2 }];
}

/** Intersection of two segments (extended by `tol` at both ends), or null. */
function segmentIntersection([a1, a2]: Segment, [b1, b2]: Segment, tol: number): Point | null {
  const r = sub(a2, a1), s = sub(b2, b1);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return null;
  const qp = sub(b1, a1);
  const t = cross(qp, s) / denom;
  const u = cross(qp, r) / denom;
  const tt = tol / (len(r) || 1), tu = tol / (len(s) || 1);
  if (t < -tt || t > 1 + tt || u < -tu || u > 1 + tu) return null;
  return { x: a1.x + r.x * t, y: a1.y + r.y * t };
}

/** All grid crossing points (deduplicated to 1 mm), grids extended by 0.5 m. */
export function gridIntersections(grids: readonly GridData[]): Point[] {
  const out: Point[] = [];
  const segs = grids.filter(g => g.x1 !== g.x2 || g.y1 !== g.y2).map(gridSegment);
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segmentIntersection(segs[i], segs[j], 0.5);
      if (!p) continue;
      if (out.some(q => Math.abs(q.x - p.x) < 1e-3 && Math.abs(q.y - p.y) < 1e-3)) continue;
      out.push({ x: round3(p.x), y: round3(p.y) });
    }
  }
  return out;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Axis-aligned rectangle test (corners in any order). */
export function inRect(p: Point, a: Point, b: Point, tol = 1e-6): boolean {
  return p.x >= Math.min(a.x, b.x) - tol && p.x <= Math.max(a.x, b.x) + tol
    && p.y >= Math.min(a.y, b.y) - tol && p.y <= Math.max(a.y, b.y) + tol;
}

/** Unique grid directions (unit vectors, one per family of parallel lines). */
export function gridDirections(grids: readonly GridData[]): Point[] {
  const dirs: Point[] = [];
  for (const g of grids) {
    const d = unit({ x: g.x2 - g.x1, y: g.y2 - g.y1 });
    if (len({ x: g.x2 - g.x1, y: g.y2 - g.y1 }) < EPS) continue;
    if (!dirs.some(e => Math.abs(cross(e, d)) < PARALLEL_TOL)) dirs.push(d);
  }
  return dirs;
}

/**
 * Beams between neighbouring columns: every pair of columns aligned with one
 * of `directions` (grid directions; X/Y when empty) with no other column on
 * the segment between them. Pairs already joined by an `existing` segment are
 * skipped.
 */
export function beamsBetweenColumns(
  columns: readonly Point[],
  directions: readonly Point[],
  existing: readonly Segment[] = [],
): Segment[] {
  const dirs = directions.length > 0 ? directions : [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  const out: Segment[] = [];
  for (let i = 0; i < columns.length; i++) {
    for (let j = i + 1; j < columns.length; j++) {
      const a = columns[i], b = columns[j];
      const v = sub(b, a);
      const L = len(v);
      if (L < 0.3) continue;
      const u = unit(v);
      if (!dirs.some(d => Math.abs(cross(u, d)) < PARALLEL_TOL)) continue;
      // Nearest neighbour only: no third column on (or right next to) a→b.
      const corridor = Math.max(0.05, Math.min(0.3, 0.05 * L));
      const blocked = columns.some((c, k) => {
        if (k === i || k === j) return false;
        const w = sub(c, a);
        const t = dot(w, u);
        return t > 1e-3 && t < L - 1e-3 && Math.abs(cross(u, w)) < corridor;
      });
      if (blocked) continue;
      if (existing.some(s => sameSegment(s, [a, b], 0.05))) continue;
      out.push([a, b]);
    }
  }
  return out;
}

function sameSegment([a1, a2]: Segment, [b1, b2]: Segment, tol: number): boolean {
  const near = (p: Point, q: Point) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;
  return (near(a1, b1) && near(a2, b2)) || (near(a1, b2) && near(a2, b1));
}

/**
 * The grid bay holding `p`: the quadrilateral bounded by the nearest grid line
 * on each side, in the two most populated grid directions. Corners in order
 * (a parallelogram for skewed grids), or null outside the grid.
 */
export function gridBayAt(p: Point, grids: readonly GridData[]): Point[] | null {
  const families: { d: Point; lines: Segment[] }[] = [];
  for (const g of grids) {
    const seg = gridSegment(g);
    const v = sub(seg[1], seg[0]);
    if (len(v) < EPS) continue;
    const d = unit(v);
    const fam = families.find(f => Math.abs(cross(f.d, d)) < PARALLEL_TOL);
    if (fam) fam.lines.push(seg); else families.push({ d, lines: [seg] });
  }
  if (families.length < 2) return null;
  families.sort((a, b) => b.lines.length - a.lines.length);
  const sides: Segment[][] = [];
  for (const fam of families.slice(0, 2)) {
    const n = { x: -fam.d.y, y: fam.d.x };
    const sp = dot(n, p);
    let below: Segment | null = null, above: Segment | null = null;
    let bOff = -Infinity, aOff = Infinity;
    for (const seg of fam.lines) {
      const off = dot(n, seg[0]);
      if (off < sp && off > bOff) { bOff = off; below = seg; }
      if (off > sp && off < aOff) { aOff = off; above = seg; }
    }
    if (!below || !above) return null;
    sides.push([below, above]);
  }
  const corner = (l1: Segment, l2: Segment) => lineIntersection(l1, l2);
  const [[a0, a1], [b0, b1]] = sides;
  const pts = [corner(a0, b0), corner(a0, b1), corner(a1, b1), corner(a1, b0)];
  if (pts.some(q => !q)) return null;
  return pts as Point[];
}

function lineIntersection([a1, a2]: Segment, [b1, b2]: Segment): Point | null {
  const r = sub(a2, a1), s = sub(b2, b1);
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return null;
  const t = cross(sub(b1, a1), s) / denom;
  return { x: round3(a1.x + r.x * t), y: round3(a1.y + r.y * t) };
}

/** Bay corners of an axis-aligned rectangle given by two opposite corners. */
export function rectBay(a: Point, b: Point): Point[] {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

/**
 * Beam system: parallel infill beams across a bay (corners p0..p3 in order),
 * at most `spacing` apart, excluding the bay edges. `span` 'short' runs the
 * beams across the short dimension (parallel to the short sides, spaced along
 * the long ones), 'long' the other way.
 */
export function beamSystemLines(bay: readonly Point[], spacing: number, span: 'short' | 'long' = 'short'): Segment[] {
  if (bay.length !== 4 || !(spacing > 0)) return [];
  const [p0, p1, p2, p3] = bay;
  const e01 = len(sub(p1, p0));
  const e12 = len(sub(p2, p1));
  if (e01 < EPS || e12 < EPS) return [];
  // Beams parallel to edge p1→p2 (and p0→p3) are spaced along p0→p1.
  const parallelToE12 = span === 'short' ? e12 <= e01 : e12 > e01;
  // a: the edge the beams start on, b: the opposite edge, both walked along
  // the spacing direction.
  const [a0, a1, b0, b1, along] = parallelToE12
    ? [p0, p1, p3, p2, e01]
    : [p1, p2, p0, p3, e12];
  const n = Math.max(1, Math.ceil(along / spacing - 1e-6));
  const out: Segment[] = [];
  for (let k = 1; k < n; k++) {
    const t = k / n;
    const s = { x: round3(a0.x + (a1.x - a0.x) * t), y: round3(a0.y + (a1.y - a0.y) * t) };
    const e = { x: round3(b0.x + (b1.x - b0.x) * t), y: round3(b0.y + (b1.y - b0.y) * t) };
    out.push([s, e]);
  }
  return out;
}
