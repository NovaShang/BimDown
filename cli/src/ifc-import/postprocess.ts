/**
 * Clean-up so rooms close: snap boundary-line ends that are within 5 cm,
 * extend / trim free ends onto the line they run into (corners and tees),
 * add room separators along space edges no wall covers, then trace the rooms
 * the way `bimdown build` does and report the problems.
 */
import type { ImportContext, OutEl } from './context.js';
import type { SpaceRef } from './spaces.js';
import { BOUNDARY, endpoints, project, setEndpoint } from './lines.js';
import { type V2, add2, dist2, dot2, lineIntersect, norm2, scale2, sub2 } from './math.js';
import { deriveRooms, type RoomIssue, type Segment } from '../build/room-faces.js';
import { roomNetArea, type BoundaryLine } from '../build/room-net-area.js';

const SNAP = 0.05;   // m: ends this close become one
const TOUCH = 0.01;  // m: an end this close to a line is connected
const MAX_JOIN = 0.6; // m: longest extension / trim for a free end

interface End { el: OutEl; end: 0 | 1; p: V2 }

/** Boundary lines grouped by level (global ones join their base level). */
function byLevel(ctx: ImportContext, tables = BOUNDARY): Map<number, OutEl[]> {
  const m = new Map<number, OutEl[]>();
  for (const el of ctx.out) {
    if (!tables.has(el.table) || el.geometry?.type !== 'LineString') continue;
    const list = m.get(el.level);
    if (list) list.push(el); else m.set(el.level, [el]);
  }
  return m;
}

function ends(lines: OutEl[]): End[] {
  const out: End[] = [];
  for (const el of lines) {
    const [a, b] = endpoints(el);
    out.push({ el, end: 0, p: a }, { el, end: 1, p: b });
  }
  return out;
}

/** Merge ends closer than 5 cm (single-link clusters) onto one point each. */
export function snapEnds(lines: OutEl[]): number {
  const all = ends(lines);
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // Grid buckets keep this linear on big levels
  const cell = (p: V2) => `${Math.floor(p.x / SNAP)},${Math.floor(p.y / SNAP)}`;
  const grid = new Map<string, number[]>();
  all.forEach((e, i) => {
    const k = cell(e.p);
    const l = grid.get(k);
    if (l) l.push(i); else grid.set(k, [i]);
  });
  all.forEach((e, i) => {
    const cx = Math.floor(e.p.x / SNAP), cy = Math.floor(e.p.y / SNAP);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const j of grid.get(`${cx + dx},${cy + dy}`) ?? []) {
        if (j <= i || all[j].el === e.el) continue;
        if (dist2(e.p, all[j].p) < SNAP) parent[find(j)] = find(i);
      }
    }
  });
  const clusters = new Map<number, End[]>();
  all.forEach((e, i) => {
    const r = find(i);
    const l = clusters.get(r);
    if (l) l.push(e); else clusters.set(r, [e]);
  });
  let moved = 0;
  for (const c of clusters.values()) {
    if (c.length < 2) continue;
    // One shared point (room tracing needs coincident ends, not near misses):
    // the target most ends agree on.
    const targets = clusterTargets(c);
    const votes = new Map<string, { p: V2; n: number }>();
    for (const t of targets) {
      const k = `${Math.round(t.x * 1000)},${Math.round(t.y * 1000)}`;
      const v = votes.get(k);
      if (v) v.n++; else votes.set(k, { p: t, n: 1 });
    }
    const m = [...votes.values()].reduce((a, b) => (b.n > a.n ? b : a)).p;
    for (const e of c) {
      if (dist2(e.p, m) > 1e-4) moved++;
      setEndpoint(e.el, e.end, m);
      e.p = m;
    }
  }
  return moved;
}

/**
 * Put ends that stop just short of / past another line's interior (≤ 3 cm,
 * e.g. after snapping moved that line) exactly onto it, so tees stay joined.
 */
export function settleTees(ctx: ImportContext, lines: OutEl[]): number {
  let n = 0;
  const all = ends(lines);
  for (const e of all) {
    if (all.some(o => o.el !== e.el && dist2(o.p, e.p) < TOUCH)) continue;
    let best: { p: V2; d: number } | null = null;
    for (const o of lines) {
      if (o === e.el || !straight(ctx, o)) continue;
      const pr = project(ctx, o, e.p);
      if (pr.t <= TOUCH || pr.t >= pr.length - TOUCH || pr.d < 1e-4 || pr.d > SNAP) continue;
      const [oa] = endpoints(o);
      const q = add2(oa, scale2(pr.dir, pr.t));
      if (!best || pr.d < best.d) best = { p: q, d: pr.d };
    }
    if (best) { setEndpoint(e.el, e.end, best.p); e.p = best.p; n++; }
  }
  return n;
}

