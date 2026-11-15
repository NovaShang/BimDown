/**
 * Batch foundation layout:
 *   - pads under selected columns, sized by a foundation type (or the
 *     given width × length × depth), top at the column base;
 *   - piles inside a pile cap by count and spacing (2 in line, 3 in a
 *     triangle, 4 square, 5 square + centre, 6 as 2 × 3, 9 as 3 × 3),
 *     aligned with the cap's longest edge.
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
  const c = centroid(cap.vertices);
  const ang = longestEdgeAngle(cap.vertices);
  const cos = Math.cos(ang), sin = Math.sin(ang);
  const capTop = parseFloat(cap.attrs.base_offset || '0') || 0;
  const capT = parseFloat(cap.attrs.thickness || '1') || 1;
  const base = { kind: 'pile', ...attrs, base_offset: String(round3(capTop - capT)) };
  const piles = pilePattern(count, spacing).map(p => pointFoundation(
    { x: c.x + p.x * cos - p.y * sin, y: c.y + p.x * sin + p.y * cos }, base, ids));
  const replace = [...existing]
    .filter(e => e.tableName === 'foundation' && e.geometry === 'point' && foundationKind(e) === 'pile' && insidePolygon(e.position, cap.vertices))
    .map(e => e.id);
  return { piles, replace };
}

function insidePolygon(p: Point, vs: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const a = vs[i], b = vs[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
