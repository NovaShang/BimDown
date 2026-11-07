/**
 * Stair by component (spec stair.yaml): pure geometry shared by the 2D / 3D
 * views, the drawings, IFC and the consistency rules of the editor.
 *
 * A stair is its own first run (the `stair` line, bottom → top) plus the
 * `stair_run` / `stair_landing` rows hosted on it. Runs are ordered by start
 * Z; every riser of a stair has the same height. A run of N risers has N
 * treads of going = length / N, tread i spanning [i·g, (i+1)·g] at height
 * (i+1)·r, so its last tread is flush with the landing or floor above.
 *
 * Stair railings (railing rows with host_id = stair, side = left | right)
 * have no geometry of their own: `stairRailPath` derives them from the runs
 * and landings. Multi-storey stairs repeat per storey (`stairRepetitions`).
 * Values are in model units (metres for the built-in rule limits).
 */
import type { CanonicalElement, LineElement, PolygonElement, SpatialLineElement, Point } from '../model/elements.ts';

export interface StairRun {
  id: string;
  table: string;
  start: Point;
  end: Point;
  /** Level-relative Z at start / end of the walking line. */
  startZ: number;
  endZ: number;
  width: number;
  stepCount: number;
  length: number;
  /** Unit plan direction start → end. */
  u: Point;
}

export interface StairLanding {
  id: string;
  vertices: Point[];
  /** Level-relative top elevation. */
  top: number;
  thickness: number;
}

export interface StairAssembly {
  stairId: string;
  runs: StairRun[];
  landings: StairLanding[];
  /** False when the stair's own line only spans its stair_run rows (an overall axis, not a flight). */
  ownIsRun: boolean;
}

export const STAIR_RUN_DEFAULT_WIDTH = 1.2;
export const STAIR_DEFAULT_STEPS = 18;
export const LANDING_DEFAULT_THICKNESS = 0.15;
/** Waist (slab thickness under the pitch line) of a solid flight. */
export const STAIR_WAIST = 0.15;
/** Plan cut height of the plan views (m), as in Revit's default view range. */
export const STAIR_CUT_HEIGHT = 1.2;
/** Stair railings stand this far inside the stair edge. */
export const RAIL_INSET = 0.05;

const num = (s: string | undefined, fallback: number): number => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : fallback;
};

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point, k = 1): Point => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const len = (a: Point) => Math.hypot(a.x, a.y);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
/** Left normal of a direction (model coordinates are Y up). */
const leftOf = (u: Point): Point => ({ x: -u.y, y: u.x });

/** Host reference of a part / railing (unprefixed or prefixed). */
export function hostRefOf(el: CanonicalElement): string {
  return el.attrs.host_id || el.hostId || '';
}

/** One run from a `stair` / `stair_run` element; null when it has no length. */
export function runOf(el: CanonicalElement): StairRun | null {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  const ln = el as LineElement;
  const d = sub(ln.end, ln.start);
  const length = len(d);
  if (length < 1e-3) return null;
  let startZ: number, endZ: number;
  if (el.geometry === 'spatial_line') {
    startZ = (el as SpatialLineElement).startZ;
    endZ = (el as SpatialLineElement).endZ;
  } else {
    startZ = num(ln.attrs.start_z, 0);
    endZ = num(ln.attrs.end_z, 3);
  }
  return {
    id: el.id, table: el.tableName,
    start: ln.start, end: ln.end, startZ, endZ,
    width: num(ln.attrs.width, STAIR_RUN_DEFAULT_WIDTH) || STAIR_RUN_DEFAULT_WIDTH,
    stepCount: Math.max(1, Math.round(num(ln.attrs.step_count, STAIR_DEFAULT_STEPS)) || STAIR_DEFAULT_STEPS),
    length, u: { x: d.x / length, y: d.y / length },
  };
}

export function landingOf(el: CanonicalElement): StairLanding | null {
  if (el.geometry !== 'polygon') return null;
  const p = el as PolygonElement;
  const vertices = p.vertices.length > 1 && dist(p.vertices[0], p.vertices[p.vertices.length - 1]) < 1e-9
    ? p.vertices.slice(0, -1) : p.vertices;
  if (vertices.length < 3) return null;
  return {
    id: el.id, vertices,
    top: num(p.attrs.base_offset, 0),
    thickness: num(p.attrs.thickness, LANDING_DEFAULT_THICKNESS) || LANDING_DEFAULT_THICKNESS,
  };
}

