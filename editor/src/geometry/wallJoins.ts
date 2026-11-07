/**
 * Wall join topology: which wall ends are connected to which walls, and how
 * those connections are kept when a wall is moved or an end is dragged.
 *
 * A join is never stored — it is read off the geometry (coincident ends or an
 * end lying on another wall's body), the same rule the 2D miter pass and the
 * CLI's room boundary pass use. Tools snapshot the joins when a gesture starts
 * so a wall dragged past an unrelated end does not pick it up mid-drag.
 *
 *   corner — an end of the driver coincides with an end of the follower.
 *   tee    — an end of the follower lies on the driver's body (driver hosts).
 *   abut   — an end of the driver lies on another wall's body (the host).
 */
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import { resolveHostedGeometry } from './hosted.ts';
import { arcLength } from './arc.ts';

/** Tables that join each other (and bound rooms). */
export const JOIN_TABLES = new Set(['wall', 'structure_wall', 'curtain_wall', 'room_separator']);

export type WallEnd = 'start' | 'end';

export interface WallJoin {
  kind: 'corner' | 'tee' | 'abut';
  /** The wall whose change drives the join. */
  driverId: string;
  /** corner / abut: the driver's joined end. */
  driverEnd?: WallEnd;
  /** corner / tee: the wall that follows. abut: the host the driver's end rests on. */
  otherId: string;
  /** corner / tee: the follower's joined end. */
  otherEnd?: WallEnd;
  /** tee / abut: signed distance of the joined end from the host centreline. */
  offset?: number;
}

const END_TOL = 0.005;

export type LineLike = LineElement & { geometry: 'line' | 'spatial_line' };

export function isJoinable(el: CanonicalElement | undefined | null): el is LineLike {
  return !!el && (el.geometry === 'line' || el.geometry === 'spatial_line')
    && JOIN_TABLES.has(el.tableName) && !el.hostId;
}

export function endPoint(w: LineElement, end: WallEnd): Point {
  return end === 'start' ? w.start : w.end;
}

function otherEndOf(end: WallEnd): WallEnd {
  return end === 'start' ? 'end' : 'start';
}

function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function wallLength(w: LineElement): number {
  return w.arc ? arcLength(w.start, w.end, w.arc) : dist(w.start, w.end);
}

/** Unit direction start→end and left normal. Null for a degenerate wall. */
export function wallFrame(w: { start: Point; end: Point }): { u: Point; n: Point; len: number } | null {
  const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const u = { x: dx / len, y: dy / len };
  return { u, n: { x: -u.y, y: u.x }, len };
}

/** Intersection of the infinite lines p + t·d and q + s·e (null when parallel). */
export function intersectLines(p: Point, d: Point, q: Point, e: Point): Point | null {
  const det = d.x * e.y - d.y * e.x;
  if (Math.abs(det) < 1e-9) return null;
  const t = ((q.x - p.x) * e.y - (q.y - p.y) * e.x) / det;
  return { x: p.x + d.x * t, y: p.y + d.y * t };
}

/** Projection of p onto the infinite line of w: parameter along w (metres) and
 *  signed distance to the left of start→end. */
export function projectOnWall(w: { start: Point; end: Point }, p: Point): { along: number; offset: number } | null {
  const f = wallFrame(w);
  if (!f) return null;
  const rx = p.x - w.start.x, ry = p.y - w.start.y;
  return { along: rx * f.u.x + ry * f.u.y, offset: rx * f.n.x + ry * f.n.y };
}

/** Is `p` on the body of straight wall `w` (inside its extent, within its thickness)? */
function onBody(w: LineElement, p: Point): { offset: number } | null {
  if (w.arc) return null;
  const pr = projectOnWall(w, p);
  const f = wallFrame(w);
  if (!pr || !f) return null;
  if (pr.along <= END_TOL || pr.along >= f.len - END_TOL) return null;
  if (Math.abs(pr.offset) > w.strokeWidth / 2 + END_TOL) return null;
  return { offset: pr.offset };
}

