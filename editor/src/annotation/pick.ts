/**
 * Picking dimension references under the cursor and turning picked
 * references into dimension rows (single, chain, wall run). Pure: used by the
 * dimension tool and unit-tested on its own.
 */
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { ANNOTATION_DISCIPLINE, fmtCoord, isAnnotationTable } from './model.ts';
import {
  formatRef, isHostedOpening, thicknessOf, projectOntoLine, sub, add, mul, dot, len, metre,
  type DimensionAnchor, type Lookup,
} from './geometry.ts';

export interface PickedRef {
  ref: string;
  /** Measured point on the reference. */
  point: Point;
  /** Unit direction of a line reference (walls, grids, faces; door/window jambs). */
  dir?: Point;
  /** Picked on a door / window. */
  opening?: boolean;
  /** Element id, for highlighting. */
  elementId: string;
}

/** Tables a dimension may reference (rooms and annotations are not geometry). */
function referenceable(el: CanonicalElement): boolean {
  if (isAnnotationTable(el.tableName)) return false;
  return el.tableName !== 'space' && el.tableName !== 'connector' && el.tableName !== 'mep_node';
}

function segDistance(p: Point, a: Point, b: Point): { d: number; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return { d: len(sub(p, add(a, mul(ab, t)))), t };
}

/**
 * Best reference within `tol` model units of `p`. Openings beat walls (they
 * sit on them), end points beat faces/centre lines, faces vs centre line is
 * whichever is closer.
 */
export function pickReference(p: Point, elements: Iterable<CanonicalElement>, tol: number, lookup: Lookup): PickedRef | null {
  let best: { pick: PickedRef; score: number } | null = null;
  const offer = (pick: PickedRef, dist: number, priority: number) => {
    const score = dist - priority * tol;
    if (!best || score < best.score) best = { pick, score };
  };

  for (const el of elements) {
    if (!referenceable(el)) continue;
    if (el.geometry === 'line' || el.geometry === 'spatial_line') {
      const ln = el as LineElement;
      const dirV = sub(ln.end, ln.start);
      const L = len(dirV);
      if (L < 1e-6 || ln.arc) {
        if (L >= 1e-6) {
          // Curved: end points only
          for (const [anchor, q] of [['start', ln.start], ['end', ln.end]] as const) {
            const d = len(sub(p, q));
            if (d <= tol) offer({ ref: formatRef(el.id, anchor), point: q, elementId: el.id }, d, 2);
          }
        }
        continue;
      }
      const u = mul(dirV, 1 / L);
      const n = { x: -u.y, y: u.x };
      const half = thicknessOf(el, lookup) / 2;
      const { d } = segDistance(p, ln.start, ln.end);
      if (isHostedOpening(el)) {
        if (d > half + tol) continue;
        const ds = len(sub(p, ln.start)), de = len(sub(p, ln.end));
        if (Math.min(ds, de) <= Math.max(tol, half)) {
          const [anchor, q] = ds < de ? ['start', ln.start] as const : ['end', ln.end] as const;
          offer({ ref: formatRef(el.id, anchor), point: q, dir: n, opening: true, elementId: el.id }, Math.min(ds, de), 4);
        } else {
          offer({ ref: el.id, point: { x: (ln.start.x + ln.end.x) / 2, y: (ln.start.y + ln.end.y) / 2 }, dir: n, opening: true, elementId: el.id }, d, 3);
        }
        continue;
      }
      if (d > half + tol) continue;
      for (const [anchor, q] of [['start', ln.start], ['end', ln.end]] as const) {
        const de = len(sub(p, q));
        if (de <= tol) offer({ ref: formatRef(el.id, anchor), point: q, elementId: el.id }, de, 2);
      }
      const s = dot(sub(p, ln.start), n); // signed distance from the centre line
      const options: [DimensionAnchor, number][] = [['', Math.abs(s)]];
      if (half > 0.01) options.push(['left', Math.abs(s - half)], ['right', Math.abs(s + half)]);
      options.sort((a, b) => a[1] - b[1]);
      const [anchor, dist] = options[0];
      const shift = anchor === 'left' ? half : anchor === 'right' ? -half : 0;
      const a = add(ln.start, mul(n, shift)), b = add(ln.end, mul(n, shift));
      offer({ ref: formatRef(el.id, anchor), point: projectOntoLine(p, a, b), dir: u, elementId: el.id }, dist, 1);
    } else if (el.geometry === 'point') {
      const r = Math.max(el.width, el.height) / 2;
      const d = len(sub(p, el.position));
      if (d <= r + tol) offer({ ref: el.id, point: el.position, elementId: el.id }, Math.max(0, d - r), 1);
    }
  }
  return best ? (best as { pick: PickedRef }).pick : null;
}

export type DimMode = 'aligned' | 'linear';