/** The stair's runs (own line first, then stair_run rows by start Z) and landings. */
export function assembleStair(stair: CanonicalElement, children: Iterable<CanonicalElement>): StairAssembly {
  const runs: StairRun[] = [];
  const own = runOf(stair);
  const extra: StairRun[] = [];
  const landings: StairLanding[] = [];
  for (const c of children) {
    if (c.tableName === 'stair_run') {
      const r = runOf(c);
      if (r) extra.push(r);
    } else if (c.tableName === 'stair_landing') {
      const l = landingOf(c);
      if (l) landings.push(l);
    }
  }
  extra.sort((a, b) => Math.min(a.startZ, a.endZ) - Math.min(b.startZ, b.endZ));
  // A stair line with the same bottom and top as its stair_run rows is the
  // stair's overall axis (exporter form), not a flight of its own.
  const ownIsRun = !!own && !(extra.length > 0
    && Math.abs(Math.min(own.startZ, own.endZ) - Math.min(...extra.map(r => Math.min(r.startZ, r.endZ)))) < 1e-3
    && Math.abs(Math.max(own.startZ, own.endZ) - Math.max(...extra.map(r => Math.max(r.startZ, r.endZ)))) < 1e-3);
  if (own && ownIsRun) runs.push(own);
  runs.push(...extra);
  return { stairId: stair.id, runs, landings, ownIsRun };
}

/** Minimal lookup surface of a GeometryContext. */
export interface StairLookup {
  elementById(id: string): CanonicalElement | undefined;
  hostedOf(hostId: string): CanonicalElement[];
}

/**
 * Resolve an element reference from `selfId`'s point of view: as given, with
 * the referrer's level prefix (3D / all-floors maps key `lv-1:st-1`), then the
 * global copy.
 */
export function resolveRef(ctx: StairLookup, ref: string, selfId = ''): CanonicalElement | undefined {
  if (!ref) return undefined;
  const colon = selfId.indexOf(':');
  return ctx.elementById(ref)
    ?? (colon >= 0 ? ctx.elementById(`${selfId.slice(0, colon)}:${ref}`) : undefined)
    ?? ctx.elementById(`global:${ref}`);
}

/** The stair an element (run, landing, railing) is hosted on. */
export function findStair(ctx: StairLookup, ref: string, selfId = ''): CanonicalElement | undefined {
  const el = resolveRef(ctx, ref, selfId);
  return el && el.tableName === 'stair' ? el : undefined;
}

export function stairAssemblyIn(ctx: StairLookup, stair: CanonicalElement): StairAssembly {
  return assembleStair(stair, ctx.hostedOf(stair.id));
}

// ─── Riser rule / consistency ────────────────────────────────────────────────

export function totalRisers(asm: StairAssembly): number {
  return asm.runs.reduce((s, r) => s + r.stepCount, 0);
}

/** Distance from a point to a polygon (0 inside). */
export function pointPolygonDistance(p: Point, poly: readonly Point[]): number {
  let inside = false;
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    best = Math.min(best, dist(p, closestOnSegment(p, a, b).point));
  }
  return inside ? 0 : best;
}

function closestOnSegment(p: Point, a: Point, b: Point): { point: Point; t: number } {
  const ab = sub(b, a);
  const l2 = dot(ab, ab);
  const t = l2 < 1e-12 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
  return { point: add(a, ab, t), t };
}

/** The run arriving on a landing: the one whose top end is closest to it (within 1.5 run widths). */
export function arrivingRun(asm: StairAssembly, landing: StairLanding): StairRun | undefined {
  let best: StairRun | undefined;
  let bestD = Infinity;
  for (const r of asm.runs) {
    const top = r.endZ >= r.startZ ? r.end : r.start;
    const d = pointPolygonDistance(top, landing.vertices);
    if (d < bestD - 1e-9) { bestD = d; best = r; }
  }
  return best && bestD <= best.width * 1.5 ? best : undefined;
}

export interface StairZPlan {
  runs: Map<string, { startZ: number; endZ: number }>;
  landings: Map<string, number>;
}

/**
 * Z values that satisfy the riser rule between `baseZ` and `topZ`: runs in
 * order, each rising by its step count of the common riser; each landing at
 * the top of the run arriving on it.
 */
