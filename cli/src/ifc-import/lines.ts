/** Plan geometry of BimDown line elements (straight or arc) for hosting and joining. */
import type { ImportContext, OutEl, Position2 } from './context.js';
import { type V2, dist2, dot2, len2, norm2, sub2 } from './math.js';

export const BOUNDARY = new Set(['wall', 'structure_wall', 'curtain_wall', 'room_separator']);

export function endpoints(el: OutEl): [V2, V2] {
  const c = (el.geometry as { coordinates: Position2[] }).coordinates;
  return [{ x: c[0][0], y: c[0][1] }, { x: c[c.length - 1][0], y: c[c.length - 1][1] }];
}

export function setEndpoint(el: OutEl, end: 0 | 1, p: V2): void {
  const c = (el.geometry as { coordinates: Position2[] }).coordinates;
  c[end === 0 ? 0 : c.length - 1] = [Math.round(p.x * 1000) / 1000, Math.round(p.y * 1000) / 1000];
}

/** Length along the element (arc-aware). */
export function lineLength(ctx: ImportContext, el: OutEl): number {
  const [a, b] = endpoints(el);
  const arc = ctx.lines.get(el)?.arc;
  return arc ? arc.radius * arcSweep(arc.center, arc.ccw, a, b) : dist2(a, b);
}

function arcSweep(center: V2, ccw: boolean, a: V2, b: V2): number {
  const a0 = Math.atan2(a.y - center.y, a.x - center.x), a1 = Math.atan2(b.y - center.y, b.x - center.x);
  let s = ccw ? a1 - a0 : a0 - a1;
  while (s < 0) s += 2 * Math.PI;
  return s;
}

/**
 * Closest point of `p` on the element: distance from the start along the
 * element (`t`, meters), perpendicular distance `d`, and the element length.
 */
export function project(ctx: ImportContext, el: OutEl, p: V2): { t: number; d: number; length: number; dir: V2 } {
  const [a, b] = endpoints(el);
  const arc = ctx.lines.get(el)?.arc;
  if (arc) {
    const total = arcSweep(arc.center, arc.ccw, a, b);
    const s = arcSweep(arc.center, arc.ccw, a, p);
    const r = dist2(p, arc.center);
    const along = s <= total ? s : (s - total < 2 * Math.PI - s ? total : 0);
    const radial = { x: (p.x - arc.center.x) / (r || 1), y: (p.y - arc.center.y) / (r || 1) };
    const dir = arc.ccw ? { x: -radial.y, y: radial.x } : { x: radial.y, y: -radial.x };
    return { t: along * arc.radius, d: Math.abs(r - arc.radius), length: total * arc.radius, dir };
  }
  const ab = sub2(b, a);
  const L = len2(ab);
  const u = L > 1e-9 ? norm2(ab) : { x: 1, y: 0 };
  const t = dot2(sub2(p, a), u);
  const tc = Math.max(0, Math.min(L, t));
  const q = { x: a.x + u.x * tc, y: a.y + u.y * tc };
  return { t, d: dist2(p, q), length: L, dir: u };
}
