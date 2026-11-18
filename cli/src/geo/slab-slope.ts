/**
 * Sloped floors (spec slab.yaml `slope_arrow`): "tx,ty,tz;hx,hy,hz" = plan
 * tail / head and the top's height above level + base_offset at each. Same
 * rule as the editor's geometry/slabSlope.ts.
 */
export interface SlopeArrow { tail: { x: number; y: number; z: number }; head: { x: number; y: number; z: number } }

/** Parsed arrow, or an error message for a malformed value (null = blank). */
export function parseSlopeArrow(s: string | undefined): SlopeArrow | string | null {
  if (!s || !s.trim()) return null;
  const parts = s.split(';');
  const pts = parts.map(p => p.split(',').map(v => Number(v.trim())));
  if (parts.length !== 2 || pts.some(p => p.length !== 3 || p.some(v => !Number.isFinite(v)))) {
    return 'must be "tx,ty,tz;hx,hy,hz" (tail and head: plan x, y and the top height above the slab base)';
  }
  const [t, h] = pts;
  if (Math.hypot(h[0] - t[0], h[1] - t[1]) < 1e-9) return 'tail and head must be different plan points';
  return { tail: { x: t[0], y: t[1], z: t[2] }, head: { x: h[0], y: h[1], z: h[2] } };
}

/** Top rise above the flat slab at a plan point. */
export function slopeRiseAt(a: SlopeArrow, x: number, y: number): number {
  const dx = a.head.x - a.tail.x, dy = a.head.y - a.tail.y;
  return a.tail.z + ((a.head.z - a.tail.z) * ((x - a.tail.x) * dx + (y - a.tail.y) * dy)) / (dx * dx + dy * dy);
}
