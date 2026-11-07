/**
 * Revit-style wall modify operations as pure patch builders:
 *   - trim / extend two walls to a corner
 *   - trim / extend one wall to a reference line (wall or grid)
 *   - split a wall at a point (hosted doors / windows go to the right half)
 *
 * Each returns a patch map (id → element, null = delete) ready for
 * APPLY_PATCH, or null when the operation does not apply.
 */
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { resolveHostedGeometry } from './hosted.ts';
import { arcFromMidpoint, nearestPointOnArc, pointOnArc } from './arc.ts';
import { intersectLines, isJoinable, projectOnWall, wallFrame, wallLength, type LineLike } from './wallJoins.ts';

export type Patch = Map<string, CanonicalElement | null>;

const MIN_LEN = 0.02;

export interface RefLine { p: Point; d: Point }

function lineOf(w: { start: Point; end: Point }): RefLine | null {
  const f = wallFrame(w);
  return f ? { p: w.start, d: f.u } : null;
}

/** Straight joinable wall by id, or null. */
export function straightWall(elements: ReadonlyMap<string, CanonicalElement>, id: string | null | undefined): LineLike | null {
  if (!id) return null;
  const el = elements.get(id);
  return isJoinable(el) && !el.arc ? el : null;
}

/**
 * Move the end of `w` so it lands on `x`. If `x` falls inside the wall the
 * side holding `pick` is kept; otherwise the nearer end extends to `x`.
 */
export function trimOrExtendTo(w: LineElement, pick: Point, x: Point): LineElement | null {
  const f = wallFrame(w);
  const tx = projectOnWall(w, x)?.along;
  const tp = projectOnWall(w, pick)?.along;
  if (!f || tx == null || tp == null) return null;
  let next: LineElement;
  if (tx > MIN_LEN && tx < f.len - MIN_LEN) {
    next = tp < tx ? { ...w, end: { ...x } } : { ...w, start: { ...x } };
  } else {
    next = tx <= f.len / 2 ? { ...w, start: { ...x } } : { ...w, end: { ...x } };
  }
  if (Math.hypot(next.end.x - next.start.x, next.end.y - next.start.y) < MIN_LEN) return null;
  return next;
}

/** Re-seat the hosted children of a wall whose ends moved along its own line:
 *  each keeps its plan location; ones left outside the wall are deleted. */
function seatAfterTrim(elements: ReadonlyMap<string, CanonicalElement>, patch: Patch, oldWall: LineElement, newWall: LineElement) {
  const len = wallLength(newWall);
  for (const el of elements.values()) {
    if (el.hostId !== oldWall.id || (el.geometry !== 'line' && el.geometry !== 'spatial_line')) continue;
    const h = el as LineElement;
    const c = { x: (h.start.x + h.end.x) / 2, y: (h.start.y + h.end.y) / 2 };
    const along = projectOnWall(newWall, c)?.along ?? 0;
    if (along < 0 || along > len) { patch.set(h.id, null); continue; }
    const width = parseFloat(h.attrs.width ?? '0.9') || 0.9;
    const pos = Math.max(Math.min(width / 2, len / 2), Math.min(len - Math.min(width / 2, len / 2), along));
    const { start, end } = resolveHostedGeometry(newWall, pos, width);
    patch.set(h.id, { ...h, start, end, locationParam: pos, attrs: { ...h.attrs, position: String(Math.round(pos * 1e4) / 1e4) } });
  }
}

/** Trim / extend walls `a` and `b` to the corner where their lines meet. */
export function trimExtendToCorner(
  elements: ReadonlyMap<string, CanonicalElement>,
  aId: string, aPick: Point,
  bId: string, bPick: Point,
): Patch | null {
  if (aId === bId) return null;
  const a = straightWall(elements, aId), b = straightWall(elements, bId);
  const la = a && lineOf(a), lb = b && lineOf(b);
  if (!a || !b || !la || !lb) return null;
  const x = intersectLines(la.p, la.d, lb.p, lb.d);
  if (!x) return null;
  const na = trimOrExtendTo(a, aPick, x), nb = trimOrExtendTo(b, bPick, x);
  if (!na || !nb) return null;
  const patch: Patch = new Map([[a.id, na], [b.id, nb]]);
  seatAfterTrim(elements, patch, a, na);
  seatAfterTrim(elements, patch, b, nb);
  return patch;
}

