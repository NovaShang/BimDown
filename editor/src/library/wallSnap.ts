/**
 * Placement snapping for library components: back against the nearest wall
 * face, sliding along it, flush into corners and against neighbours already
 * on the same wall (cabinet runs). Pure; model units, plan Y up.
 */
import { metre } from '../annotation/geometry.ts';
import type { CanonicalElement, LineElement, PointElement, Point } from '../model/elements.ts';
import { resolveFurniture } from './furnitureLibrary.generated.ts';

const WALL_TABLES = new Set(['wall', 'structure_wall', 'curtain_wall']);
/** How far beyond the component's own depth the cursor may be to still snap. */
const REACH_M = 0.5;
/** Distance within which an edge snaps flush to a corner or a neighbour. */
const FLUSH_M = 0.25;
const JOIN_TOL_M = 0.05;
const TIE_M = 0.05;
/** Distances above are metres; the model is in project units (`metre()` per metre). */
const REACH = () => REACH_M * metre(), FLUSH = () => FLUSH_M * metre(), JOIN_TOL = () => JOIN_TOL_M * metre(), TIE = () => TIE_M * metre();

export interface WallPose {
  position: Point;
  /** Degrees CCW; puts local +Y (the back) towards the wall. */
  rotationDeg: number;
  wallId: string;
}

interface Seg { id: string; a: Point; b: Point; half: number }

function wallSegments(elements: Iterable<CanonicalElement>): Seg[] {
  const out: Seg[] = [];
  for (const el of elements) {
    if (!WALL_TABLES.has(el.tableName)) continue;
    if (el.geometry !== 'line' && el.geometry !== 'spatial_line') continue;
    const l = el as LineElement;
    if (l.arc) continue;
    const half = (l.strokeWidth || 0.1 * metre()) / 2;
    out.push({ id: l.id, a: l.start, b: l.end, half });
  }
  return out;
}

function distToSeg(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/**
 * Usable span of `seg`'s face on `side` around `along`: bounded by the walls
 * that meet this face (L corners at its ends and partitions meeting it in a
 * T), each taking its half-thickness.
 */
function faceSpan(seg: Seg, len: number, ux: number, uy: number, side: number, along: number, segs: Seg[]): [number, number] {
  let lo = 0, hi = len;
  for (const s of segs) {
    if (s === seg) continue;
    for (const [e, o] of [[s.a, s.b], [s.b, s.a]] as const) {
      if (distToSeg(e, seg.a, seg.b) > seg.half + JOIN_TOL()) continue;
      // The other wall must run into this side of the face.
      const crossO = ux * (o.y - seg.a.y) - uy * (o.x - seg.a.x);
      if (crossO * side <= 0) continue;
      const t = (e.x - seg.a.x) * ux + (e.y - seg.a.y) * uy;
      if (t <= along) lo = Math.max(lo, t + s.half);
      else hi = Math.min(hi, t - s.half);
    }
  }
  return [lo, hi];
}

/**
 * Snap a component of plan size w × d so its back sits on the wall face
 * nearest to `cursor`. Returns null when no wall face is within reach.
 */
export function snapBackToWall(
  cursor: Point,
  w: number,
  d: number,
  elements: ReadonlyMap<string, CanonicalElement>,
  ignoreId?: string,
): WallPose | null {
  const segs = wallSegments(elements.values());
  let best: { seg: Seg; along: number; len: number; side: number; dist: number; ux: number; uy: number } | null = null;
  for (const seg of segs) {
    const dx = seg.b.x - seg.a.x, dy = seg.b.y - seg.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len, uy = dy / len;
    const rx = cursor.x - seg.a.x, ry = cursor.y - seg.a.y;
    const along = rx * ux + ry * uy;
    if (along < -w / 2 || along > len + w / 2) continue;
    const cross = ux * ry - uy * rx; // + = left of a→b
    const dist = Math.abs(cross);
    if (dist > seg.half + d + REACH()) continue;
    // In a corner both walls are about as close: the longer wall wins (a
    // desk runs along the room, not into its short end).
    const better = !best || dist < best.dist - TIE() || (dist <= best.dist + TIE() && len > best.len);
    if (better) best = { seg, along, len, side: cross >= 0 ? 1 : -1, dist, ux, uy };
  }
  if (!best) return null;

  const { seg, len, side, ux, uy } = best;
  // Usable span along the face between the walls that meet it.
  const [lo, hi] = faceSpan(seg, len, ux, uy, side, best.along, segs);
  const fits = hi - lo >= w;
  const clampSpan = (v: number) => (fits ? Math.max(lo + w / 2, Math.min(hi - w / 2, v)) : v);
  let along = clampSpan(best.along);
  if (fits) {
    if (along - w / 2 - lo < FLUSH()) along = lo + w / 2;
    if (hi - (along + w / 2) < FLUSH()) along = hi - w / 2;
  }

  // Flush against components already on this face (same orientation).
  const nx = -uy * side, ny = ux * side; // away from the wall, into the room
  const faceOff = seg.half;
  const rot = Math.atan2(-side * uy, -side * ux) * 180 / Math.PI;
  let snapped = false;
  for (const el of elements.values()) {
    if (snapped || el.tableName !== 'furniture' || el.geometry !== 'point' || el.id === ignoreId) continue;
    const p = el as PointElement;
    const r = resolveFurniture(p.attrs, metre());
    const er = parseFloat(p.attrs.rotation || '0') || 0;
    if (Math.abs(((er - rot) % 360 + 540) % 360 - 180) > 1) continue;
    const ox = p.position.x - seg.a.x, oy = p.position.y - seg.a.y;
    const offWall = ox * nx + oy * ny;
    if (Math.abs(offWall - (faceOff + r.size.d / 2)) > JOIN_TOL()) continue;
    const c = ox * ux + oy * uy;
    for (const edge of [c - r.size.w / 2, c + r.size.w / 2]) {
      if (Math.abs(along - w / 2 - edge) < FLUSH() && edge >= c) { along = edge + w / 2; snapped = true; break; }
      if (Math.abs(along + w / 2 - edge) < FLUSH() && edge <= c) { along = edge - w / 2; snapped = true; break; }
    }
  }
  // A neighbour never pushes it through the room's end walls.
  along = clampSpan(along);

  const off = faceOff + d / 2;
  return {
    position: { x: seg.a.x + ux * along + nx * off, y: seg.a.y + uy * along + ny * off },
    rotationDeg: normDeg(rot),
    wallId: seg.id,
  };
}

function normDeg(a: number): number {
  const r = Math.round(a * 1000) / 1000;
  const n = ((r % 360) + 360) % 360;
  return n === 360 ? 0 : n;
}
