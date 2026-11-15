/**
 * Batch foundation layout:
 *   - pads under selected columns, sized by a foundation type (or the
 *     given width × length × depth), top at the column base;
 *   - piles inside a pile cap by count and spacing (2 in line, 3 in a
 *     triangle, 4 square, 5 square + centre, 6 as 2 × 3, 9 as 3 × 3),
 *     aligned with the cap's longest edge, checked against the pile edge
 *     distance (`pileEdgeCheck`, `maxPileSpacing`);
 *   - pile caps with their piles under selected columns (`capsUnderColumns`).
 */
import type { CanonicalElement, Point, PointElement, PolygonElement } from './elements.ts';
import { generateId } from './ids.ts';
import { columnFootprint, insideFootprint } from '../elements/_framing.ts';
import { foundationKind } from '../elements/foundation.tsx';

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Point foundation element (pad / pile) at `p` with `attrs` (width / length / thickness / kind …). */
function pointFoundation(p: Point, attrs: Record<string, string>, ids: Set<string>): PointElement {
  const id = generateId('foundation', ids);
  ids.add(id);
  const w = parseFloat(attrs.width || '1.5') || 1.5;
  const l = parseFloat(attrs.length || '') || w;
  return {
    id, tableName: 'foundation', discipline: 'structure', geometry: 'point',
    position: { x: round3(p.x), y: round3(p.y) }, width: w, height: l,
    attrs: { ...attrs, id },
  };
}

/**
 * Pads under the given columns (skipping columns that already stand on a
 * point foundation). Each pad's top is its column's base (base_offset), its
 * plan turned with the column.
 */
export function padsUnderColumns(
  columns: readonly CanonicalElement[],
  existing: Iterable<CanonicalElement>,
  attrs: Record<string, string>,
  takenIds: Iterable<string>,
): PointElement[] {
  const ids = new Set(takenIds);
  const present = [...existing].filter(e => e.tableName === 'foundation' && e.geometry === 'point');
  const out: PointElement[] = [];
  for (const c of columns) {
    if (c.geometry !== 'point') continue;
    const fp = columnFootprint(c);
    if (fp && present.some(f => f.geometry === 'point' && insideFootprint(fp, f.position, 0.01))) continue;
    const a: Record<string, string> = { kind: 'pad', ...attrs, base_offset: c.attrs.base_offset || '0' };
    if (c.attrs.rotation && parseFloat(c.attrs.rotation)) a.rotation = c.attrs.rotation;
    out.push(pointFoundation(c.position, a, ids));
  }
  return out;
}

/** Pile positions (local, centred) for `count` piles `spacing` apart. */
export function pilePattern(count: number, spacing: number): Point[] {
  const s = spacing;
  switch (count) {
    case 1: return [{ x: 0, y: 0 }];
    case 2: return [{ x: -s / 2, y: 0 }, { x: s / 2, y: 0 }];
    case 3: {
      // Equilateral triangle around the centroid
      const h = (s * Math.sqrt(3)) / 2;
      return [{ x: -s / 2, y: -h / 3 }, { x: s / 2, y: -h / 3 }, { x: 0, y: (2 * h) / 3 }];
    }
    case 4: return [{ x: -s / 2, y: -s / 2 }, { x: s / 2, y: -s / 2 }, { x: s / 2, y: s / 2 }, { x: -s / 2, y: s / 2 }];
    case 5: {
      // Square of side s√2 so the corner piles are s from the centre one
      const a = s / Math.SQRT2;
      return [{ x: -a, y: -a }, { x: a, y: -a }, { x: a, y: a }, { x: -a, y: a }, { x: 0, y: 0 }];
    }
    case 6: return [-1, 0, 1].flatMap(i => [-0.5, 0.5].map(j => ({ x: i * s, y: j * s })));
    case 9: return [-1, 0, 1].flatMap(i => [-1, 0, 1].map(j => ({ x: i * s, y: j * s })));
    default: {
      // Rows of up to 3 along X
      const cols = Math.min(3, count), rows = Math.ceil(count / cols);
      const out: Point[] = [];
      for (let k = 0; k < count; k++) {
        const i = k % cols, j = Math.floor(k / cols);
        out.push({ x: (i - (cols - 1) / 2) * s, y: (j - (rows - 1) / 2) * s });
      }
      return out;
    }
  }
}

