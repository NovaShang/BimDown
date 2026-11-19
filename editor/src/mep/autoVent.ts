/**
 * Automatic branch venting for sanitary fixtures (one command, one undo).
 *
 * Every sanitary fixture on the level whose drain runs out through a SAN
 * pipe gets a vent: the drain is split close to the fixture with a tee and a
 * vent pipe rises from it to the group's vent height (150 mm over the
 * highest fixture's rim). Fixtures near each other (within `groupDistance`)
 * share one horizontal vent branch at that height, routed square from the
 * farthest fixture to the nearest vent stack (a vertical VENT pipe on the
 * level), which is split there with a tee.
 *
 * Pure: returns the elements to create and the ones it changes (split drains
 * and stacks), for one APPLY_PATCH.
 */
import type { CanonicalElement, Point, PointElement, SpatialLineElement, LineElement } from '../model/elements.ts';
import { generateId } from '../model/ids.ts';
import { defaultAttrs } from '../model/defaults.ts';
import { endZ, isVertical, splitCurveAt } from '../model/mepSplit.ts';
import { parsePortRef } from '../utils/portRef.ts';
import { isSanitaryFixture } from '../elements/equipment_starters.ts';
import { reservedIds } from './reservedIds.ts';
import { systemPreset } from './systemPresets.ts';

type MepCurve = LineElement | SpatialLineElement;

const VENT = /^(V|VENT|VTR|SV)$/i;
const DRAIN = /^(SAN|SS|SW|W|WASTE|SOIL|D|DR|DRAIN)$/i;

export const isVentSystem = (s: string | undefined) => VENT.test((s ?? '').trim()) || systemPreset(s ?? '')?.code === 'VENT';
const isDrainSystem = (s: string | undefined) => DRAIN.test((s ?? '').trim());

export interface AutoVentOptions {
  levelId: string;
  /** Model units per metre (1 for metre projects, 1000 for mm). */
  upm?: number;
  /** Fixtures closer than this (metres) share one vent branch. Default 3. */
  groupDistance?: number;
  /** Vent system code written on the new pipes. Default: the stack's. */
  system?: string;
}

export type VentSkipReason = 'no_drain' | 'no_stack' | 'stack_low' | 'vented';

export interface AutoVentResult {
  /** New and changed elements (one patch). */
  patch: CanonicalElement[];
  groups: { stack: string; fixtures: string[]; height: number }[];
  skipped: { id: string; reason: VentSkipReason }[];
}

const num = (v: string | undefined, d = 0) => { const n = parseFloat(v ?? ''); return Number.isFinite(n) ? n : d; };
const isCurve = (el: CanonicalElement): el is MepCurve => el.geometry === 'line' || el.geometry === 'spatial_line';
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

interface Takeoff {
  fixture: PointElement;
  pipe: MepCurve;
  /** Plan point on the drain where the vent leaves it. */
  at: Point;
  z: number;
  /** Top of the fixture (flood rim), level-relative. */
  rim: number;
}

/** Drain pipes at a host: the curves whose from / to names it. */
function curvesAt(elements: ReadonlyMap<string, CanonicalElement>, hostId: string): { curve: MepCurve; side: 'start' | 'end'; port: string | null }[] {
  const out: { curve: MepCurve; side: 'start' | 'end'; port: string | null }[] = [];
  for (const el of elements.values()) {
    if (el.tableName !== 'pipe' || !isCurve(el)) continue;
    for (const side of ['start', 'end'] as const) {
      const r = parsePortRef(side === 'start' ? el.attrs.from : el.attrs.to);
      if (r && r.hostId === hostId) out.push({ curve: el, side, port: r.portName });
    }
  }
  return out;
}