export function planStairZ(asm: StairAssembly, baseZ: number, topZ: number): StairZPlan {
  const n = totalRisers(asm);
  const riser = n > 0 ? (topZ - baseZ) / n : 0;
  const runs = new Map<string, { startZ: number; endZ: number }>();
  let z = baseZ;
  for (const r of asm.runs) {
    const z1 = z + riser * r.stepCount;
    runs.set(r.id, { startZ: round4(z), endZ: round4(z1) });
    z = z1;
  }
  const landings = new Map<string, number>();
  const planned: StairAssembly = {
    ...asm,
    runs: asm.runs.map(r => ({ ...r, ...runs.get(r.id)! })),
  };
  for (const l of asm.landings) {
    const r = arrivingRun(planned, l);
    if (r) landings.set(l.id, Math.max(r.startZ, r.endZ));
  }
  return { runs, landings };
}

const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

// ─── Multi-storey ────────────────────────────────────────────────────────────

export interface StairRepetition {
  index: number;
  /** Level the repetition starts on (the stair's own level for index 0). */
  levelId: string;
  /** Level-relative Z of a point of the base stair → z · scale + dz. */
  dz: number;
  scale: number;
}

/**
 * Storeys a stair occupies: itself, plus with `multistory_top_level_id` one
 * repetition per storey up to that level. Repetitions keep the step count;
 * the rise scales with the storey height (so the riser adapts).
 */
export function stairRepetitions(
  attrs: Record<string, string>,
  levelId: string,
  levelElevation: number,
  levelElevations: ReadonlyMap<string, number>,
): StairRepetition[] {
  const base: StairRepetition = { index: 0, levelId, dz: 0, scale: 1 };
  const topId = attrs.multistory_top_level_id;
  const top = topId ? levelElevations.get(topId) : undefined;
  if (top === undefined || top <= levelElevation + 1e-6) return [base];
  const above: { id: string; e: number }[] = [];
  for (const [id, e] of levelElevations) {
    if (e > levelElevation + 1e-6 && e <= top + 1e-6 && !above.some(a => Math.abs(a.e - e) < 1e-6)) above.push({ id, e });
  }
  above.sort((a, b) => a.e - b.e);
  if (above.length < 1) return [base];
  const elev = [levelElevation, ...above.map(a => a.e)];
  const ids = [levelId, ...above.map(a => a.id)];
  const h0 = elev[1] - elev[0];
  const reps: StairRepetition[] = [];
  for (let i = 0; i + 1 < elev.length; i++) {
    reps.push({ index: i, levelId: ids[i], dz: elev[i] - elev[0], scale: h0 > 1e-9 ? (elev[i + 1] - elev[i]) / h0 : 1 });
  }
  return reps;
}

export function repZ(rep: StairRepetition, z: number): number {
  return rep.dz + z * rep.scale;
}

/** The stair's repetitions from a geometry context (`levelElevation` = the stair's level). */
export function stairRepetitionsIn(
  stair: CanonicalElement,
  ctx: { level: { id: string }; levelElevation: number; levelElevations: ReadonlyMap<string, number> },
): StairRepetition[] {
  return stairRepetitions(stair.attrs, ctx.level.id, ctx.levelElevation, ctx.levelElevations);
}

// ─── Solid flight ────────────────────────────────────────────────────────────

/**
 * Side profile of a solid flight in (u along the run, v up) from the bottom
 * of the first riser: steps on top, a soffit parallel to the pitch line
 * `waist` below it. Matches the IFC flight body.
 */
export function flightProfile(length: number, rise: number, steps: number, waist = STAIR_WAIST): Point[] {
  const n = Math.max(1, steps);
  if (Math.abs(rise) < 0.01) {
    return [{ x: 0, y: -waist }, { x: length, y: -waist }, { x: length, y: 0 }, { x: 0, y: 0 }];
  }
  const d = length / n, h = rise / n;
  const out: Point[] = [{ x: 0, y: 0 }];
  for (let i = 0; i < n; i++) {
    out.push({ x: i * d, y: (i + 1) * h });
    out.push({ x: (i + 1) * d, y: (i + 1) * h });
  }
  // Soffit: the pitch line dropped by the vertical waist, meeting the floor at u0.
  const waistV = Math.min(waist * Math.hypot(d, h) / d, rise * 0.6);
  out.push({ x: length, y: rise - waistV });
  out.push({ x: (waistV * length) / rise, y: 0 });
  return out;
}