/**
 * Snapshot the joins between `driverIds` and the walls around them. Walls in
 * the driver set never follow each other (they all move together).
 */
export function findWallJoins(
  elements: ReadonlyMap<string, CanonicalElement>,
  driverIds: Iterable<string>,
): WallJoin[] {
  const drivers = new Set<string>();
  for (const id of driverIds) if (isJoinable(elements.get(id))) drivers.add(id);
  if (drivers.size === 0) return [];
  const others: LineLike[] = [];
  for (const el of elements.values()) if (isJoinable(el) && !drivers.has(el.id)) others.push(el);

  const joins: WallJoin[] = [];
  for (const id of drivers) {
    const w = elements.get(id) as LineLike;
    for (const o of others) {
      for (const we of ['start', 'end'] as const) {
        for (const oe of ['start', 'end'] as const) {
          if (dist(endPoint(w, we), endPoint(o, oe)) <= END_TOL) {
            joins.push({ kind: 'corner', driverId: id, driverEnd: we, otherId: o.id, otherEnd: oe });
          }
        }
      }
      for (const oe of ['start', 'end'] as const) {
        const hit = onBody(w, endPoint(o, oe));
        if (hit) joins.push({ kind: 'tee', driverId: id, otherId: o.id, otherEnd: oe, offset: hit.offset });
      }
      for (const we of ['start', 'end'] as const) {
        const hit = onBody(o, endPoint(w, we));
        if (hit) joins.push({ kind: 'abut', driverId: id, driverEnd: we, otherId: o.id, offset: hit.offset });
      }
    }
  }
  return joins;
}

/** Ids a join cascade may touch (followers plus every hosted child of a driver
 *  or follower) — tools snapshot these for the undo entry. */
export function joinAffectedIds(
  elements: ReadonlyMap<string, CanonicalElement>,
  driverIds: Iterable<string>,
  joins: readonly WallJoin[],
): Set<string> {
  const walls = new Set<string>(driverIds);
  for (const j of joins) if (j.kind !== 'abut') walls.add(j.otherId);
  const out = new Set(walls);
  for (const el of elements.values()) if (el.hostId && walls.has(el.hostId)) out.add(el.id);
  return out;
}

/** Drag-start snapshot for reshaping one element: its joins plus the
 *  pre-drag state of everything the cascade may touch (for the undo entry). */
export function snapshotReshape(
  elements: ReadonlyMap<string, CanonicalElement>,
  id: string,
): { joins: WallJoin[]; before: Map<string, CanonicalElement> } {
  const joins = findWallJoins(elements, [id]);
  const before = new Map<string, CanonicalElement>();
  for (const a of joinAffectedIds(elements, [id], joins)) {
    const el = elements.get(a);
    if (el && a !== id) before.set(a, el);
  }
  return { joins, before };
}

function withEnd<T extends LineElement>(w: T, end: WallEnd, p: Point): T {
  return end === 'start' ? { ...w, start: { x: p.x, y: p.y } } : { ...w, end: { x: p.x, y: p.y } };
}

/** Where the follower's joined end lands so it stays on a host line (the host's
 *  centreline shifted by `offset`), keeping the follower's own direction. */
function landOnLine(follower: LineElement, end: WallEnd, linePt: Point, lineDir: Point, fallback: Point): Point {
  if (follower.arc) return fallback;
  const fixed = endPoint(follower, otherEndOf(end));
  const cur = endPoint(follower, end);
  const d = { x: cur.x - fixed.x, y: cur.y - fixed.y };
  if (Math.hypot(d.x, d.y) < 1e-9) return fallback;
  const x = intersectLines(fixed, d, linePt, lineDir);
  // Nearly parallel lines meet far away: translate instead of shooting off.
  if (!x || dist(x, fallback) > 10 * Math.max(1, dist(cur, fallback))) return fallback;
  return x;
}

function offsetLine(host: LineElement, offset: number): { p: Point; d: Point } | null {
  const f = wallFrame(host);
  if (!f) return null;
  return { p: { x: host.start.x + f.n.x * offset, y: host.start.y + f.n.y * offset }, d: f.u };
}

