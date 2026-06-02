/**
 * Pipe-body hit testing for auto T-junction insertion.
 *
 * Given a cursor point + a system-type filter, walks every MEP curve in the
 * document and returns the closest pipe whose body is within tolerance —
 * along with the cursor's projection onto that body. The drawing-side
 * caller (portDragTool / pipe endpoint handle) uses this to know "the user
 * is about to T into pipe X at point P".
 *
 * Pipes whose own endpoints lie within the tolerance are still candidates —
 * but the caller should ALWAYS prefer a connector snap over a body snap so
 * legitimate end-to-end joints don't get mis-classified as T's.
 */
import type { CanonicalElement, LineElement, SpatialLineElement, Point } from '../model/elements.ts';

const MEP_TABLES = new Set(['duct', 'pipe', 'conduit', 'cable_tray']);

/** Any straight-segment MEP curve — `line` or `spatial_line` geometry. */
export type MepCurveElement = LineElement | SpatialLineElement;

export interface PipeBodyHit {
  /** The pipe element that was hit. */
  pipe: MepCurveElement;
  /** Cursor's foot-of-perpendicular projection onto the pipe centreline. */
  point: Point;
  /** Distance from cursor to projection (world units). */
  distance: number;
  /** Parameter t ∈ [0,1] along the pipe (0 = start, 1 = end). */
  t: number;
}

/** Project `p` onto the segment `a → b`. Returns the projection + the
 *  parameter `t`. When the foot lies outside [0, 1] the closer endpoint is
 *  returned with `t` clamped. */
function projectOnSegment(p: Point, a: Point, b: Point): { point: Point; t: number } {
  const vx = b.x - a.x, vy = b.y - a.y;
  const lenSq = vx * vx + vy * vy;
  if (lenSq < 1e-9) return { point: a, t: 0 };
  let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return { point: { x: a.x + vx * t, y: a.y + vy * t }, t };
}

export interface PipeBodyHitOptions {
  /** Floor on the acceptable distance from cursor to pipe centreline
   *  (world units). The effective tolerance per pipe is the max of this
   *  value, half the pipe's stroke width, and `pickPadding`. */
  tolerance: number;
  /** Extra slack added on top of the pipe's stroke half-width so users
   *  don't have to land exactly on the visible edge. Default 0.10 m. */
  pickPadding?: number;
  /** When set, only pipes carrying this system_type are considered. */
  systemType?: string;
  /** Pipe ids to exclude from the search (e.g. the pipe being authored). */
  excludeIds?: ReadonlySet<string>;
  /** Reject hits within `endZoneRatio` of either pipe end so the result is
   *  always a "T into the body" rather than an end-to-end joint. Defaults
   *  to 0.05 (skip the outermost 5 % of the pipe at each end). */
  endZoneRatio?: number;
}

/** Walk every MEP curve in the document and return the closest valid hit. */
export function findPipeBodyHit(
  cursor: Point,
  elements: ReadonlyMap<string, CanonicalElement> | null | undefined,
  opts: PipeBodyHitOptions,
): PipeBodyHit | null {
  if (!elements) return null;
  const endZone = opts.endZoneRatio ?? 0.05;
  const pickPadding = opts.pickPadding ?? 0.10;
  let best: PipeBodyHit | null = null;
  for (const el of elements.values()) {
    if (!MEP_TABLES.has(el.tableName)) continue;
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    if (opts.excludeIds?.has(el.id)) continue;
    if (opts.systemType && (el.attrs.system_type ?? '') !== opts.systemType) continue;

    const ln = el as MepCurveElement;
    const proj = projectOnSegment(cursor, ln.start, ln.end);
    if (proj.t <= endZone || proj.t >= 1 - endZone) continue;

    const dx = cursor.x - proj.point.x;
    const dy = cursor.y - proj.point.y;
    const d = Math.hypot(dx, dy);
    // Per-pipe tolerance: max of caller floor + half the visual stroke
    // (so anywhere on the rendered pipe counts) + click padding.
    const strokeHalf = (ln.strokeWidth ?? 0) / 2;
    const perPipeTol = Math.max(opts.tolerance, strokeHalf + pickPadding);
    if (d > perPipeTol) continue;
    if (!best || d < best.distance) {
      best = { pipe: ln, point: proj.point, distance: d, t: proj.t };
    }
  }
  return best;
}
