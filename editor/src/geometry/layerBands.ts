/**
 * Layer bands of a straight layered wall: each type layer is the strip of the
 * wall footprint between two offsets from the centre line. Offsets are signed
 * along the wall's left normal (+ = left = exterior side, layer seq 1).
 */
import type { Point } from '../model/elements.ts';
import type { ResolvedLayer } from '../model/types/catalog.ts';

export interface LayerBand {
  /** Signed offsets from the centre line, lo < hi. */
  lo: number;
  hi: number;
  material: string;
  function: string;
}

/** Bands for `layers` (exterior first) of a wall `thickness` thick. */
export function layerBands(layers: ResolvedLayer[], thickness: number): LayerBand[] {
  const half = thickness / 2;
  return layers.map(l => ({
    hi: half - l.offset,
    lo: half - l.offset - l.thickness,
    material: l.material,
    function: l.function,
  }));
}

interface Frame { origin: Point; normal: Point }

/** Centre-line frame of a straight wall: origin = start, normal = unit left normal. */
export function wallFrame(start: Point, end: Point): Frame | null {
  const dx = end.x - start.x, dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  return { origin: start, normal: { x: -dy / len, y: dx / len } };
}

const dist = (p: Point, f: Frame) => (p.x - f.origin.x) * f.normal.x + (p.y - f.origin.y) * f.normal.y;

/** Sutherland–Hodgman: keep the part of `poly` where sign·(dist − d) ≥ 0. */
function clipHalf(poly: Point[], f: Frame, d: number, sign: 1 | -1): Point[] {
  const out: Point[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const da = sign * (dist(a, f) - d), db = sign * (dist(b, f) - d);
    if (da >= 0) out.push(a);
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** The part of `poly` between offsets lo and hi. */
export function clipToBand(poly: Point[], f: Frame, lo: number, hi: number): Point[] {
  const a = clipHalf(poly, f, lo, 1);
  return a.length < 3 ? [] : clipHalf(a, f, hi, -1);
}

/** The chord of `poly` on the line at offset `d` (the visible boundary between two layers). */
export function chordAt(poly: Point[], f: Frame, d: number): [Point, Point] | null {
  const pts: Point[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const da = dist(a, f) - d, db = dist(b, f) - d;
    if (Math.abs(da) < 1e-9) pts.push(a);
    else if (da * db < 0) {
      const t = da / (da - db);
      pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  if (pts.length < 2) return null;
  // extreme points along the wall direction
  const ux = f.normal.y, uy = -f.normal.x;
  const along = (p: Point) => (p.x - f.origin.x) * ux + (p.y - f.origin.y) * uy;
  let lo = pts[0], hi = pts[0];
  for (const p of pts) {
    if (along(p) < along(lo)) lo = p;
    if (along(p) > along(hi)) hi = p;
  }
  return along(hi) - along(lo) > 1e-6 ? [lo, hi] : null;
}