// ─── Railing path ────────────────────────────────────────────────────────────

export type RailSide = 'left' | 'right';

export interface RailPoint { x: number; y: number; z: number }

/** A straight piece of a rail path; `run` marks a flight edge (balusters stand on its treads). */
export interface RailSegment {
  a: RailPoint;
  b: RailPoint;
  run?: { going: number; riser: number; startZ: number; s0: number; s1: number; steps: number };
}

interface ChainPt extends RailPoint { run?: { run: StairRun; s: number } }

/** Walking-surface height under the rail of run `r` at distance `s` (nosing line, flat on the last tread). */
function nosingZ(r: StairRun, s: number): number {
  const g = r.length / r.stepCount;
  const riser = (r.endZ - r.startZ) / r.stepCount;
  if (s >= r.length - g) return r.endZ;
  return r.startZ + riser + Math.max(0, s) * (riser / g);
}

function runEdgePoint(r: StairRun, side: RailSide, s: number): ChainPt {
  const n = leftOf(r.u);
  const o = (side === 'left' ? 1 : -1) * r.width / 2;
  const p = add(add(r.start, r.u, s), n, o);
  return { x: p.x, y: p.y, z: nosingZ(r, s), run: { run: r, s } };
}

/** Points of one run edge between s0 and s1 (with the knee where the last tread starts). */
function runEdge(r: StairRun, side: RailSide, s0: number, s1: number): ChainPt[] {
  const knee = r.length - r.length / r.stepCount;
  const pts = [runEdgePoint(r, side, s0)];
  if (knee > s0 + 1e-6 && knee < s1 - 1e-6) pts.push(runEdgePoint(r, side, knee));
  pts.push(runEdgePoint(r, side, s1));
  return pts;
}

function lineIntersection(p: Point, u: Point, q: Point, v: Point): Point | null {
  const den = cross(u, v);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(q, p), v) / den;
  return add(p, u, t);
}

/** Closest boundary location of a polygon: edge index + parameter. */
function boundaryLocation(p: Point, poly: readonly Point[]): { edge: number; t: number; point: Point; d: number } {
  let best = { edge: 0, t: 0, point: poly[0], d: Infinity };
  for (let i = 0; i < poly.length; i++) {
    const c = closestOnSegment(p, poly[i], poly[(i + 1) % poly.length]);
    const d = dist(p, c.point);
    if (d < best.d) best = { edge: i, t: c.t, point: c.point, d };
  }
  return best;
}

const signedArea = (v: readonly Point[]) => {
  let a = 0;
  for (let i = 0; i < v.length; i++) a += cross(v[i], v[(i + 1) % v.length]);
  return a / 2;
};

/**
 * Walk a landing boundary from P to Q. Left rails keep the landing on their
 * right (clockwise), right rails on their left (counter-clockwise).
 */
function walkLanding(poly: readonly Point[], p: Point, q: Point, side: RailSide): Point[] {
  const ccw = signedArea(poly) > 0;
  const forward = (side === 'right') === ccw; // traverse in vertex order?
  const a = boundaryLocation(p, poly), b = boundaryLocation(q, poly);
  const n = poly.length;
  const out: Point[] = [a.point];
  if (a.edge === b.edge && (forward ? b.t >= a.t - 1e-9 : b.t <= a.t + 1e-9)) {
    out.push(b.point);
    return out;
  }
  let e = a.edge;
  for (let guard = 0; guard <= n; guard++) {
    if (forward) {
      out.push(poly[(e + 1) % n]);
      e = (e + 1) % n;
    } else {
      out.push(poly[e]);
      e = (e - 1 + n) % n;
    }
    if (e === b.edge) break;
  }
  out.push(b.point);
  return out;
}

/** The landing between two consecutive runs, if both ends touch it. */
function landingBetween(asm: StairAssembly, a: Point, b: Point, tol: number): StairLanding | undefined {
  let best: StairLanding | undefined;
  let bestD = Infinity;
  for (const l of asm.landings) {
    const d = Math.max(boundaryLocation(a, l.vertices).d, boundaryLocation(b, l.vertices).d);
    if (d < bestD) { bestD = d; best = l; }
  }
  return best && bestD <= tol ? best : undefined;
}