/**
 * Where each end of a cluster goes: along its own line (so walls keep their
 * angle) to where it crosses another member's line, taking the crossing that
 * lengthens it most so every member still meets the others; collinear-only
 * clusters meet at the end of their longest member (shorter pieces tilt).
 */
function clusterTargets(c: End[]): V2[] {
  const longest = c.reduce((a, b) => {
    const [a0, a1] = endpoints(a.el), [b0, b1] = endpoints(b.el);
    return dist2(b0, b1) > dist2(a0, a1) ? b : a;
  });
  const mean = longest.p;
  return c.map(e => {
    const [p0, p1] = endpoints(e.el);
    const far = e.end === 0 ? p1 : p0;
    const dir = norm2(sub2(e.p, far));
    let best: V2 | null = null, bestAlong = -Infinity;
    for (const o of c) {
      if (o.el === e.el) continue;
      const [q0, q1] = endpoints(o.el);
      const od = norm2(sub2(q1, q0));
      if (Math.abs(dir.x * od.y - dir.y * od.x) < 0.3) continue;
      const hit = lineIntersect(far, e.p, q0, q1);
      if (!hit || dist2(hit.p, e.p) > SNAP * 1.6) continue;
      const along = dot2(sub2(hit.p, far), dir);
      if (along > bestAlong) { best = hit.p; bestAlong = along; }
    }
    return best ?? mean;
  });
}

/** Is this end touching another line (its end or its interior)? */
function connected(ctx: ImportContext, e: End, lines: OutEl[]): boolean {
  for (const o of lines) {
    if (o === e.el) continue;
    const pr = project(ctx, o, e.p);
    if (pr.d < TOUCH && pr.t > -TOUCH && pr.t < pr.length + TOUCH) return true;
  }
  return false;
}

function straight(ctx: ImportContext, el: OutEl): boolean {
  return !ctx.lines.get(el)?.arc;
}

/**
 * Extend or trim free ends onto the nearest line they run into: an L corner
 * when the other line's end is also free there, else a tee. Returns the
 * counts of corners and tees made.
 */
export function joinEnds(ctx: ImportContext, lines: OutEl[], only?: Set<OutEl>): { corners: number; tees: number } {
  let corners = 0, tees = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (const e of ends(lines)) {
      if (only && !only.has(e.el)) continue;
      if (!straight(ctx, e.el)) continue;
      const [a, b] = endpoints(e.el);
      if (dist2(a, b) < 0.05) continue;
      const cur = e.end === 0 ? a : b;
      const e2: End = { ...e, p: cur };
      if (connected(ctx, e2, lines)) continue;
      const far = e.end === 0 ? b : a;
      const dir = norm2(sub2(cur, far));
      const thisHalf = (ctx.lines.get(e.el)?.thickness ?? 0) / 2;
      let best: { p: V2; move: number; other: OutEl; otherEnd: 0 | 1 | null } | null = null;
      for (const o of lines) {
        if (o === e.el || !straight(ctx, o)) continue;
        const [oa, ob] = endpoints(o);
        const oL = dist2(oa, ob);
        if (oL < 0.05) continue;
        const otherHalf = (ctx.lines.get(o)?.thickness ?? 0) / 2;
        // Separators start on space outlines (wall faces): let them reach the next centre line
        const base = e.el.table === 'room_separator' ? 0.35 : 0.15;
        const limit = Math.min(MAX_JOIN, Math.max(base, otherHalf + thisHalf + 0.1));
        const hit = lineIntersect(far, cur, oa, ob);
        if (!hit) {
          // Collinear pieces with a gap: join end to end
          for (const q of [oa, ob]) {
            const off = sub2(q, cur);
            const along = dot2(off, dir);
            const across = Math.abs(off.x * dir.y - off.y * dir.x);
            if (across < TOUCH * 2 && along > -TOUCH && along < limit && (!best || along < best.move)) {
              best = { p: q, move: Math.abs(along), other: o, otherEnd: null };
            }
          }
          continue;
        }
        const L = dist2(far, cur);
        const move = (hit.t - 1) * L; // > 0 extends, < 0 trims
        if (Math.abs(move) > limit || hit.t < 0.05) continue;
        // The hit must be on the other line, or within reach of its free end (corner)
        const sOver = Math.max(-hit.s, hit.s - 1) * oL;
        if (sOver > limit) continue;
        if (best && Math.abs(move) >= best.move) continue;
        const otherEnd: 0 | 1 | null = hit.s < 0.5 && dist2(hit.p, oa) < limit ? 0 : hit.s >= 0.5 && dist2(hit.p, ob) < limit ? 1 : null;
        best = { p: hit.p, move: Math.abs(move), other: o, otherEnd: sOver > TOUCH ? otherEnd : null };
      }
      if (!best) continue;
      if (best.otherEnd !== null) {
        const q = endpoints(best.other)[best.otherEnd];
        const oe: End = { el: best.other, end: best.otherEnd, p: q };
        if (!connected(ctx, oe, lines.filter(l => l !== e.el))) {
          setEndpoint(e.el, e.end, best.p);
          setEndpoint(best.other, best.otherEnd, best.p);
          corners++;
          continue;
        }
        // The other end is held elsewhere: meet it there if that is close
        if (dist2(q, best.p) > 0.15) continue;
        best.p = q;
      }
      setEndpoint(e.el, e.end, best.p);
      tees++;
    }
  }
  return { corners, tees };
}

