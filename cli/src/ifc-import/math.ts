/** Small vector / matrix helpers (4×4 column-major, like web-ifc). */

export type Mat4 = number[];
export interface V2 { x: number; y: number }
export interface V3 { x: number; y: number; z: number }

export function mat4FromColumnMajor(a: ArrayLike<number>): Mat4 {
  return Array.from(a);
}

/** Copy with the translation multiplied by `s` (file units → meters). */
export function scaleTranslation(m: Mat4, s: number): Mat4 {
  const r = m.slice();
  r[12] *= s; r[13] *= s; r[14] *= s;
  return r;
}

export function mul(a: Mat4, b: Mat4): Mat4 {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + row] * b[c * 4 + k];
      r[c * 4 + row] = s;
    }
  }
  return r;
}

export function apply(m: Mat4, x: number, y: number, z: number): V3 {
  return {
    x: m[0] * x + m[4] * y + m[8] * z + m[12],
    y: m[1] * x + m[5] * y + m[9] * z + m[13],
    z: m[2] * x + m[6] * y + m[10] * z + m[14],
  };
}

/** Rotate a direction (no translation). */
export function applyDir(m: Mat4, x: number, y: number, z: number): V3 {
  return { x: m[0] * x + m[4] * y + m[8] * z, y: m[1] * x + m[5] * y + m[9] * z, z: m[2] * x + m[6] * y + m[10] * z };
}

export const sub3 = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const add3 = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const scale3 = (a: V3, s: number): V3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot3 = (a: V3, b: V3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const len3 = (a: V3): number => Math.hypot(a.x, a.y, a.z);
export function norm3(a: V3): V3 {
  const l = len3(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}
export function cross3(a: V3, b: V3): V3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export const sub2 = (a: V2, b: V2): V2 => ({ x: a.x - b.x, y: a.y - b.y });
export const add2 = (a: V2, b: V2): V2 => ({ x: a.x + b.x, y: a.y + b.y });
export const scale2 = (a: V2, s: number): V2 => ({ x: a.x * s, y: a.y * s });
export const dot2 = (a: V2, b: V2): number => a.x * b.x + a.y * b.y;
export const cross2 = (a: V2, b: V2): number => a.x * b.y - a.y * b.x;
export const len2 = (a: V2): number => Math.hypot(a.x, a.y);
export const dist2 = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.y - b.y);
export function norm2(a: V2): V2 {
  const l = len2(a) || 1;
  return { x: a.x / l, y: a.y / l };
}
/** Left normal of a direction. */
export const perp2 = (a: V2): V2 => ({ x: -a.y, y: a.x });

/** Distance from p to segment ab, and the parameter t ∈ [0, 1] of the closest point. */
export function segDistance(p: V2, a: V2, b: V2): { d: number; t: number } {
  const ab = sub2(b, a);
  const l2 = dot2(ab, ab);
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot2(sub2(p, a), ab) / l2));
  return { d: dist2(p, add2(a, scale2(ab, t))), t };
}

/** Intersection of the infinite lines a0→a1 and b0→b1: parameters along each, or null if parallel. */
export function lineIntersect(a0: V2, a1: V2, b0: V2, b1: V2): { t: number; s: number; p: V2 } | null {
  const da = sub2(a1, a0), db = sub2(b1, b0);
  const det = cross2(da, db);
  if (Math.abs(det) < 1e-9 * (len2(da) * len2(db) || 1)) return null;
  const r = sub2(b0, a0);
  const t = cross2(r, db) / det;
  const s = cross2(r, da) / det;
  return { t, s, p: add2(a0, scale2(da, t)) };
}

export function polygonArea(ring: V2[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
  return a / 2;
}

export function pointInRing(p: V2, ring: V2[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Round to millimetres (and drop -0). */
export function r3(n: number): number {
  const v = Math.round(n * 1000) / 1000;
  return v === 0 ? 0 : v;
}

/** Convex hull (monotone chain), CCW. */
export function convexHull(points: V2[]): V2[] {
  const pts = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return pts;
  const lower: V2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross2(sub2(lower[lower.length - 1], lower[lower.length - 2]), sub2(p, lower[lower.length - 1])) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: V2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross2(sub2(upper[upper.length - 1], upper[upper.length - 2]), sub2(p, upper[upper.length - 1])) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/** Oriented bounding rectangle in plan: centre, unit long axis `u`, length (along u) and width. */
export interface Obb2 { center: V2; u: V2; length: number; width: number }

/** Minimum-area enclosing rectangle (rotating calipers over the hull edges). */
export function minAreaRect(points: V2[]): Obb2 | null {
  const hull = convexHull(points);
  if (hull.length === 0) return null;
  if (hull.length < 3) {
    const a = hull[0], b = hull[hull.length - 1];
    const u = len2(sub2(b, a)) > 1e-9 ? norm2(sub2(b, a)) : { x: 1, y: 0 };
    return { center: scale2(add2(a, b), 0.5), u, length: dist2(a, b), width: 0 };
  }
  let best: Obb2 | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const e = sub2(hull[(i + 1) % hull.length], hull[i]);
    if (len2(e) < 1e-9) continue;
    const u = norm2(e), v = perp2(u);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of hull) {
      const pu = dot2(p, u), pv = dot2(p, v);
      if (pu < minU) minU = pu; if (pu > maxU) maxU = pu;
      if (pv < minV) minV = pv; if (pv > maxV) maxV = pv;
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area < bestArea - 1e-12) {
      bestArea = area;
      const c = add2(scale2(u, (minU + maxU) / 2), scale2(v, (minV + maxV) / 2));
      const lu = maxU - minU, lv = maxV - minV;
      best = lu >= lv ? { center: c, u, length: lu, width: lv } : { center: c, u: v, length: lv, width: lu };
    }
  }
  if (best) best.u = canonicalDir(best.u);
  return best;
}

/** Direction with a stable sign: +x half-plane (or +y when vertical). */
export function canonicalDir(u: V2): V2 {
  if (u.x < -1e-9 || (Math.abs(u.x) <= 1e-9 && u.y < 0)) return { x: -u.x, y: -u.y };
  return u;
}

/** Angle of a direction in degrees CCW from +X, normalised to (-180, 180]. */
export function angleDeg(u: V2): number {
  const a = (Math.atan2(u.y, u.x) * 180) / Math.PI;
  return a <= -180 ? a + 360 : a;
}