/** Plan chain of one side along the stair outline (before the inset). */
function railChain(asm: StairAssembly, side: RailSide): ChainPt[] {
  const runs = asm.runs;
  if (runs.length === 0) return [];
  const chain: ChainPt[] = [];
  // Start / end parameters of each run edge (clipped / extended at corners)
  const s0 = runs.map(() => 0);
  const s1 = runs.map(r => r.length);
  const joins: Point[][] = runs.map(() => []);
  for (let k = 0; k + 1 < runs.length; k++) {
    const r = runs[k], q = runs[k + 1];
    const bk = runEdgePoint(r, side, r.length), aq = runEdgePoint(q, side, 0);
    const landing = landingBetween(asm, bk, aq, 0.02 + 1e-6);
    if (landing) {
      joins[k] = walkLanding(landing.vertices, bk, aq, side).slice(1, -1);
      continue;
    }
    const x = lineIntersection(bk, r.u, aq, q.u);
    if (x && dist(x, bk) < 3 * r.width + r.length && dist(x, aq) < 3 * q.width + q.length) {
      // Corner: clip / extend both edges to the intersection of their lines.
      const tr = dot(sub(x, runEdgePoint(r, side, 0)), r.u);
      const tq = dot(sub(x, runEdgePoint(q, side, 0)), q.u);
      if (tr < r.length) s1[k] = Math.max(0, tr);
      if (tq > 0) s0[k + 1] = Math.min(q.length, tq);
      if (tr >= r.length || tq <= 0) joins[k] = [x];
      continue;
    }
    if (dot(r.u, q.u) < -0.5) {
      // Opposite runs without a landing: go round the far side for the outer rail.
      const outer = cross(r.u, sub(aq, bk)) * (side === 'left' ? 1 : -1) < 0;
      if (outer) {
        const depth = Math.max(r.width, q.width);
        joins[k] = [add(bk, r.u, depth), add(aq, q.u, -depth)];
      }
    }
  }
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    const edge = runEdge(r, side, s0[k], Math.max(s0[k], s1[k]));
    chain.push(...edge);
    if (k + 1 < runs.length) {
      const z = Math.max(r.startZ, r.endZ);
      for (const p of joins[k]) chain.push({ x: p.x, y: p.y, z });
    }
  }
  return chain;
}

/** Offset an open polyline sideways (positive = left), mitred; points at the same plan spot move together. */
function offsetChain(pts: ChainPt[], d: number): ChainPt[] {
  // Distinct plan positions
  const groups: { p: Point; idx: number[] }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const last = groups[groups.length - 1];
    if (last && dist(last.p, pts[i]) < 1e-6) last.idx.push(i);
    else groups.push({ p: { x: pts[i].x, y: pts[i].y }, idx: [i] });
  }
  const out = pts.map(p => ({ ...p }));
  if (groups.length < 2) return out;
  const dirs: Point[] = [];
  for (let g = 0; g + 1 < groups.length; g++) {
    const v = sub(groups[g + 1].p, groups[g].p);
    const l = len(v);
    dirs.push({ x: v.x / l, y: v.y / l });
  }
  for (let g = 0; g < groups.length; g++) {
    const din = dirs[g - 1], dout = dirs[g];
    let shift: Point;
    if (!din) shift = add({ x: 0, y: 0 }, leftOf(dout), d);
    else if (!dout) shift = add({ x: 0, y: 0 }, leftOf(din), d);
    else {
      const n1 = leftOf(din), n2 = leftOf(dout);
      const m = add(n1, n2);
      const ml = len(m);
      if (ml < 1e-6) shift = add({ x: 0, y: 0 }, n1, d);
      else {
        const mu = { x: m.x / ml, y: m.y / ml };
        const k = Math.min(4, 1 / Math.max(0.25, dot(mu, n1)));
        shift = add({ x: 0, y: 0 }, mu, d * k);
      }
    }
    for (const i of groups[g].idx) { out[i].x += shift.x; out[i].y += shift.y; }
  }
  return out;
}

/**
 * The 3D path of a stair railing on one side: along the run edges (inset),
 * around the outer side of landings and across the well side of U stairs.
 * Z is the walking surface (nosing line on flights, landing top on landings).
 */
