/**
 * Temporary dimensions (Revit-style) for the selected wall, door/window or
 * point element, and for a wall being drawn: distances to the nearest
 * parallel walls / grids, to the wall ends or meeting walls along a host,
 * and from a column to the nearest walls. Each one can say how to move the
 * element so the distance becomes a typed value, and how to keep it as a
 * permanent dimension.
 */
import type { CanonicalElement, LineElement, Point } from '../model/elements.ts';
import type { EditorAction } from '../state/editorTypes.ts';
import { formatRef, thicknessOf, isHostedOpening, sub, add, mul, dot, len, metre, type Lookup } from './geometry.ts';
import type { DimRowDraft } from './pick.ts';
import { isAnnotationTable } from './model.ts';

export interface TempDim {
  key: string;
  /** Measured points. */
  p1: Point; p2: Point;
  value: number;
  /** Dimension line offset from p1/p2 (along the left normal of p1→p2). */
  offset: number;
  /** Action that makes the distance `v`; absent = display only. */
  apply?: (v: number) => EditorAction | null;
  /** Permanent dimension equivalent. */
  row?: DimRowDraft;
}

const WALLISH = new Set(['wall', 'structure_wall', 'curtain_wall']);
const SIN_1DEG = Math.sin(Math.PI / 180);

interface Seg { id: string; a: Point; b: Point; u: Point; L: number; half: number; table: string }

function straightSegments(elements: Iterable<CanonicalElement>, lookup: Lookup, tables: Set<string>): Seg[] {
  const out: Seg[] = [];
  for (const el of elements) {
    if (!tables.has(el.tableName) || el.geometry !== 'line' || (el as LineElement).arc || isHostedOpening(el)) continue;
    const d = sub(el.end, el.start);
    const L = len(d);
    if (L < 1e-6) continue;
    out.push({ id: el.id, a: el.start, b: el.end, u: mul(d, 1 / L), L, half: thicknessOf(el, lookup) / 2, table: el.tableName });
  }
  return out;
}

const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const angleDeg = (v: Point) => Math.atan2(v.y, v.x) * 180 / Math.PI;

/** Nearest parallel walls/grids on each side of the segment a→b (centre lines). */
export function parallelTempDims(
  a: Point, b: Point, selfId: string | null, elements: Iterable<CanonicalElement>, lookup: Lookup,
  move?: (delta: Point) => EditorAction,
): TempDim[] {
  const d = sub(b, a);
  const L = len(d);
  if (L < 1e-6) return [];
  const u = mul(d, 1 / L);
  const n = { x: -u.y, y: u.x };
  const best: Record<'pos' | 'neg', { s: number; t: number; seg: Seg } | null> = { pos: null, neg: null };
  for (const seg of straightSegments(elements, lookup, new Set([...WALLISH, 'grid']))) {
    if (seg.id === selfId || Math.abs(cross(u, seg.u)) > SIN_1DEG) continue;
    const s = dot(sub(seg.a, a), n);
    if (Math.abs(s) < 1e-3) continue;
    const t0 = Math.max(0, Math.min(dot(sub(seg.a, a), u), dot(sub(seg.b, a), u)));
    const t1 = Math.min(L, Math.max(dot(sub(seg.a, a), u), dot(sub(seg.b, a), u)));
    if (t1 - t0 < -1e-6 && seg.table !== 'grid') continue; // no overlap (grids reach across)
    const side = s > 0 ? 'pos' : 'neg';
    const cur = best[side];
    if (!cur || Math.abs(s) < Math.abs(cur.s)) {
      // 30 % along the shared stretch: clear of the length label at the wall's midpoint
      const t = seg.table === 'grid' ? L * 0.3 : Math.max(0, Math.min(L, t0 + (t1 - t0) * 0.3));
      best[side] = { s, t, seg };
    }
  }
  const out: TempDim[] = [];
  for (const side of ['pos', 'neg'] as const) {
    const hit = best[side];
    if (!hit) continue;
    const p1 = add(a, mul(u, hit.t));
    const p2 = add(p1, mul(n, hit.s));
    const s = hit.s;
    out.push({
      key: `par-${side}`, p1, p2, value: Math.abs(s), offset: 0,
      apply: move ? (v: number) => (v > 0 ? move(mul(n, s - Math.sign(s) * v)) : null) : undefined,
      row: selfId ? {
        p1, p2, ref1: selfId, ref2: hit.seg.id,
        direction: angleDeg(mul(n, Math.sign(s))), offset: 0,
      } : undefined,
    });
  }
  return out;
}