export const PILE_COUNTS = [2, 3, 4, 5, 6, 9];

function centroid(vs: readonly Point[]): Point {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < vs.length; i++) {
    const p = vs[i], q = vs[(i + 1) % vs.length];
    const c = p.x * q.y - q.x * p.y;
    a += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-12) return { x: vs.reduce((s, p) => s + p.x, 0) / vs.length, y: vs.reduce((s, p) => s + p.y, 0) / vs.length };
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Direction (radians) of a polygon's longest edge. */
function longestEdgeAngle(vs: readonly Point[]): number {
  let best = 0, ang = 0;
  for (let i = 0; i < vs.length; i++) {
    const p = vs[i], q = vs[(i + 1) % vs.length];
    const l = Math.hypot(q.x - p.x, q.y - p.y);
    if (l > best + 1e-9) { best = l; ang = Math.atan2(q.y - p.y, q.x - p.x); }
  }
  return ang;
}

/**
 * Piles inside a pile cap: `count` at `spacing`, centred on the cap and
 * aligned with its longest edge; each pile hangs from the cap's underside
 * (cap base_offset − cap thickness). Existing piles inside the cap are
 * returned in `replace` so the caller can swap them out.
 */
export function pilesInCap(
  cap: PolygonElement,
  count: number,
  spacing: number,
  attrs: Record<string, string>,
  takenIds: Iterable<string>,
  existing: Iterable<CanonicalElement> = [],
): { piles: PointElement[]; replace: string[] } {
  const ids = new Set(takenIds);
  const capTop = parseFloat(cap.attrs.base_offset || '0') || 0;
  const capT = parseFloat(cap.attrs.thickness || '1') || 1;
  const base = { kind: 'pile', ...attrs, base_offset: String(round3(capTop - capT)) };
  const piles = capPilePositions(cap.vertices, count, spacing).map(p => pointFoundation(p, base, ids));
  const replace = [...existing]
    .filter(e => e.tableName === 'foundation' && e.geometry === 'point' && foundationKind(e) === 'pile' && insidePolygon(e.position, cap.vertices))
    .map(e => e.id);
  return { piles, replace };
}

/**
 * Least pile-centre to cap-edge distance (JGJ 94 4.2.3 / GB 50007 8.5.3):
 * at least the pile diameter, and the pile's outer edge at least 150 mm in.
 */
export function pileEdgeMin(diameter: number, upm = 1): number {
  return Math.max(diameter, diameter / 2 + 0.15 * upm);
}

function segDist(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Signed distance of `p` to a polygon's boundary: positive inside, negative outside. */
export function edgeDistance(p: Point, vs: readonly Point[]): number {
  let d = Infinity;
  for (let i = 0; i < vs.length; i++) d = Math.min(d, segDist(p, vs[i], vs[(i + 1) % vs.length]));
  return insidePolygon(p, vs) ? d : -d;
}

/** Edge-distance check of piles in a cap: the worst (least) signed centre-to-edge distance and the required one. */
export function pileEdgeCheck(cap: readonly Point[], piles: readonly Point[], diameter: number, upm = 1): { least: number; required: number; ok: boolean; outside: number } {
  const required = pileEdgeMin(diameter, upm);
  let least = Infinity, outside = 0;
  for (const p of piles) {
    const d = edgeDistance(p, cap);
    if (d < 0) outside++;
    least = Math.min(least, d);
  }
  return { least, required, ok: least >= required - 1e-6, outside };
}

/** Pile centres of `pilesInCap` (same centring / alignment), without making elements. */
export function capPilePositions(cap: readonly Point[], count: number, spacing: number): Point[] {
  const c = centroid(cap);
  const ang = longestEdgeAngle(cap);
  const cos = Math.cos(ang), sin = Math.sin(ang);
  return pilePattern(count, spacing).map(p => ({ x: c.x + p.x * cos - p.y * sin, y: c.y + p.x * sin + p.y * cos }));
}

/**
 * Largest spacing (rounded down to 10 mm) at which `count` piles of `diameter`
 * keep the edge distance in the cap; 0 when even touching piles don't fit.
 */
export function maxPileSpacing(cap: readonly Point[], count: number, diameter: number, upm = 1): number {
  const fits = (s: number) => pileEdgeCheck(cap, capPilePositions(cap, count, s), diameter, upm).ok;
  if (count <= 1) return 0;
  let lo = 0, hi = 0;
  for (const v of cap) for (const w of cap) hi = Math.max(hi, Math.hypot(v.x - w.x, v.y - w.y));
  if (!fits(diameter)) return 0;
  lo = diameter;
  for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (fits(m)) lo = m; else hi = m; }
  const step = 0.01 * upm;
  return Math.floor(lo / step + 1e-9) * step;
}