export function stairRailPath(asm: StairAssembly, side: RailSide, inset = RAIL_INSET): RailSegment[] {
  const chain = offsetChain(railChain(asm, side), side === 'left' ? -inset : inset);
  const segs: RailSegment[] = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const a = chain[i], b = chain[i + 1];
    if (dist(a, b) < 1e-6 && Math.abs(a.z - b.z) < 1e-6) continue;
    const seg: RailSegment = { a: { x: a.x, y: a.y, z: a.z }, b: { x: b.x, y: b.y, z: b.z } };
    if (a.run && b.run && a.run.run === b.run.run && b.run.s > a.run.s + 1e-6) {
      const r = a.run.run;
      seg.run = {
        going: r.length / r.stepCount, riser: (r.endZ - r.startZ) / r.stepCount,
        startZ: r.startZ, s0: a.run.s, s1: b.run.s, steps: r.stepCount,
      };
    }
    segs.push(seg);
  }
  return segs;
}

/** A sketched railing as one segment standing at z (level-relative). */
export function lineRailPath(start: Point, end: Point, startZ: number, endZ: number): RailSegment[] {
  return [{ a: { x: start.x, y: start.y, z: startZ }, b: { x: end.x, y: end.y, z: endZ } }];
}

export interface Baluster { x: number; y: number; /** foot (tread / floor) */ z0: number; /** under the top rail */ z1: number }

/**
 * Balusters along a rail path at `spacing`, one at every corner; on flights
 * each stands on the tread below it. `height` = top of rail above the path.
 */
export function railBalusters(segs: readonly RailSegment[], spacing: number, height: number): Baluster[] {
  const out: Baluster[] = [];
  if (spacing <= 1e-6) return out;
  const push = (p: RailPoint, foot: number) => out.push({ x: p.x, y: p.y, z0: foot, z1: p.z + height });
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const l = Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);
    if (l < 1e-6) continue;
    const count = Math.max(1, Math.round(l / spacing));
    for (let j = 0; j < count; j++) {
      const t = j / count;
      const p = { x: s.a.x + (s.b.x - s.a.x) * t, y: s.a.y + (s.b.y - s.a.y) * t, z: s.a.z + (s.b.z - s.a.z) * t };
      let foot = p.z;
      if (s.run) {
        const along = s.run.s0 + (s.run.s1 - s.run.s0) * t;
        const step = Math.min(s.run.steps - 1, Math.max(0, Math.floor(along / s.run.going + 1e-9)));
        foot = s.run.startZ + (step + 1) * s.run.riser;
      }
      push(p, foot);
    }
  }
  const last = segs[segs.length - 1];
  if (last) {
    const foot = last.run ? last.run.startZ + last.run.steps * last.run.riser : last.b.z;
    push(last.b, foot);
  }
  return out;
}

/** Plan polyline of a rail path (consecutive duplicates dropped). */
export function railPlan(segs: readonly RailSegment[]): Point[] {
  const out: Point[] = [];
  for (const s of segs) {
    for (const p of [s.a, s.b]) {
      const last = out[out.length - 1];
      if (!last || dist(last, p) > 1e-6) out.push({ x: p.x, y: p.y });
    }
  }
  return out;
}

// ─── Plan graphics ───────────────────────────────────────────────────────────

export interface PlanSeg { a: Point; b: Point; above: boolean }

export interface RunPlan {
  /** Outline, stringers and treads; `above` = beyond the plan cut (dashed / hidden). */
  lines: PlanSeg[];
  /** Footprint polygon. */
  outline: Point[];
  /** Zig-zag break line across the run at the cut, when the cut crosses it. */
  breakLine?: Point[];
  /** Fraction of the run below the cut. */
  cut: number;
}

/** Run outline / treads split at the plan cut height (level-relative `cutZ`). */
export function runPlan(r: StairRun, cutZ: number): RunPlan {
  const n = leftOf(r.u);
  const hw = r.width / 2;
  const at = (t: number, o: number) => add(add(r.start, r.u, r.length * t), n, o);
  const goingUp = r.endZ > r.startZ;
  const cut = goingUp && r.endZ - r.startZ > 1e-9
    ? Math.max(0, Math.min(1, (cutZ - r.startZ) / (r.endZ - r.startZ)))
    : r.startZ >= cutZ ? 0 : 1;
  const lines: PlanSeg[] = [];
  for (const o of [hw, -hw]) {
    if (cut > 0) lines.push({ a: at(0, o), b: at(cut, o), above: false });
    if (cut < 1) lines.push({ a: at(cut, o), b: at(1, o), above: true });
  }
  lines.push({ a: at(0, hw), b: at(0, -hw), above: cut <= 0 });
  lines.push({ a: at(1, hw), b: at(1, -hw), above: cut < 1 });
  for (let i = 1; i < r.stepCount; i++) {
    const t = i / r.stepCount;
    lines.push({ a: at(t, hw), b: at(t, -hw), above: t > cut + 1e-9 });
  }
  let breakLine: Point[] | undefined;
  if (cut > 0 && cut < 1) {
    const z = Math.min(0.06, 0.25 / r.length);
    breakLine = [at(cut - z, hw), at(cut - z / 4, hw * 0.1), at(cut + z / 4, -hw * 0.1), at(cut + z, -hw)];
  }
  return { lines, outline: [at(0, hw), at(1, hw), at(1, -hw), at(0, -hw)], breakLine, cut };
}