/** Where a fixture's vent leaves its drain: on the first horizontal drain run, a short way from the fixture. */
function takeoffOf(fx: PointElement, elements: ReadonlyMap<string, CanonicalElement>, upm: number): Takeoff | null {
  const first = curvesAt(elements, fx.id).filter(c => (c.port ?? 'drain') === 'drain' || isDrainSystem(c.curve.attrs.system_type));
  let hop = first.find(c => !isVertical(c.curve)) ?? null;
  if (!hop) {
    // A drop from the fixture: continue through the node at its far end
    for (const c of first) {
      const far = parsePortRef(c.side === 'start' ? c.curve.attrs.to : c.curve.attrs.from);
      if (!far || far.portName) continue;
      hop = curvesAt(elements, far.hostId).find(n => n.curve.id !== c.curve.id && !isVertical(n.curve)) ?? null;
      if (hop) break;
    }
  }
  if (!hop) return null;
  const c = hop.curve;
  const a = hop.side === 'start' ? c.start : c.end, b = hop.side === 'start' ? c.end : c.start;
  const L = dist(a, b);
  if (L < 0.05 * upm) return null;
  // 300 mm from the fixture, and clear of its body (a WC's drain sits under the bowl)
  const ux = (b.x - a.x) / L, uy = (b.y - a.y) / L;
  const th = (num(fx.attrs.rotation) * Math.PI) / 180;
  const lx = ux * Math.cos(th) + uy * Math.sin(th), ly = -ux * Math.sin(th) + uy * Math.cos(th);
  const px = (a.x - fx.position.x) * Math.cos(th) + (a.y - fx.position.y) * Math.sin(th);
  const py = -(a.x - fx.position.x) * Math.sin(th) + (a.y - fx.position.y) * Math.cos(th);
  const exit = (h: number, p: number, u: number) => (Math.abs(u) < 1e-9 ? Infinity : ((u > 0 ? h : -h) - p) / u);
  const out = fx.width > 0 && fx.height > 0 ? Math.max(0, Math.min(exit(fx.width / 2, px, lx), exit(fx.height / 2, py, ly))) : 0;
  const d = Math.min(Math.max(0.3 * upm, out + 0.1 * upm), L / 2);
  const at = { x: a.x + ((b.x - a.x) / L) * d, y: a.y + ((b.y - a.y) / L) * d };
  const za = endZ(c, hop.side), zb = endZ(c, hop.side === 'start' ? 'end' : 'start');
  const z = za + (zb - za) * (d / L);
  const rim = num(fx.attrs.base_offset) + num(fx.attrs.height, 0.9 * upm);
  return { fixture: fx, pipe: c, at, z, rim };
}

/** Is there a vent pipe already leaving this fixture's drain? */
function alreadyVented(fx: PointElement, elements: ReadonlyMap<string, CanonicalElement>): boolean {
  for (const c of curvesAt(elements, fx.id)) {
    for (const ref of [c.curve.attrs.from, c.curve.attrs.to]) {
      const r = parsePortRef(ref);
      if (!r || r.portName || r.hostId === fx.id) continue;
      if (curvesAt(elements, r.hostId).some(o => isVentSystem(o.curve.attrs.system_type))) return true;
    }
  }
  return false;
}

/** Single-linkage clusters of points closer than `d`. */
function clusters<T extends { at: Point }>(items: T[], d: number): T[][] {
  const out: T[][] = [];
  const left = [...items];
  while (left.length) {
    const g = [left.shift()!];
    for (let i = 0; i < g.length; i++) {
      for (let j = left.length - 1; j >= 0; j--) if (dist(g[i].at, left[j].at) <= d) g.push(...left.splice(j, 1));
    }
    out.push(g);
  }
  return out;
}

