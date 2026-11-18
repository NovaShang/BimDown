/**
 * Sloped floors (Revit "slope arrow"; spec slab.yaml `slope_arrow`): a slab
 * whose top is the plane through the arrow's tail and head heights, level
 * across the arrow. "tx,ty,tz;hx,hy,hz" = plan tail / head and their heights
 * above the slab's base (level + base_offset), model units. Thickness stays
 * vertical, so the whole body shifts by the plane's rise at each point.
 */
export interface P3 { x: number; y: number; z: number }
export interface SlopeArrow { tail: P3; head: P3 }
/** Rise above the flat slab: dz(x, y) = a·x + b·y + c. */
export interface SlopePlane { a: number; b: number; c: number }

/** Parse `slope_arrow`; null when blank, malformed or tail = head in plan. */
export function parseSlopeArrow(s: string | undefined): SlopeArrow | null {
  if (!s || !s.trim()) return null;
  const parts = s.split(';');
  if (parts.length !== 2) return null;
  const pts = parts.map(p => p.split(',').map(v => Number(v.trim())));
  if (pts.some(p => p.length !== 3 || p.some(v => !Number.isFinite(v)))) return null;
  const [t, h] = pts;
  if (Math.hypot(h[0] - t[0], h[1] - t[1]) < 1e-9) return null;
  return { tail: { x: t[0], y: t[1], z: t[2] }, head: { x: h[0], y: h[1], z: h[2] } };
}

const r = (v: number) => String(Math.round(v * 1e6) / 1e6);

export function formatSlopeArrow(a: SlopeArrow): string {
  return `${r(a.tail.x)},${r(a.tail.y)},${r(a.tail.z)};${r(a.head.x)},${r(a.head.y)},${r(a.head.z)}`;
}

/** The plane through tail and head, constant perpendicular to the arrow. */
export function slopePlane(a: SlopeArrow): SlopePlane {
  const dx = a.head.x - a.tail.x, dy = a.head.y - a.tail.y;
  const l2 = dx * dx + dy * dy;
  const k = (a.head.z - a.tail.z) / l2;
  const pa = k * dx, pb = k * dy;
  return { a: pa, b: pb, c: a.tail.z - pa * a.tail.x - pb * a.tail.y };
}

export function planeAt(p: SlopePlane, x: number, y: number): number {
  return p.a * x + p.b * y + p.c;
}

/** Slope of the plane in degrees. */
export function slopeDegrees(p: SlopePlane): number {
  return (Math.atan(Math.hypot(p.a, p.b)) * 180) / Math.PI;
}

/** The slab's plane from its attrs (null = flat). */
export function slabSlopeOf(attrs: Record<string, string>): SlopePlane | null {
  const a = parseSlopeArrow(attrs.slope_arrow);
  return a ? slopePlane(a) : null;
}

/** Rise range of the plane over a polygon (vertices are the extremes). */
export function planeRange(p: SlopePlane, vs: readonly { x: number; y: number }[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const v of vs) {
    const z = planeAt(p, v.x, v.y);
    lo = Math.min(lo, z); hi = Math.max(hi, z);
  }
  return vs.length ? [lo, hi] : [0, 0];
}

/** Default arrow for a slab outline: across its longest extent through the centroid, flat. */
export function defaultArrow(vs: readonly { x: number; y: number }[], at: { x: number; y: number }): SlopeArrow {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const v of vs) { minX = Math.min(minX, v.x); minY = Math.min(minY, v.y); maxX = Math.max(maxX, v.x); maxY = Math.max(maxY, v.y); }
  const alongX = maxX - minX >= maxY - minY;
  return alongX
    ? { tail: { x: minX, y: at.y, z: 0 }, head: { x: maxX, y: at.y, z: 0 } }
    : { tail: { x: at.x, y: minY, z: 0 }, head: { x: at.x, y: maxY, z: 0 } };
}