/**
 * Keep joins after the drivers were translated rigidly by (dx, dy). `next`
 * already holds the translated drivers; followers (and drivers whose ends
 * slide along a corner neighbour or host) are updated in place. Returns the
 * ids of walls whose geometry the cascade changed.
 */
export function cascadeMove(
  next: Map<string, CanonicalElement>,
  joins: readonly WallJoin[],
  dx: number,
  dy: number,
): Set<string> {
  const changed = new Set<string>();
  const get = (id: string) => next.get(id) as LineLike | undefined;
  const moveBy = (p: Point) => ({ x: p.x + dx, y: p.y + dy });

  // Corner joins grouped by driver end: a single non-parallel neighbour keeps
  // its direction (the corner slides along it); otherwise neighbours follow.
  const corners = new Map<string, WallJoin[]>();
  for (const j of joins) {
    if (j.kind !== 'corner') continue;
    const k = `${j.driverId}:${j.driverEnd}`;
    const list = corners.get(k) ?? [];
    list.push(j);
    corners.set(k, list);
  }
  for (const list of corners.values()) {
    const j0 = list[0];
    const w = get(j0.driverId);
    if (!w) continue;
    const wEnd = endPoint(w, j0.driverEnd!);
    if (list.length === 1 && !w.arc) {
      const o = get(j0.otherId);
      const wf = wallFrame(w);
      if (o && wf) {
        const x = landOnLine(o, j0.otherEnd!, wEnd, wf.u, wEnd);
        next.set(o.id, withEnd(o, j0.otherEnd!, x));
        next.set(w.id, withEnd(w, j0.driverEnd!, x));
        changed.add(o.id); changed.add(w.id);
        continue;
      }
    }
    for (const j of list) {
      const o = get(j.otherId);
      if (!o) continue;
      next.set(o.id, withEnd(o, j.otherEnd!, wEnd));
      changed.add(o.id);
    }
  }

  for (const j of joins) {
    if (j.kind === 'tee') {
      const host = get(j.driverId), o = get(j.otherId);
      if (!host || !o) continue;
      const line = offsetLine(host, j.offset ?? 0);
      const fallback = moveBy(endPoint(o, j.otherEnd!));
      const x = line ? landOnLine(o, j.otherEnd!, line.p, line.d, fallback) : fallback;
      next.set(o.id, withEnd(o, j.otherEnd!, x));
      changed.add(o.id);
    } else if (j.kind === 'abut') {
      const w = get(j.driverId), host = get(j.otherId);
      if (!w || !host) continue;
      const line = offsetLine(host, j.offset ?? 0);
      const cur = endPoint(w, j.driverEnd!);
      const x = line ? landOnLine(w, j.driverEnd!, line.p, line.d, cur) : cur;
      next.set(w.id, withEnd(w, j.driverEnd!, x));
      changed.add(w.id);
    }
  }
  return changed;
}

/**
 * Keep joins after one wall changed shape (an end dragged, length edited, arc
 * bent). Corner neighbours at a moved end follow it; walls teed into the body
 * stay on it. An abutting end that was dragged away detaches (user intent).
 */
export function cascadeReshape(
  next: Map<string, CanonicalElement>,
  before: LineElement,
  joins: readonly WallJoin[],
): Set<string> {
  const changed = new Set<string>();
  const w = next.get(before.id) as LineLike | undefined;
  if (!w) return changed;
  for (const j of joins) {
    if (j.driverId !== before.id) continue;
    const o = next.get(j.otherId) as LineLike | undefined;
    if (!o) continue;
    if (j.kind === 'corner') {
      const p = endPoint(w, j.driverEnd!);
      if (dist(p, endPoint(o, j.otherEnd!)) < 1e-9) continue;
      next.set(o.id, withEnd(o, j.otherEnd!, p));
      changed.add(o.id);
    } else if (j.kind === 'tee') {
      if (w.arc) continue;
      const line = offsetLine(w, j.offset ?? 0);
      const cur = endPoint(o, j.otherEnd!);
      if (!line) continue;
      const x = landOnLine(o, j.otherEnd!, line.p, line.d, cur);
      if (dist(x, cur) < 1e-9) continue;
      next.set(o.id, withEnd(o, j.otherEnd!, x));
      changed.add(o.id);
    }
  }
  return changed;
}