/**
 * Ends that stop at the face of a crossing wall (often on a thin lining wall
 * against it) continue to that wall's centre line: room faces are traced on
 * centre lines, and the strip between face and centre would otherwise leak
 * from one room into the next. Returns how many ends moved.
 */
export function extendIntoBodies(ctx: ImportContext, lines: OutEl[]): number {
  let moved = 0;
  for (const e of ends(lines)) {
    if (!straight(ctx, e.el) || e.el.table === 'curtain_wall') continue;
    const [a, b] = endpoints(e.el);
    const cur = e.end === 0 ? a : b, far = e.end === 0 ? b : a;
    if (dist2(a, b) < 0.1) continue;
    const dir = norm2(sub2(cur, far));
    // Crossing walls ahead of the end, nearest first
    const hits: { p: V2; move: number; half: number }[] = [];
    for (const o of lines) {
      if (o === e.el || !straight(ctx, o) || o.table === 'room_separator') continue;
      const half = (ctx.lines.get(o)?.thickness ?? 0) / 2;
      const [oa, ob] = endpoints(o);
      const od = norm2(sub2(ob, oa));
      if (Math.abs(dir.x * od.y - dir.y * od.x) < 0.5) continue; // within 30° of parallel
      const hit = lineIntersect(far, cur, oa, ob);
      if (!hit) continue;
      const oL = dist2(oa, ob);
      if (hit.s * oL < -TOUCH || (hit.s - 1) * oL > TOUCH) continue;
      const move = (hit.t - 1) * dist2(far, cur);
      if (move > -TOUCH) hits.push({ p: hit.p, move, half });
    }
    hits.sort((x, y) => x.move - y.move);
    // Walk through bodies that touch each other (a lining against a wall,
    // a two-leaf exterior wall): the end goes to the last centre line reached.
    let reach = 0, target: V2 | null = null;
    for (const h of hits) {
      if (h.move > reach + h.half + 0.08) break;
      if (h.half < 0.02 && h.move > reach) break;
      if (h.move > 0.01) target = h.p;
      reach = Math.max(reach, h.move + h.half);
    }
    if (target) { setEndpoint(e.el, e.end, target); moved++; }
  }
  return moved;
}

// ─── Room separators ─────────────────────────────────────────────────────────

/** Half the plan width a line takes off a space (curtain walls: at least 15 cm, rooms stop at the mullions). */
function halfWidth(ctx: ImportContext, el: OutEl): number {
  const t = ctx.lines.get(el)?.thickness ?? 0;
  return (el.table === 'curtain_wall' ? Math.max(t, 0.3) : t) / 2;
}

interface Cover { t0: number; t1: number; off: number }

/** Lines running along an edge (a→b): their extent on it and their offset from it. */
function edgeCover(ctx: ImportContext, a: V2, u: V2, L: number, lines: OutEl[]): Cover[] {
  const n = { x: -u.y, y: u.x };
  const out: Cover[] = [];
  for (const el of lines) {
    if (ctx.lines.get(el)?.arc) continue;
    const [p, q] = endpoints(el);
    const d = sub2(q, p);
    const len = Math.hypot(d.x, d.y);
    if (len < 0.05 || Math.abs(d.x * u.y - d.y * u.x) / len > 0.05) continue;
    const off = dot2(sub2(p, a), n);
    if (Math.abs(off) > halfWidth(ctx, el) + 0.08) continue;
    const tp = dot2(sub2(p, a), u), tq = dot2(sub2(q, a), u);
    const t0 = Math.min(tp, tq), t1 = Math.max(tp, tq);
    // Lines ending just short of the edge still say where the wall line runs
    if (t1 < -0.3 || t0 > L + 0.3) continue;
    out.push({ t0, t1, off });
  }
  return out.sort((x, y) => x.t0 - y.t0);
}

