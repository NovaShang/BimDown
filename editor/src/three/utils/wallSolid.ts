/**
 * Direct construction of straight wall solids, with rectangular door /
 * window / opening cuts, without ExtrudeGeometry or CSG.
 *
 * A wall with openings becomes a row of prisms: full-height pieces between
 * the openings, plus the parts below the sill and above the head of each
 * opening. Each piece is the wall footprint clipped to its span along the
 * wall axis, so mitered ends and openings near them come out exactly as the
 * CSG subtraction (a box through the wall) would cut them. Roughly 100× faster
 * than CSG, which matters at thousands of doors.
 *
 * Returns null for cases the CSG path handles instead (arc walls, round /
 * arched or overlapping openings, unusual footprints).
 */
import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2 } from 'three';
import type { Point } from '../../model/elements.ts';

export interface WallSolidInput {
  start: Point;
  end: Point;
  /** Mitered footprint polygon (model XY). */
  footprint: Point[];
  thickness: number;
  height: number;
  baseY: number;
  openings: { position: number; width: number; height: number; sillHeight: number; shape: string }[];
}

const EPS = 1e-9;

export function buildStraightWallSolid(w: WallSolidInput): BufferGeometry | null {
  const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 0.001 || w.footprint.length < 3 || !(w.height > 0)) return null;
  const ux = dx / len, uy = dy / len;
  const hw = w.thickness / 2;

  // The CSG cutter spans ±2·hw across the wall; only take over when the
  // footprint is inside that, so both agree.
  for (const p of w.footprint) {
    const perp = Math.abs((p.x - w.start.x) * -uy + (p.y - w.start.y) * ux);
    if (perp > 1.9 * hw) return null;
  }

  const cuts = [...w.openings]
    .map(o => ({ lo: o.position - o.width / 2, hi: o.position + o.width / 2, y0: o.sillHeight, y1: o.sillHeight + o.height, shape: o.shape }))
    .sort((a, b) => a.lo - b.lo);
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    if (c.shape !== 'rect' || !(c.hi - c.lo > EPS) || !(c.y1 - c.y0 > EPS)) return null;
    if (i > 0 && c.lo < cuts[i - 1].hi - EPS) return null;
  }

  const tOf = (p: Point) => (p.x - w.start.x) * ux + (p.y - w.start.y) * uy;
  let tMin = Infinity, tMax = -Infinity;
  for (const p of w.footprint) { const t = tOf(p); tMin = Math.min(tMin, t); tMax = Math.max(tMax, t); }

  const out = new PrismWriter(w.baseY);
  let cursor = tMin;
  for (const c of cuts) {
    if (c.lo > cursor) out.prism(clipToSpan(w.footprint, tOf, cursor, Math.min(c.lo, tMax)), 0, w.height);
    const lo = Math.max(c.lo, tMin), hi = Math.min(c.hi, tMax);
    if (hi > lo) {
      const span = clipToSpan(w.footprint, tOf, lo, hi);
      if (c.y0 > 0) out.prism(span, 0, Math.min(c.y0, w.height));
      if (c.y1 < w.height) out.prism(span, Math.max(c.y1, 0), w.height);
    }
    cursor = Math.max(cursor, c.hi);
  }
  if (cursor < tMax) out.prism(clipToSpan(w.footprint, tOf, cursor, tMax), 0, w.height);
  return out.geometry();
}

/** Footprint ∩ { tLo ≤ t ≤ tHi } (Sutherland–Hodgman against two half-planes). */
function clipToSpan(poly: Point[], tOf: (p: Point) => number, tLo: number, tHi: number): Point[] {
  const clip = (pts: Point[], keep: (t: number) => number): Point[] => {
    const res: Point[] = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const da = keep(tOf(a)), db = keep(tOf(b));
      if (da >= 0) res.push(a);
      if ((da >= 0) !== (db >= 0)) {
        const s = da / (da - db);
        res.push({ x: a.x + (b.x - a.x) * s, y: a.y + (b.y - a.y) * s });
      }
    }
    return res;
  };
  return clip(clip(poly, t => t - tLo), t => tHi - t);
}

/** Accumulates flat-shaded, non-indexed prisms (same layout as ExtrudeGeometry). */
class PrismWriter {
  private pos: number[] = [];
  private nor: number[] = [];
  private baseY: number;
  constructor(baseY: number) { this.baseY = baseY; }

  prism(poly: Point[], y0: number, y1: number): void {
    if (poly.length < 3 || y1 - y0 < 1e-6) return;
    let area = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      area += a.x * b.y - b.x * a.y;
    }
    if (Math.abs(area) < 1e-10) return;
    const ccw = area > 0 ? poly : [...poly].reverse();
    const yb = this.baseY + y0, yt = this.baseY + y1;
    // Model (x, y) → world (x, elevation, -y).
    const tris = ShapeUtils.triangulateShape(ccw.map(p => new Vector2(p.x, p.y)), []);
    for (const [a, b, c] of tris) {
      const pa = ccw[a], pb = ccw[b], pc = ccw[c];
      this.tri(pa.x, yt, -pa.y, pb.x, yt, -pb.y, pc.x, yt, -pc.y, 0, 1, 0);
      this.tri(pa.x, yb, -pa.y, pc.x, yb, -pc.y, pb.x, yb, -pb.y, 0, -1, 0);
    }
    for (let i = 0; i < ccw.length; i++) {
      const a = ccw[i], b = ccw[(i + 1) % ccw.length];
      const ex = b.x - a.x, ey = b.y - a.y;
      const el = Math.hypot(ex, ey);
      if (el < 1e-9) continue;
      // Outward normal of a CCW edge is (ey, -ex) in model XY → (ey, 0, ex) in world.
      const nx = ey / el, nz = ex / el;
      this.tri(a.x, yb, -a.y, b.x, yb, -b.y, b.x, yt, -b.y, nx, 0, nz);
      this.tri(a.x, yb, -a.y, b.x, yt, -b.y, a.x, yt, -a.y, nx, 0, nz);
    }
  }

  /** One triangle, wound counter-clockwise when seen from the side `n` points to. */
  private tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number, nx: number, ny: number, nz: number): void {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
    if (fx * nx + fy * ny + fz * nz < 0) {
      this.pos.push(ax, ay, az, cx, cy, cz, bx, by, bz);
    } else {
      this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    }
    this.nor.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  }

  geometry(): BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(this.pos), 3));
    geo.setAttribute('normal', new BufferAttribute(new Float32Array(this.nor), 3));
    return geo;
  }
}