/** Trim / extend wall `targetId` to a reference line (another wall's centreline or a grid). */
export function trimExtendToReference(
  elements: ReadonlyMap<string, CanonicalElement>,
  ref: RefLine,
  targetId: string, targetPick: Point,
): Patch | null {
  const w = straightWall(elements, targetId);
  const lw = w && lineOf(w);
  if (!w || !lw) return null;
  const x = intersectLines(lw.p, lw.d, ref.p, ref.d);
  if (!x) return null;
  const nw = trimOrExtendTo(w, targetPick, x);
  if (!nw) return null;
  const patch: Patch = new Map([[w.id, nw]]);
  seatAfterTrim(elements, patch, w, nw);
  return patch;
}

/** Reference line of a picked wall-like element (straight only). */
export function refLineOfElement(el: CanonicalElement | undefined): RefLine | null {
  if (!el || (el.geometry !== 'line' && el.geometry !== 'spatial_line') || el.arc) return null;
  return lineOf(el);
}

/** Distance along `w` (metres) of the point on it nearest to `p`. */
function alongWall(w: LineElement, p: Point): number {
  if (w.arc) return nearestPointOnArc(p, w.start, w.end, w.arc).t * wallLength(w);
  return Math.max(0, Math.min(wallLength(w), projectOnWall(w, p)?.along ?? 0));
}

/**
 * Split wall `wallId` at the point nearest `at`. The original keeps its id
 * and the start half; the end half is a new wall with the same attributes.
 * A split point inside a door / window moves to that opening's nearer edge.
 */
export function splitWall(
  elements: ReadonlyMap<string, CanonicalElement>,
  wallId: string,
  at: Point,
): { patch: Patch; newId: string; point: Point } | null {
  const w = elements.get(wallId);
  if (!isJoinable(w)) return null;
  const len = wallLength(w);
  let s = alongWall(w, at);
  const children: LineElement[] = [];
  for (const el of elements.values()) {
    if (el.hostId === w.id && (el.geometry === 'line' || el.geometry === 'spatial_line')) children.push(el as LineElement);
  }
  const posOf = (h: LineElement) => h.locationParam ?? (parseFloat(h.attrs.position ?? '') || 0);
  const widthOf = (h: LineElement) => parseFloat(h.attrs.width ?? '0.9') || 0.9;
  for (const h of children) {
    const lo = posOf(h) - widthOf(h) / 2, hi = posOf(h) + widthOf(h) / 2;
    if (s > lo && s < hi) s = s - lo < hi - s ? lo : hi;
  }
  if (s < MIN_LEN * 5 || s > len - MIN_LEN * 5) return null;

  const existing = new Set(elements.keys());
  const newId = generateId(w.tableName, existing);
  let first: LineElement, second: LineElement, point: Point;
  if (w.arc) {
    const f = s / len;
    point = pointOnArc(w.start, w.end, w.arc, f).point;
    const m1 = pointOnArc(w.start, w.end, w.arc, f / 2).point;
    const m2 = pointOnArc(w.start, w.end, w.arc, (1 + f) / 2).point;
    first = { ...w, end: point, arc: arcFromMidpoint(w.start, point, m1) };
    second = { ...w, id: newId, start: point, arc: arcFromMidpoint(point, w.end, m2), attrs: { ...w.attrs, id: newId } };
  } else {
    const fr = wallFrame(w)!;
    point = { x: w.start.x + fr.u.x * s, y: w.start.y + fr.u.y * s };
    first = { ...w, end: point };
    second = { ...w, id: newId, start: point, attrs: { ...w.attrs, id: newId } };
  }
  const patch: Patch = new Map([[w.id, first], [newId, second]]);
  for (const h of children) {
    const width = widthOf(h);
    const onSecond = posOf(h) >= s;
    const host = onSecond ? second : first;
    const pos = onSecond ? posOf(h) - s : posOf(h);
    const { start, end } = resolveHostedGeometry(host, pos, width);
    patch.set(h.id, {
      ...h, start, end, hostId: host.id, locationParam: pos,
      attrs: { ...h.attrs, host_id: host.id, position: String(Math.round(pos * 1e4) / 1e4) },
    });
  }
  return { patch, newId, point };
}