/** Does an existing separator already run along p0→p1? */
function duplicate(added: OutEl[], level: number, p0: V2, p1: V2): boolean {
  const u = norm2(sub2(p1, p0)), n = { x: -u.y, y: u.x }, L = dist2(p0, p1);
  return added.some(o => {
    if (o.level !== level) return false;
    const [oa, ob] = endpoints(o);
    const od = sub2(ob, oa), ol = Math.hypot(od.x, od.y);
    if (ol < 1e-6 || Math.abs(od.x * u.y - od.y * u.x) / ol > 0.05 || Math.abs(dot2(sub2(oa, p0), n)) > 0.15) return false;
    const s0 = dot2(sub2(oa, p0), u), s1 = dot2(sub2(ob, p0), u);
    return Math.min(Math.max(s0, s1), L) - Math.max(Math.min(s0, s1), 0) > 0.5 * L;
  });
}

/**
 * Space outline edges with no wall along them become room separators
 * (open-plan boundaries, virtual IFC space boundaries). A gap in a wall line
 * (a wide opening between two rooms) gets its separator on that wall's
 * centre line, from wall end to wall end, so the room closes.
 */
export function addSeparators(ctx: ImportContext, spaces: SpaceRef[]): OutEl[] {
  const added: OutEl[] = [];
  const levels = byLevel(ctx);
  for (const s of spaces) {
    const lines = levels.get(s.el.level) ?? [];
    const ring = s.outline.outer;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      const L = dist2(a, b);
      if (L < 0.3) continue;
      const u = norm2(sub2(b, a));
      const cover = edgeCover(ctx, a, u, L, [...lines, ...added.filter(x => x.level === s.el.level)]);
      // Uncovered runs of [0, L]
      const runs: [number, number][] = [];
      let at = 0;
      for (const c of cover) {
        if (c.t0 > at + 0.3) runs.push([at, Math.min(c.t0, L)]);
        at = Math.max(at, c.t1);
        if (at >= L) break;
      }
      if (L - at >= 0.3) runs.push([at, L]);
      if (runs.length === 0) continue;
      // On a partly walled edge the separator continues the longest wall's centre line
      const along = cover.slice().sort((x, y) => (y.t1 - y.t0) - (x.t1 - x.t0))[0];
      const shift = along ? scale2({ x: -u.y, y: u.x }, along.off) : { x: 0, y: 0 };
      for (const [t0, t1] of runs) {
        const p0 = add2(add2(a, scale2(u, t0)), shift), p1 = add2(add2(a, scale2(u, t1)), shift);
        if (duplicate(added, s.el.level, p0, p1)) continue;
        const el = ctx.add('room_separator', 0, s.el.level, {}, { type: 'LineString', coordinates: [[round(p0.x), round(p0.y)], [round(p1.x), round(p1.y)]] });
        ctx.lines.set(el, { thickness: 0, zMin: 0, zMax: 0 });
        added.push(el);
      }
    }
  }
  return added;
}

const round = (v: number) => Math.round(v * 1000) / 1000;

// ─── Room check ──────────────────────────────────────────────────────────────

export interface RoomCheck {
  issues: RoomIssue[];
  warnings: string[];
  /** space id → derived net area (m²). */
  netArea: Map<string, number>;
}

/** Trace rooms per level exactly like `bimdown build`. */
export function checkRooms(ctx: ImportContext, spaces: SpaceRef[]): RoomCheck {
  const issues: RoomIssue[] = [];
  const warnings: string[] = [];
  const netArea = new Map<string, number>();
  const levels = byLevel(ctx);
  const global = ctx.out.filter(el => el.global && BOUNDARY.has(el.table));
  for (const level of ctx.levels) {
    const seeds = spaces.filter(s => s.el.level === level.index);
    if (seeds.length === 0) continue;
    const lines = [...(levels.get(level.index) ?? []).filter(el => !el.global), ...global];
    const segments: Segment[] = lines.map(el => {
      const [a, b] = endpoints(el);
      return { startX: a.x, startY: a.y, endX: b.x, endY: b.y, id: el.id };
    }).filter(s => Math.hypot(s.endX - s.startX, s.endY - s.startY) >= 0.01);
    const rooms = deriveRooms(level.id, segments, seeds.map(s => ({ id: s.el.id, x: Number(s.el.attrs.x), y: Number(s.el.attrs.y) })));
    issues.push(...rooms.roomIssues);
    warnings.push(...rooms.warnings.filter(w => !w.includes('has no connected line element')));
    const bl: BoundaryLine[] = lines.map(el => {
      const [a, b] = endpoints(el);
      return { start: a, end: b, half: el.table === 'room_separator' ? 0 : (ctx.lines.get(el)?.thickness ?? 0) / 2 };
    });
    for (const [id, face] of rooms.matched) netArea.set(id, roomNetArea(face.polygon, bl));
  }
  return { issues, warnings, netArea };
}

/** Free ends left after joining (for the report). */
export function danglingEnds(ctx: ImportContext): number {
  let n = 0;
  for (const [, lines] of byLevel(ctx)) {
    for (const e of ends(lines)) if (!connected(ctx, e, lines)) n++;
  }
  return n;
}