/** Measurement direction (deg, null = aligned) for picked refs and the cursor. */
export function chainDirection(picks: PickedRef[], cursor: Point, mode: DimMode): number | null {
  if (picks.length < 2) return null;
  if (mode === 'linear') {
    const xs = picks.map(p => p.point.x), ys = picks.map(p => p.point.y);
    const outX = Math.max(0, Math.min(...xs) - cursor.x, cursor.x - Math.max(...xs));
    const outY = Math.max(0, Math.min(...ys) - cursor.y, cursor.y - Math.max(...ys));
    return outY >= outX ? 0 : 90;
  }
  // Wall ends carry no direction; walls / faces / grids set it, door and
  // window jambs only when no wall-like reference was picked
  const lineRef = picks.find(p => p.dir && !p.opening) ?? picks.find(p => p.dir);
  if (lineRef?.dir) {
    // Perpendicular to the first line reference (wall-to-wall distance)
    return Math.atan2(lineRef.dir.x, -lineRef.dir.y) * 180 / Math.PI;
  }
  if (picks.length === 2) return null;
  const d = sub(picks[picks.length - 1].point, picks[0].point);
  return Math.atan2(d.y, d.x) * 180 / Math.PI;
}

export interface DimRowDraft {
  p1: Point; p2: Point;
  ref1: string; ref2: string;
  direction: number | null;
  offset: number;
}

/** Segments of a chain through `picks`, sorted along the direction, with the line through `cursor`. */
export function chainRows(picks: PickedRef[], cursor: Point, direction: number | null): DimRowDraft[] {
  if (picks.length < 2) return [];
  let u: Point;
  if (direction === null) {
    const d = sub(picks[1].point, picks[0].point);
    const l = len(d);
    if (l < 1e-9) return [];
    u = mul(d, 1 / l);
  } else {
    const a = direction * Math.PI / 180;
    u = { x: Math.cos(a), y: Math.sin(a) };
  }
  const n = { x: -u.y, y: u.x };
  const sorted = direction === null ? picks : [...picks].sort((a, b) => dot(a.point, u) - dot(b.point, u));
  const rows: DimRowDraft[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i], b = sorted[i + 1];
    if (Math.abs(dot(sub(b.point, a.point), u)) < 1e-4) continue; // same position along the chain
    rows.push({ p1: a.point, p2: b.point, ref1: a.ref, ref2: b.ref, direction, offset: dot(sub(cursor, a.point), n) });
  }
  return rows;
}

/** References along one wall: its ends, opening edges and walls meeting it. */
export function wallRunPicks(wall: LineElement, elements: Iterable<CanonicalElement>, lookup: Lookup): PickedRef[] {
  const L = len(sub(wall.end, wall.start));
  if (L < 1e-6 || wall.arc) return [];
  const u = mul(sub(wall.end, wall.start), 1 / L);
  const n = { x: -u.y, y: u.x };
  const picks: PickedRef[] = [
    { ref: formatRef(wall.id, 'start'), point: wall.start, elementId: wall.id },
    { ref: formatRef(wall.id, 'end'), point: wall.end, elementId: wall.id },
  ];
  const tol = 0.02 * metre();
  for (const el of elements) {
    if (el.id === wall.id || el.geometry !== 'line') continue;
    if (isHostedOpening(el)) {
      if (el.hostId !== wall.id) continue;
      picks.push({ ref: formatRef(el.id, 'start'), point: el.start, dir: n, opening: true, elementId: el.id });
      picks.push({ ref: formatRef(el.id, 'end'), point: el.end, dir: n, opening: true, elementId: el.id });
      continue;
    }
    if (!['wall', 'structure_wall', 'curtain_wall'].includes(el.tableName) || (el as LineElement).arc) continue;
    // A wall meeting this one (T or L junction): centre line where it lands
    for (const q of [el.start, el.end]) {
      const t = dot(sub(q, wall.start), u);
      const off = Math.abs(dot(sub(q, wall.start), n));
      const half = thicknessOf(wall, lookup) / 2;
      if (off <= half + tol && t > tol && t < L - tol) {
        picks.push({ ref: el.id, point: add(wall.start, mul(u, t)), elementId: el.id });
      }
    }
  }
  return picks;
}

/** Build dimension elements for drafted rows. */
export function dimensionElements(rows: DimRowDraft[], existingIds: Iterable<string>): LineElement[] {
  const ids = new Set(existingIds);
  return rows.map(r => {
    const id = generateId('dimension', ids);
    ids.add(id);
    return {
      geometry: 'line', id, tableName: 'dimension', discipline: ANNOTATION_DISCIPLINE,
      start: r.p1, end: r.p2, strokeWidth: 0.02,
      attrs: {
        start_x: fmtCoord(r.p1.x), start_y: fmtCoord(r.p1.y),
        end_x: fmtCoord(r.p2.x), end_y: fmtCoord(r.p2.y),
        start_ref: r.ref1, end_ref: r.ref2,
        direction: r.direction === null ? '' : fmtCoord(r.direction),
        offset: fmtCoord(r.offset), text: '',
      },
    };
  });
}