/** Rectangle (local, centred) of a cap holding `count` piles at `spacing` with the edge distance. */
export function capSizeFor(count: number, spacing: number, diameter: number, upm = 1): { x: number; y: number } {
  const pts = pilePattern(count, spacing);
  const e = pileEdgeMin(diameter, upm);
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  // Centre the box on the pattern (a triangle's centroid isn't its box centre)
  return { x: round3(Math.max(...xs) - Math.min(...xs) + 2 * e), y: round3(Math.max(...ys) - Math.min(...ys) + 2 * e) };
}

/**
 * Pile caps under columns, each with its piles (Revit-style batch by
 * column): a rectangular cap sized for `count` piles at `spacing` with the
 * edge distance, turned with the column, top at the column base; the piles
 * hang from its underside. Columns already standing in a cap are skipped.
 */
export function capsUnderColumns(
  columns: readonly CanonicalElement[],
  existing: Iterable<CanonicalElement>,
  count: number,
  spacing: number,
  capAttrs: Record<string, string>,
  pileAttrs: Record<string, string>,
  takenIds: Iterable<string>,
  upm = 1,
): CanonicalElement[] {
  const ids = new Set(takenIds);
  const caps = [...existing].filter((e): e is PolygonElement => e.tableName === 'foundation' && e.geometry === 'polygon' && foundationKind(e) === 'pile_cap');
  const d = parseFloat(pileAttrs.width || '') || 0.6 * upm;
  const size = capSizeFor(count, spacing, d, upm);
  const pts = pilePattern(count, spacing);
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const off = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 };
  const out: CanonicalElement[] = [];
  for (const c of columns) {
    if (c.geometry !== 'point') continue;
    if (caps.some(cap => insidePolygon(c.position, cap.vertices))) continue;
    const ang = (parseFloat(c.attrs.rotation || '0') || 0) * Math.PI / 180;
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const at = (x: number, y: number): Point => ({ x: round3(c.position.x + x * cos - y * sin), y: round3(c.position.y + x * sin + y * cos) });
    const hx = size.x / 2, hy = size.y / 2;
    const id = generateId('foundation', ids);
    ids.add(id);
    const top = c.attrs.base_offset || '0';
    const cap: PolygonElement = {
      id, tableName: 'foundation', discipline: 'structure', geometry: 'polygon',
      vertices: [at(-hx, -hy), at(hx, -hy), at(hx, hy), at(-hx, hy)],
      attrs: { thickness: String(1 * upm), material: 'concrete', ...capAttrs, kind: 'pile_cap', base_offset: top, id },
    };
    out.push(cap);
    const capT = parseFloat(cap.attrs.thickness) || upm;
    const base = { kind: 'pile', ...pileAttrs, base_offset: String(round3((parseFloat(top) || 0) - capT)) };
    for (const p of pts) out.push(pointFoundation(at(p.x - off.x, p.y - off.y), base, ids));
  }
  return out;
}

function insidePolygon(p: Point, vs: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const a = vs[i], b = vs[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