function roundPos(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}

/**
 * Re-seat hosted doors / windows / openings after their host wall changed
 * from `oldWall` to `newWall`. A door keeps its distance from whichever end
 * stayed put; when both ends moved it keeps its plan location (projected).
 */
export function rehostChildren(
  next: Map<string, CanonicalElement>,
  oldWall: LineElement,
  newWall: LineElement,
): string[] {
  const touched: string[] = [];
  const startSame = dist(oldWall.start, newWall.start) < 1e-9;
  const endSame = dist(oldWall.end, newWall.end) < 1e-9;
  const oldLen = wallLength(oldWall);
  const newLen = wallLength(newWall);
  for (const [id, el] of next) {
    if (el.hostId !== newWall.id || (el.geometry !== 'line' && el.geometry !== 'spatial_line')) continue;
    const h = el as LineElement;
    const width = parseFloat(h.attrs.width ?? '0.9') || 0.9;
    const oldPos = h.locationParam ?? (parseFloat(h.attrs.position ?? '') || 0);
    let pos: number;
    if (startSame || newWall.arc || oldWall.arc) {
      pos = oldPos;
    } else if (endSame) {
      pos = newLen - (oldLen - oldPos);
    } else {
      const c = { x: (h.start.x + h.end.x) / 2, y: (h.start.y + h.end.y) / 2 };
      pos = projectOnWall(newWall, c)?.along ?? oldPos;
    }
    pos = Math.max(Math.min(width / 2, newLen / 2), Math.min(newLen - Math.min(width / 2, newLen / 2), pos));
    const { start, end } = resolveHostedGeometry(newWall, pos, width);
    next.set(id, { ...h, start, end, locationParam: pos, attrs: { ...h.attrs, position: roundPos(pos) } });
    touched.push(id);
  }
  return touched;
}

/**
 * Reducer hook for MOVE_ELEMENTS: `next` holds the rigidly translated
 * elements. Keeps the moved walls joined to their neighbours and re-seats the
 * doors / windows of every wall whose shape changed. Returns touched ids.
 */
export function applyMoveJoins(
  prev: ReadonlyMap<string, CanonicalElement>,
  next: Map<string, CanonicalElement>,
  movedIds: ReadonlySet<string>,
  joins: readonly WallJoin[] | undefined,
  dx: number,
  dy: number,
): string[] {
  const all = joins ?? findWallJoins(prev, movedIds);
  const live = all.filter(j => movedIds.has(j.driverId) && !movedIds.has(j.otherId));
  if (live.length === 0) return [];
  const changed = cascadeMove(next, live, dx, dy);
  const touched: string[] = [];
  for (const id of changed) {
    const before = prev.get(id), after = next.get(id);
    if (!before || !after || (after.geometry !== 'line' && after.geometry !== 'spatial_line')) continue;
    touched.push(id, ...rehostChildren(next, before as LineElement, after as LineElement));
  }
  return touched;
}

/**
 * Reducer hook for RESIZE_ELEMENT: `before` is the wall before the change and
 * `next` already holds the reshaped wall. Returns touched ids (followers and
 * their hosted children).
 */
export function applyReshapeJoins(
  prev: ReadonlyMap<string, CanonicalElement>,
  next: Map<string, CanonicalElement>,
  before: CanonicalElement,
  joins: readonly WallJoin[] | undefined,
): string[] {
  if (!isJoinable(before)) return [];
  const all = joins ?? findWallJoins(prev, [before.id]);
  if (all.length === 0) return [];
  const changed = cascadeReshape(next, before, all);
  const touched: string[] = [];
  for (const id of changed) {
    const was = prev.get(id), now = next.get(id);
    if (!was || !now) continue;
    touched.push(id, ...rehostChildren(next, was as LineElement, now as LineElement));
  }
  return touched;
}