/**
 * Walking line of the whole stair (plan): run centre lines joined across
 * landings — through the corner of L turns, across the middle of U landings.
 */
export function walkingLine(asm: StairAssembly): Point[] {
  const out: Point[] = [];
  const push = (p: Point) => {
    const last = out[out.length - 1];
    if (!last || dist(last, p) > 1e-6) out.push(p);
  };
  const runs = asm.runs;
  for (let k = 0; k < runs.length; k++) {
    const r = runs[k];
    push(r.start);
    push(r.end);
    const q = runs[k + 1];
    if (!q) break;
    const x = lineIntersection(r.end, r.u, q.start, q.u);
    if (x && dot(sub(x, r.end), r.u) > -1e-6 && dot(sub(q.start, x), q.u) > -1e-6 && dist(x, r.end) < 3 * r.width) {
      push(x);
    } else if (dot(r.u, q.u) < -0.5) {
      const l = landingBetween(asm, r.end, q.start, r.width);
      const depth = l ? Math.max(0, ...l.vertices.map(v => dot(sub(v, r.end), r.u))) : r.width;
      push(add(r.end, r.u, depth / 2));
      push(add(q.start, q.u, -depth / 2));
    }
  }
  return out;
}

// ─── Calculator ──────────────────────────────────────────────────────────────

export type StairCheckKey = 'riser' | 'going' | 'blondel' | 'width' | 'landing';

export interface StairCheck {
  key: StairCheckKey;
  ok: boolean;
  /** Measured value (m; for `landing` the worst mismatch). */
  value: number;
  /** Run / landing / repetition the worst value comes from. */
  where?: string;
}

export interface StairCalc {
  risers: number;
  rise: number;
  /** Riser height of the base stair, m. */
  riser: number;
  /** Shortest going of any run, m. */
  going: number;
  /** 2R + G with the shortest going, m. */
  blondel: number;
  width: number;
  checks: StairCheck[];
}

/** Comfort / code limits (m), common to most building codes (EN / IBC / GB 50352). */
export const STAIR_LIMITS = {
  riserMin: 0.15, riserMax: 0.19, goingMin: 0.26, blondelMin: 0.6, blondelMax: 0.65, widthMin: 0.9,
};

/**
 * Riser = rise / risers, going per run, and the checks; `upm` = model units
 * per metre; `scales` = storey scale of each multi-storey repetition.
 */
export function stairCalc(asm: StairAssembly, upm = 1, scales: readonly number[] = [1]): StairCalc | null {
  if (asm.runs.length === 0) return null;
  const risers = totalRisers(asm);
  const z0 = Math.min(...asm.runs.map(r => Math.min(r.startZ, r.endZ)));
  const z1 = Math.max(...asm.runs.map(r => Math.max(r.startZ, r.endZ)));
  const rise = (z1 - z0) / upm;
  const riser = risers > 0 ? rise / risers : 0;
  let going = Infinity, goingAt = '';
  let width = Infinity, widthAt = '';
  for (const r of asm.runs) {
    const g = r.length / r.stepCount / upm;
    if (g < going) { going = g; goingAt = r.id; }
    if (r.width / upm < width) { width = r.width / upm; widthAt = r.id; }
  }
  // Riser per repetition (multi-storey stairs adapt it to each storey)
  let rMin = riser, rMax = riser;
  for (const s of scales) { rMin = Math.min(rMin, riser * s); rMax = Math.max(rMax, riser * s); }
  const L = STAIR_LIMITS;
  const riserBad = rMax > L.riserMax + 1e-9 ? rMax : rMin < L.riserMin - 1e-9 ? rMin : riser;
  const blondel = 2 * riser + going;
  let landingWorst = 0, landingAt = '';
  for (const l of asm.landings) {
    const r = arrivingRun(asm, l);
    if (!r) continue;
    const d = Math.abs(l.top - Math.max(r.startZ, r.endZ)) / upm;
    if (d > landingWorst) { landingWorst = d; landingAt = l.id; }
  }
  const checks: StairCheck[] = [
    { key: 'riser', ok: rMin >= L.riserMin - 1e-9 && rMax <= L.riserMax + 1e-9, value: riserBad },
    { key: 'going', ok: going >= L.goingMin - 1e-9, value: going, where: goingAt },
    { key: 'blondel', ok: blondel >= L.blondelMin - 1e-9 && blondel <= L.blondelMax + 1e-9, value: blondel },
    { key: 'width', ok: width >= L.widthMin - 1e-9, value: width, where: widthAt },
  ];
  if (asm.landings.length > 0) checks.push({ key: 'landing', ok: landingWorst <= 0.01, value: landingWorst, where: landingAt || undefined });
  return { risers, rise, riser, going, blondel, width, checks };
}