/** Gaps from a door/window's edges to the wall ends or the faces of walls meeting its host. */
export function openingTempDims(opening: CanonicalElement, elements: Iterable<CanonicalElement>, lookup: Lookup): TempDim[] {
  if (opening.geometry !== 'line' || !opening.hostId) return [];
  const host = lookup(opening.hostId);
  if (!host || host.geometry !== 'line' || (host as LineElement).arc) return [];
  const d = sub(host.end, host.start);
  const L = len(d);
  if (L < 1e-6) return [];
  const u = mul(d, 1 / L);
  const hostHalf = thicknessOf(host, lookup) / 2;
  const tA = Math.min(dot(sub(opening.start, host.start), u), dot(sub(opening.end, host.start), u));
  const tB = Math.max(dot(sub(opening.start, host.start), u), dot(sub(opening.end, host.start), u));
  const startIsA = dot(sub(opening.start, host.start), u) <= dot(sub(opening.end, host.start), u);
  type Stop = { t: number; ref: string; point: Point };
  const stops: Stop[] = [
    { t: 0, ref: formatRef(host.id, 'start'), point: host.start },
    { t: L, ref: formatRef(host.id, 'end'), point: host.end },
  ];
  for (const seg of straightSegments(elements, lookup, WALLISH)) {
    if (seg.id === host.id || Math.abs(cross(u, seg.u)) < SIN_1DEG) continue;
    // Where the other wall's centre line crosses the host centre line
    const denom = cross(u, seg.u);
    const w = sub(seg.a, host.start);
    const t = cross(w, seg.u) / denom;
    const s = cross(w, u) / denom;
    // A meeting wall may stop at the host's face rather than its centre line
    const reach = (hostHalf + 0.02) / Math.abs(denom);
    // Corner walls at the host's ends count too (their inner face is the stop)
    if (t < -hostHalf || t > L + hostHalf || s < -reach || s > seg.L + reach) continue;
    // Faces of the meeting wall along the host
    const halfAlong = seg.half / Math.abs(denom);
    // The face towards the host start is the meeting wall's left face when cross(u, seg.u) > 0
    const sideNear = denom > 0 ? ['left', 'right'] : ['right', 'left'];
    stops.push({ t: t - halfAlong, ref: formatRef(seg.id, sideNear[0] as 'left'), point: add(host.start, mul(u, t - halfAlong)) });
    stops.push({ t: t + halfAlong, ref: formatRef(seg.id, sideNear[1] as 'left'), point: add(host.start, mul(u, t + halfAlong)) });
  }
  const before = stops.filter(s => s.t <= tA + 1e-4).sort((x, y) => y.t - x.t)[0];
  const after = stops.filter(s => s.t >= tB - 1e-4).sort((x, y) => x.t - y.t)[0];
  const position = parseFloat(opening.attrs.position ?? '');
  const sid = opening.id;
  const offset = -(hostHalf + 0.45 * metre());
  const edgeA = add(host.start, mul(u, tA)), edgeB = add(host.start, mul(u, tB));
  const refA = formatRef(opening.id, startIsA ? 'start' : 'end');
  const refB = formatRef(opening.id, startIsA ? 'end' : 'start');
  const update = (pos: number): EditorAction => ({ type: 'UPDATE_ATTRS', id: sid, attrs: { position: String(Number(pos.toFixed(4))) } });
  const out: TempDim[] = [];
  const dir = angleDeg(u);
  if (before && Number.isFinite(position)) {
    out.push({
      key: 'open-a', p1: before.point, p2: edgeA, value: tA - before.t, offset,
      apply: v => (v >= 0 ? update(position + (before.t + v - tA)) : null),
      row: { p1: before.point, p2: edgeA, ref1: before.ref, ref2: refA, direction: dir, offset },
    });
  }
  if (after && Number.isFinite(position)) {
    out.push({
      key: 'open-b', p1: edgeB, p2: after.point, value: after.t - tB, offset,
      apply: v => (v >= 0 ? update(position + (after.t - v - tB)) : null),
      row: { p1: edgeB, p2: after.point, ref1: refB, ref2: after.ref, direction: dir, offset },
    });
  }
  return out;
}