export function autoVent(elements: ReadonlyMap<string, CanonicalElement>, opts: AutoVentOptions): AutoVentResult {
  const upm = opts.upm ?? 1;
  const result: AutoVentResult = { patch: [], groups: [], skipped: [] };
  const live = new Map(elements);
  const ids = reservedIds(elements);
  const changed = new Map<string, CanonicalElement>();
  const put = (el: CanonicalElement) => { live.set(el.id, el); changed.set(el.id, el); ids.add(el.id); };

  const stacks = [...elements.values()].filter((e): e is SpatialLineElement =>
    e.tableName === 'pipe' && e.geometry === 'spatial_line' && isVertical(e) && isVentSystem(e.attrs.system_type));
  const takeoffs: Takeoff[] = [];
  for (const el of elements.values()) {
    if (!isSanitaryFixture(el) || el.geometry !== 'point') continue;
    const fx = el as PointElement;
    if (alreadyVented(fx, elements)) { result.skipped.push({ id: fx.id, reason: 'vented' }); continue; }
    const t = takeoffOf(fx, elements, upm);
    if (!t) { result.skipped.push({ id: fx.id, reason: 'no_drain' }); continue; }
    if (stacks.length === 0) { result.skipped.push({ id: fx.id, reason: 'no_stack' }); continue; }
    takeoffs.push(t);
  }
  if (takeoffs.length === 0) return result;

  // Nearest stack per fixture, then groups per stack
  const byStack = new Map<string, Takeoff[]>();
  for (const t of takeoffs) {
    const s = stacks.reduce((a, b) => (dist(b.start, t.at) < dist(a.start, t.at) ? b : a));
    const list = byStack.get(s.id) ?? [];
    list.push(t);
    byStack.set(s.id, list);
  }

  const node = (at: Point, z: number, system: string): PointElement => {
    const id = generateId('mep_node', ids);
    const n: PointElement = {
      id, tableName: 'mep_node', discipline: 'mep', geometry: 'point', position: { x: at.x, y: at.y }, width: 0, height: 0,
      attrs: { ...defaultAttrs('mep_node', opts.levelId), id, kind: '', system_type: system, base_offset: String(round(z)) },
    };
    put(n);
    return n;
  };
  const pipe = (a: Point, za: number, b: Point, zb: number, from: string, to: string, system: string, size: number): SpatialLineElement => {
    const id = generateId('pipe', ids);
    const s = String(round(size));
    const p: SpatialLineElement = {
      id, tableName: 'pipe', discipline: 'mep', geometry: 'spatial_line',
      start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y }, startZ: round(za), endZ: round(zb), strokeWidth: size,
      attrs: {
        ...defaultAttrs('pipe', opts.levelId), id, system_type: system, shape: 'round', size_x: s, size_y: s,
        start_z: String(round(za)), end_z: String(round(zb)), from, to,
      },
    };
    put(p);
    return p;
  };
  /** Split a curve (as it is now) at a plan point / height with a new tee node. */
  const splitAt = (curveId: string, at: Point, z: number, system: string): PointElement => {
    const c = live.get(curveId) as MepCurve;
    const tee = node(at, z, system);
    const downId = generateId(c.tableName, ids);
    if (isVertical(c)) {
      const s = c as SpatialLineElement;
      const up: SpatialLineElement = { ...s, endZ: z, attrs: { ...s.attrs, end_z: String(round(z)), to: tee.id } };
      const down: SpatialLineElement = { ...s, id: downId, startZ: z, attrs: { ...s.attrs, id: downId, start_z: String(round(z)), from: tee.id, to: s.attrs.to ?? '' } };
      put(up); put(down);
    } else {
      const { upstream, downstream } = splitCurveAt(c, at, tee.id, downId);
      for (const h of [upstream, downstream]) {
        if (h.geometry === 'spatial_line') h.attrs = { ...h.attrs, start_z: String(round(h.startZ)), end_z: String(round(h.endZ)) };
        put(h);
      }
    }
    return tee;
  };

  const groupDist = (opts.groupDistance ?? 3) * upm;
  for (const [stackId, list] of byStack) {
    const stack0 = elements.get(stackId) as SpatialLineElement;
    const zLo = Math.min(stack0.startZ, stack0.endZ), zHi = Math.max(stack0.startZ, stack0.endZ);
    const system = opts.system || (stack0.attrs.system_type ?? '').trim() || 'VENT';
    for (const group of clusters(list, groupDist)) {
      const height = Math.max(...group.map(t => Math.max(t.rim + 0.15 * upm, t.z + 0.3 * upm)));
      if (!(height < zHi - 0.05 * upm) || !(height > zLo + 0.05 * upm)) {
        for (const t of group) result.skipped.push({ id: t.fixture.id, reason: 'stack_low' });
        continue;
      }
      const stackAt = stack0.start;
      // Farthest fixture first: the branch runs from it towards the stack
      const order = [...group].sort((a, b) => dist(b.at, stackAt) - dist(a.at, stackAt));
      const header = 0.05 * upm;
      let prev: { at: Point; node: PointElement } | null = null;
      let dir: Point | null = null;
      for (const t of order) {
        const drainSystem = (t.pipe.attrs.system_type ?? '').trim();
        // The drain may have been split for a previous fixture: split whichever half holds the point
        const host = [...live.values()].find(e => e.tableName === 'pipe' && isCurve(e) && !isVertical(e)
          && (e.id === t.pipe.id || (e.attrs.system_type ?? '') === drainSystem) && onSegment(e as MepCurve, t.at, 1e-4 * upm)) as MepCurve | undefined;
        if (!host) { result.skipped.push({ id: t.fixture.id, reason: 'no_drain' }); continue; }
        const tee = splitAt(host.id, t.at, t.z, drainSystem);
        const top = node(t.at, height, system);
        const size = (t.fixture.attrs.terminal_type === 'water_closet' ? 0.05 : 0.04) * upm;
        pipe(t.at, t.z, t.at, height, tee.id, top.id, system, size);
        if (prev) dir = routeHeader(prev.at, prev.node.id, t.at, top.id, height, system, header, dir);
        prev = { at: t.at, node: top };
      }
      if (!prev) continue;
      // Into the stack: split it at the vent height
      const stackNow = [...live.values()].find(e => e.tableName === 'pipe' && e.geometry === 'spatial_line' && isVertical(e)
        && dist(e.start, stackAt) < 1e-6 && Math.min((e as SpatialLineElement).startZ, (e as SpatialLineElement).endZ) < height
        && Math.max((e as SpatialLineElement).startZ, (e as SpatialLineElement).endZ) > height) as SpatialLineElement | undefined;
      // Another group may already tee into the stack at this height
      const shared = [...changed.values()].find(e => e.tableName === 'mep_node' && e.geometry === 'point'
        && dist((e as PointElement).position, stackAt) < 1e-6 && Math.abs(num(e.attrs.base_offset) - height) < 1e-6) as PointElement | undefined;
      if (!stackNow && !shared) continue;
      const tee = shared ?? splitAt(stackNow!.id, stackAt, height, system);
      routeHeader(prev.at, prev.node.id, stackAt, tee.id, height, system, header, dir);
      result.groups.push({ stack: stackId, fixtures: order.map(t => t.fixture.id), height });
    }
  }

  /**
   * Square horizontal route a → b at `z` (an elbow node at the corner), not
   * doubling back on the leg that arrived at `a` (`inDir`). Returns the
   * direction it arrives at `b` with.
   */
  function routeHeader(a: Point, aRef: string, b: Point, bRef: string, z: number, system: string, size: number, inDir: Point | null): Point {
    const dx = b.x - a.x, dy = b.y - a.y;
    const tiny = 1e-6 * upm;
    const unit = (v: Point) => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
    if (Math.abs(dx) < tiny || Math.abs(dy) < tiny) { pipe(a, z, b, z, aRef, bRef, system, size); return unit({ x: dx, y: dy }); }
    const back = (d: Point) => !!inDir && d.x * inDir.x + d.y * inDir.y < -0.5;
    const xFirst = { corner: { x: b.x, y: a.y }, first: { x: Math.sign(dx), y: 0 }, last: { x: 0, y: Math.sign(dy) } };
    const yFirst = { corner: { x: a.x, y: b.y }, first: { x: 0, y: Math.sign(dy) }, last: { x: Math.sign(dx), y: 0 } };
    // Longer leg first, unless that doubles back
    // A leg lying on a branch already routed (two groups into one stack)
    const overlaps = (p: Point, q: Point) => [...changed.values()].some(e => {
      if (e.tableName !== 'pipe' || e.geometry !== 'spatial_line' || isVertical(e)) return false;
      const c = e as SpatialLineElement;
      if (Math.abs(c.startZ - z) > tiny || Math.abs(c.endZ - z) > tiny) return false;
      const horizontal = Math.abs(p.y - q.y) < tiny;
      if (horizontal !== (Math.abs(c.start.y - c.end.y) < tiny)) return false;
      const [k, j] = horizontal ? ['y', 'x'] as const : ['x', 'y'] as const;
      if (Math.abs(c.start[k] - p[k]) > tiny) return false;
      const lo = Math.max(Math.min(p[j], q[j]), Math.min(c.start[j], c.end[j])), hi = Math.min(Math.max(p[j], q[j]), Math.max(c.start[j], c.end[j]));
      return hi - lo > tiny;
    });
    const bad = (o: typeof xFirst) => (back(o.first) ? 1 : 0) + (overlaps(a, o.corner) || overlaps(o.corner, b) ? 2 : 0);
    let pick = Math.abs(dx) >= Math.abs(dy) ? xFirst : yFirst;
    const other = pick === xFirst ? yFirst : xFirst;
    if (bad(other) < bad(pick)) pick = other;
    const elbow = node(pick.corner, z, system);
    pipe(a, z, pick.corner, z, aRef, elbow.id, system, size);
    pipe(pick.corner, z, b, z, elbow.id, bRef, system, size);
    return pick.last;
  }

  result.patch = [...changed.values()];
  return result;
}

function round(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function onSegment(c: MepCurve, p: Point, tol: number): boolean {
  const dx = c.end.x - c.start.x, dy = c.end.y - c.start.y;
  const L2 = dx * dx + dy * dy;
  if (L2 < 1e-12) return false;
  const t = ((p.x - c.start.x) * dx + (p.y - c.start.y) * dy) / L2;
  if (t <= 1e-6 || t >= 1 - 1e-6) return false;
  return Math.hypot(c.start.x + dx * t - p.x, c.start.y + dy * t - p.y) <= tol;
}