// ─── Placement layout ────────────────────────────────────────────────────────

export interface StairLayout {
  runs: { start: Point; end: Point; startZ: number; endZ: number; steps: number }[];
  landings: { vertices: Point[]; top: number }[];
}

/**
 * Runs and landings for clicked walking-line points: straight (2 points),
 * L / quarter turn (start, corner, end) or U / half turn (start, landing
 * entry, landing exit, end). Runs stop at the landing edge; risers are shared
 * out in proportion to the run lengths, all of one height.
 */
export function layoutStair(points: readonly Point[], width: number, steps: number, baseZ: number, topZ: number): StairLayout | null {
  const n = Math.max(1, Math.round(steps));
  const hw = width / 2;
  const unitDir = (a: Point, b: Point): Point | null => {
    const l = dist(a, b);
    return l < 1e-6 ? null : { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  let segs: [Point, Point][];
  const landings: Point[][] = [];
  if (points.length === 2) {
    segs = [[points[0], points[1]]];
  } else if (points.length === 3) {
    const [s, c, e] = points;
    const u0 = unitDir(s, c), u1 = unitDir(c, e);
    if (!u0 || !u1) return null;
    segs = [[s, add(c, u0, -hw)], [add(c, u1, hw), e]];
    const n0 = leftOf(u0);
    landings.push([
      add(add(c, u0, -hw), n0, -hw), add(add(c, u0, hw), n0, -hw),
      add(add(c, u0, hw), n0, hw), add(add(c, u0, -hw), n0, hw),
    ]);
  } else if (points.length === 4) {
    const [s, m1, m2, e] = points;
    const u0 = unitDir(s, m1), across = unitDir(m1, m2), u1 = unitDir(m2, e);
    if (!u0 || !across || !u1) return null;
    segs = [[s, add(m1, u0, -hw)], [add(m2, u1, hw), e]];
    // Landing: one run width deep, from the outer edge of run 1 to the outer edge of run 2.
    const a = add(m1, across, -hw), b = add(m2, across, hw);
    landings.push([add(a, u0, -hw), add(b, u0, -hw), add(b, u0, hw), add(a, u0, hw)]);
  } else return null;
  const lengths = segs.map(([a, b]) => dist(a, b));
  if (lengths.some(l => l < 1e-3)) return null;
  const total = lengths.reduce((s, l) => s + l, 0);
  const counts: number[] = [];
  let left = n;
  for (let i = 0; i < segs.length; i++) {
    const rest = segs.length - i - 1;
    const c = i === segs.length - 1 ? left : Math.max(1, Math.min(left - rest, Math.round(n * lengths[i] / total)));
    counts.push(c);
    left -= c;
  }
  if (counts.some(c => c < 1)) return null;
  const riser = (topZ - baseZ) / n;
  let z = baseZ;
  const runs = segs.map(([a, b], i) => {
    const z1 = z + riser * counts[i];
    const run = { start: a, end: b, startZ: round4(z), endZ: round4(z1), steps: counts[i] };
    z = z1;
    return run;
  });
  // Landing polygons counter-clockwise; each at the top of the run before it.
  return {
    runs,
    landings: landings.map((v, i) => ({ vertices: signedArea(v) < 0 ? [...v].reverse() : v, top: runs[i].endZ })),
  };
}