/** Distances from a point element's centre to the nearest wall along ±X / ±Y. */
export function pointTempDims(el: CanonicalElement, elements: Iterable<CanonicalElement>, lookup: Lookup): TempDim[] {
  if (el.geometry !== 'point') return [];
  const c = el.position;
  const segs = straightSegments(elements, lookup, WALLISH);
  const out: TempDim[] = [];
  const dirs: [string, Point][] = [['+x', { x: 1, y: 0 }], ['-x', { x: -1, y: 0 }], ['+y', { x: 0, y: 1 }], ['-y', { x: 0, y: -1 }]];
  const picks: { key: string; dist: number; dir: Point; seg: Seg }[] = [];
  for (const [key, r] of dirs) {
    let best: { dist: number; seg: Seg } | null = null;
    for (const seg of segs) {
      const denom = cross(r, seg.u);
      if (Math.abs(denom) < SIN_1DEG) continue;
      const w = sub(seg.a, c);
      const t = cross(w, seg.u) / denom; // along the ray
      const s = cross(w, r) / denom;     // along the wall
      if (t <= 1e-3 || s < -1e-3 || s > seg.L + 1e-3) continue;
      if (!best || t < best.dist) best = { dist: t, seg };
    }
    if (best) picks.push({ key, dist: best.dist, dir: r, seg: best.seg });
  }
  // Keep the nearer of each axis pair so the plan doesn't fill with dimensions
  for (const axis of ['x', 'y']) {
    const pair = picks.filter(p => p.key.endsWith(axis)).sort((a, b) => a.dist - b.dist)[0];
    if (!pair) continue;
    const p2 = add(c, mul(pair.dir, pair.dist));
    const sid = el.id;
    const dist = pair.dist;
    out.push({
      key: `pt-${pair.key}`, p1: c, p2, value: dist, offset: 0,
      apply: v => (v > 0 ? { type: 'MOVE_ELEMENTS', ids: [sid], dx: pair.dir.x * (dist - v), dy: pair.dir.y * (dist - v) } : null),
      row: { p1: c, p2, ref1: sid, ref2: pair.seg.id, direction: angleDeg(pair.dir), offset: 0 },
    });
  }
  return out;
}

/** Temporary dimensions for one selected element. */
export function tempDimsFor(el: CanonicalElement, elements: Map<string, CanonicalElement>): TempDim[] {
  if (isAnnotationTable(el.tableName)) return [];
  const lookup: Lookup = id => elements.get(id);
  if (isHostedOpening(el)) return openingTempDims(el, elements.values(), lookup);
  if (el.geometry === 'line' && (WALLISH.has(el.tableName) || el.tableName === 'room_separator') && !(el as LineElement).arc) {
    const sid = el.id;
    return parallelTempDims(el.start, el.end, sid, elements.values(), lookup,
      delta => ({ type: 'MOVE_ELEMENTS', ids: [sid], dx: delta.x, dy: delta.y }));
  }
  if (el.geometry === 'point' && el.tableName !== 'space') return pointTempDims(el, elements.values(), lookup);
  return [];
}
