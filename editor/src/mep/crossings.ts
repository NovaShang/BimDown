/**
 * Plan crossings between MEP runs. Where two runs cross in plan without
 * being connected, the lower one is drawn broken (a gap the width of the
 * upper one), the drafting convention for "passes underneath".
 *
 * Result per curve: gap intervals as plan distances from the (effective)
 * start, sorted and merged.
 */
import type { GeometryContext } from '../elements/archetypes.ts';
import type { LineElement, SpatialLineElement } from '../model/elements.ts';
import { MEP_LINE_TABLES } from '../model/mepTopology.ts';
import { effectiveMepLine } from '../model/mepFittingRender.ts';
import { curveSection, curveZ } from './fittings.ts';
import { parsePortRef } from '../utils/portRef.ts';

type MepCurve = LineElement | SpatialLineElement;

interface Seg {
  id: string;
  ax: number; ay: number; bx: number; by: number;
  za: number; zb: number;
  len: number;
  half: number;
  hosts: Set<string>;
}

const CELL = 2;
/** Height difference below which two crossing runs are treated as level (a clash, not over/under). */
const LEVEL_EPS = 0.01;

export function mepCrossingGaps(ctx: GeometryContext): Map<string, [number, number][]> {
  return ctx.memo('mep:crossings', () => {
    const segs: Seg[] = [];
    for (const table of MEP_LINE_TABLES) {
      for (const el of ctx.elementsByTable(table)) {
        if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
        if ((el as MepCurve).arc) continue;
        const ln = effectiveMepLine(el as MepCurve, ctx);
        const dx = ln.end.x - ln.start.x, dy = ln.end.y - ln.start.y;
        const len = Math.hypot(dx, dy);
        if (len < 0.05) continue;
        const { startZ, endZ } = curveZ(ln);
        const sec = curveSection(ln);
        const hosts = new Set<string>();
        for (const r of [ln.attrs.from, ln.attrs.to]) { const p = parsePortRef(r); if (p) hosts.add(p.hostId); }
        segs.push({ id: ln.id, ax: ln.start.x, ay: ln.start.y, bx: ln.end.x, by: ln.end.y, za: startZ, zb: endZ, len, half: sec.w / 2, hosts });
      }
    }
    const grid = new Map<string, number[]>();
    segs.forEach((s, i) => {
      const x0 = Math.floor(Math.min(s.ax, s.bx) / CELL), x1 = Math.floor(Math.max(s.ax, s.bx) / CELL);
      const y0 = Math.floor(Math.min(s.ay, s.by) / CELL), y1 = Math.floor(Math.max(s.ay, s.by) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = `${x}|${y}`;
        const list = grid.get(k);
        if (list) list.push(i); else grid.set(k, [i]);
      }
    });
    const gaps = new Map<string, [number, number][]>();
    const tested = new Set<string>();
    for (const list of grid.values()) {
      for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
        const i = list[p], j = list[q];
        const key = i < j ? `${i},${j}` : `${j},${i}`;
        if (tested.has(key)) continue;
        tested.add(key);
        const a = segs[i], b = segs[j];
        if ([...a.hosts].some(h => b.hosts.has(h))) continue; // joined at a fitting
        const hit = intersect(a, b);
        if (!hit) continue;
        const za = a.za + (a.zb - a.za) * hit.ta;
        const zb = b.za + (b.zb - b.za) * hit.tb;
        if (Math.abs(za - zb) < LEVEL_EPS) continue;
        const [lower, upper, t] = za < zb ? [a, b, hit.ta] : [b, a, hit.tb];
        const s = t * lower.len;
        // Keep ends clear: a crossing right at a fitting is not an over/under.
        if (s < upper.half || s > lower.len - upper.half) continue;
        const g = (upper.half + 0.06) / Math.max(hit.sin, 0.2);
        const list2 = gaps.get(lower.id) ?? [];
        list2.push([Math.max(0, s - g), Math.min(lower.len, s + g)]);
        gaps.set(lower.id, list2);
      }
    }
    for (const [id, list] of gaps) gaps.set(id, mergeIntervals(list));
    return gaps;
  });
}

function intersect(a: Seg, b: Seg): { ta: number; tb: number; sin: number } | null {
  const rx = a.bx - a.ax, ry = a.by - a.ay;
  const sx = b.bx - b.ax, sy = b.by - b.ay;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const qx = b.ax - a.ax, qy = b.ay - a.ay;
  const ta = (qx * sy - qy * sx) / den;
  const tb = (qx * ry - qy * rx) / den;
  if (ta <= 0 || ta >= 1 || tb <= 0 || tb >= 1) return null;
  return { ta, tb, sin: Math.abs(den) / (a.len * b.len) };
}

export function mergeIntervals(list: [number, number][]): [number, number][] {
  const sorted = [...list].sort((p, q) => p[0] - q[0]);
  const out: [number, number][] = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}

type P = { x: number; y: number };

/** Remove gap intervals (distances along `u` from `origin`) from a segment. */
export function clipSegment(a: P, b: P, origin: P, u: P, gaps: [number, number][]): [P, P][] {
  const sa = (a.x - origin.x) * u.x + (a.y - origin.y) * u.y;
  const sb = (b.x - origin.x) * u.x + (b.y - origin.y) * u.y;
  if (Math.abs(sb - sa) < 1e-9) {
    // Cap edge (across the run): drop it if it sits inside a gap.
    return gaps.some(([g0, g1]) => sa > g0 && sa < g1) ? [] : [[a, b]];
  }
  const lo = Math.min(sa, sb), hi = Math.max(sa, sb);
  const at = (s: number): P => {
    const t = (s - sa) / (sb - sa);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
  };
  let pieces: [number, number][] = [[lo, hi]];
  for (const [g0, g1] of gaps) {
    const next: [number, number][] = [];
    for (const [p0, p1] of pieces) {
      if (g1 <= p0 || g0 >= p1) { next.push([p0, p1]); continue; }
      if (g0 > p0) next.push([p0, g0]);
      if (g1 < p1) next.push([g1, p1]);
    }
    pieces = next;
  }
  return pieces.filter(([p0, p1]) => p1 - p0 > 1e-6).map(([p0, p1]) => [at(p0), at(p1)]);
}

/** Clip a polygon to the half-plane `dot(p - origin, u) <= s` (keep = 'below') or `>= s`. */
function clipHalf(poly: P[], origin: P, u: P, s: number, keepBelow: boolean): P[] {
  const out: P[] = [];
  const f = (p: P) => ((p.x - origin.x) * u.x + (p.y - origin.y) * u.y - s) * (keepBelow ? -1 : 1);
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i], nxt = poly[(i + 1) % poly.length];
    const fc = f(cur), fn = f(nxt);
    if (fc >= 0) out.push(cur);
    if ((fc >= 0) !== (fn >= 0)) {
      const t = fc / (fc - fn);
      out.push({ x: cur.x + (nxt.x - cur.x) * t, y: cur.y + (nxt.y - cur.y) * t });
    }
  }
  return out;
}

/** Split a fill polygon into the pieces outside the gap slabs. */
export function clipPolygon(poly: P[], origin: P, u: P, gaps: [number, number][]): P[][] {
  let pieces: P[][] = [poly];
  for (const [g0, g1] of gaps) {
    const next: P[][] = [];
    for (const pc of pieces) {
      const before = clipHalf(pc, origin, u, g0, true);
      const after = clipHalf(pc, origin, u, g1, false);
      if (before.length >= 3) next.push(before);
      if (after.length >= 3) next.push(after);
    }
    pieces = next;
  }
  return pieces;
}
