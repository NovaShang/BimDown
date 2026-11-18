/**
 * Copy of bimdown-editor/editor/src/geometry/stairCore.ts (the editor's stair
 * geometry without element types), so validate / render derive the same runs,
 * railings and repetitions. Keep the two identical (shared-code-drift test).
 */
/**
 * Stair geometry without element types: runs, landings, the riser rule,
 * multi-storey repetitions, derived railing paths, plan symbols and the stair
 * calculator. Shared by the editor (geometry/stair.ts adds the element-level
 * helpers) and the CLI, which keeps a verbatim copy in
 * bimdown-spec/cli/src/stair/geometry.ts (web/src/lib/shared-code-drift.test.ts).
 * Values are in model units (metres for the built-in rule limits).
 */
export interface Point { x: number; y: number }

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
  /** Unit plan direction start → end (the chord of a curved run). */
  u: Point;
  /** Curved run (stair / stair_run with a GeoJSON `arc`): the walking line is this arc; `length` is its arc length. */
  arc?: RunArc;
}

/** Circular walking line: centre, radius, start angle and signed sweep (radians, + = counter-clockwise). */
export interface RunArc { cx: number; cy: number; r: number; a0: number; sweep: number }

export interface StairLanding {
  id: string;
  vertices: Point[];
  /** Level-relative top elevation. */
  top: number;
  thickness: number;
  /** Winder risers in the landing (stair_landing.step_count): it turns as that many treads rising from `top`; 0 = flat. */
  steps?: number;
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

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point, k = 1): Point => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const len = (a: Point) => Math.hypot(a.x, a.y);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
/** Left normal of a direction (model coordinates are Y up). */
const leftOf = (u: Point): Point => ({ x: -u.y, y: u.x });

export function totalRisers(asm: StairAssembly): number {
  return asm.runs.reduce((s, r) => s + r.stepCount, 0) + asm.landings.reduce((s, l) => s + winderSteps(l), 0);
}

export function winderSteps(l: StairLanding): number {
  return Math.max(0, Math.round(l.steps ?? 0));
}

// ─── Curved runs ─────────────────────────────────────────────────────────────

/**
 * Arc through `start` → `end` from the GeoJSON `arc` hint (SVG A semantics:
 * `sweep` true = counter-clockwise in model coordinates, Y up). The radius is
 * scaled up when too short for the chord, as SVG does.
 */
export function arcFromEnds(start: Point, end: Point, radius: number, largeArc: boolean, sweep: boolean): RunArc | null {
  const d = dist(start, end);
  if (d < 1e-9 || !(radius > 0)) return null;
  const r = Math.max(radius, d / 2);
  const m = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  const h = Math.sqrt(Math.max(0, r * r - (d / 2) * (d / 2)));
  const u = { x: (end.x - start.x) / d, y: (end.y - start.y) / d };
  // Centre left of the chord for a counter-clockwise minor arc
  const side = largeArc === sweep ? -1 : 1;
  const c = add(m, leftOf(u), side * h);
  const a0 = Math.atan2(start.y - c.y, start.x - c.x);
  const a1 = Math.atan2(end.y - c.y, end.x - c.x);
  let sw = a1 - a0;
  if (sweep) { while (sw <= 1e-12) sw += 2 * Math.PI; } else { while (sw >= -1e-12) sw -= 2 * Math.PI; }
  return { cx: c.x, cy: c.y, r, a0, sweep: sw };
}

/** GeoJSON `arc` hint of a run arc (radius, large_arc, sweep). */
export function arcHint(a: RunArc): { radius: number; large_arc: boolean; sweep: boolean } {
  return { radius: a.r, large_arc: Math.abs(a.sweep) > Math.PI, sweep: a.sweep > 0 };
}

/** Point `s` along the walking line of a run, offset `o` to its left. */
export function runAt(r: StairRun, s: number, o = 0): Point {
  if (!r.arc) return add(add(r.start, r.u, s), leftOf(r.u), o);
  const { cx, cy, a0, sweep } = r.arc;
  const sg = sweep >= 0 ? 1 : -1;
  const a = a0 + sg * s / r.arc.r;
  // Left of a counter-clockwise walking line is towards the centre
  const rad = r.arc.r - sg * o;
  return { x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad };
}

/** Unit walking direction of a run at `s`. */
export function runDir(r: StairRun, s: number): Point {
  if (!r.arc) return r.u;
  const sg = r.arc.sweep >= 0 ? 1 : -1;
  const a = r.arc.a0 + sg * s / r.arc.r;
  return { x: -Math.sin(a) * sg, y: Math.cos(a) * sg };
}

/** Samples along a run (fractions 0…1): just the ends when straight, every ≤ 5° on an arc, plus `extra`. */
function runSamples(r: StairRun, extra: number[] = []): number[] {
  const n = r.arc ? Math.max(2, Math.ceil(Math.abs(r.arc.sweep) / (Math.PI / 36))) : 1;
  const ts = new Set<number>();
  for (let i = 0; i <= n; i++) ts.add(i / n);
  for (const t of extra) if (t > 1e-9 && t < 1 - 1e-9) ts.add(t);
  return [...ts].sort((a, b) => a - b);
}

/** Tread polygons of a run (plan) with their top heights, bottom tread first. */
export function runTreads(r: StairRun): { poly: Point[]; top: number }[] {
  const n = Math.max(1, r.stepCount);
  const riser = Math.abs(r.endZ - r.startZ) / n;
  const up = r.endZ >= r.startZ;
  const hw = r.width / 2;
  const samples = runSamples(r).map(t => t * r.length);
  const out: { poly: Point[]; top: number }[] = [];
  for (let i = 0; i < n; i++) {
    const s0 = (r.length * i) / n, s1 = (r.length * (i + 1)) / n;
    const ss = [s0, ...samples.filter(s => s > s0 + 1e-9 && s < s1 - 1e-9), s1];
    // Tread i from the bottom end is i + 1 risers up (a run drawn downwards counts from its end)
    const top = up ? r.startZ + riser * (i + 1) : r.endZ + riser * (n - i);
    out.push({ poly: [...ss.map(s => runAt(r, s, hw)), ...[...ss].reverse().map(s => runAt(r, s, -hw))], top });
  }
  return up ? out : out.reverse();
}

/**
 * Solid blocks of stepped treads (curved runs, winders): each tread from
 * its top down to one riser plus `waist` below, so neighbours overlap into a
 * stepped soffit; none reaches below `floor`.
 */
export function treadBlocks(treads: readonly { poly: Point[]; top: number }[], waist = STAIR_WAIST, floor = -Infinity): { poly: Point[]; bottom: number; top: number }[] {
  return treads.map((t, i) => {
    const riser = i > 0 ? t.top - treads[i - 1].top : treads.length > 1 ? treads[1].top - t.top : waist;
    return { poly: t.poly, top: t.top, bottom: Math.min(t.top - 0.01, Math.max(floor, t.top - Math.max(0, riser) - waist)) };
  });
}

/**
 * Runs of a curved / spiral stair: walking line on the circle `centre` /
 * `radius` from `startAngle`, `steps` risers of `going` along it (sweep =
 * steps × going / radius), counter-clockwise when `ccw`. Sweeps past 270°
 * split into several runs (one arc each), risers shared by angle.
 */
export function layoutCurvedStair(
  centre: Point, radius: number, startAngle: number, ccw: boolean,
  steps: number, going: number, baseZ: number, topZ: number,
): StairLayout | null {
  const n = Math.max(1, Math.round(steps));
  if (!(radius > 1e-6) || !(going > 0)) return null;
  const total = (n * going) / radius;
  const pieces = Math.max(1, Math.ceil(total / (1.5 * Math.PI) - 1e-9));
  const riser = (topZ - baseZ) / n;
  const sg = ccw ? 1 : -1;
  const at = (a: number): Point => ({ x: centre.x + Math.cos(a) * radius, y: centre.y + Math.sin(a) * radius });
  const runs: StairLayout['runs'] = [];
  let done = 0, z = baseZ;
  for (let i = 0; i < pieces; i++) {
    const c = i === pieces - 1 ? n - done : Math.round((n * (i + 1)) / pieces) - done;
    if (c < 1) return null;
    const a0 = startAngle + sg * (done * going) / radius;
    const sw = sg * (c * going) / radius;
    const z1 = z + riser * c;
    runs.push({ start: at(a0), end: at(a0 + sw), startZ: round4(z), endZ: round4(z1), steps: c, arc: { cx: centre.x, cy: centre.y, r: radius, a0, sweep: sw } });
    done += c;
    z = z1;
  }
  return { runs, landings: [] };
}

// ─── Winders ─────────────────────────────────────────────────────────────────

export interface WinderGeometry {
  /** Point the winder risers radiate from (the inner corner of an L, the well side of a U). */
  pivot: Point;
  /** Risers between the winder treads (plan), each with the height of the tread it rises to. */
  lines: { a: Point; b: Point; z: number }[];
  /** Winder treads, bottom first. */
  treads: { poly: Point[]; top: number }[];
  /** Walking-line length across the winders. */
  path: number;
  /** Underside of the landing (its top − thickness): the treads stand on it. */
  floor: number;
}

/** Clip a polygon to the side of the directed line p + t·d where sgn · cross(d, q − p) ≥ 0. */
function clipHalf(poly: Point[], p: Point, d: Point, sgn: number): Point[] {
  const side = (q: Point) => sgn * cross(d, sub(q, p));
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = side(a), sb = side(b);
    if (sa >= -1e-12) out.push(a);
    if ((sa >= -1e-12) !== (sb >= -1e-12)) {
      const t = sa / (sa - sb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Nearest and farthest crossing (t ≥ 0) of the ray p + t·d with a polygon outline. */
function rayHits(poly: readonly Point[], p: Point, d: Point): { t0: number; t1: number } | null {
  let t0 = Infinity, t1 = -Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const e = sub(b, a);
    const den = cross(d, e);
    if (Math.abs(den) < 1e-12) continue;
    const w = sub(a, p);
    const t = cross(w, e) / den;
    const v = cross(w, d) / den;
    if (t < -1e-9 || v < -1e-9 || v > 1 + 1e-9) continue;
    t0 = Math.min(t0, Math.max(0, t));
    t1 = Math.max(t1, t);
  }
  return t1 > 1e-9 ? { t0: Math.min(t0, t1), t1 } : null;
}

/** Walking line from the end of run `r` to the start of `q` across a landing (L corner or U crossing). */
function turnPath(r: StairRun, q: StairRun, landing: StairLanding | undefined): Point[] {
  const a = r.end, b = q.start;
  const ur = runDir(r, r.length), uq = runDir(q, 0);
  const x = lineIntersection(a, ur, b, uq);
  if (x && dot(sub(x, a), ur) > -1e-6 && dot(sub(b, x), uq) > -1e-6 && dist(x, a) < 3 * r.width) return [a, x, b];
  if (dot(ur, uq) < -0.5) {
    const depth = landing ? Math.max(0, ...landing.vertices.map(v => dot(sub(v, a), ur))) : r.width;
    return [a, add(a, ur, depth / 2), add(b, uq, -depth / 2), b];
  }
  return [a, b];
}

/** The run leaving a landing: the one after the run arriving on it. */
export function departingRun(asm: StairAssembly, landing: StairLanding): StairRun | undefined {
  const r = arrivingRun(asm, landing);
  if (!r) return undefined;
  const i = asm.runs.indexOf(r);
  return i >= 0 ? asm.runs[i + 1] : undefined;
}

/**
 * Winder treads of a landing with `steps` > 0: the turn between the run
 * arriving on it and the next run, split into `steps` treads of equal going
 * on the walking line, their risers radiating from the inner corner (L) or
 * the middle of the well side (U). Tread i (1…steps) is `top` + i risers;
 * the next run starts on the last one.
 */
export function winderGeometry(asm: StairAssembly, landing: StairLanding): WinderGeometry | null {
  const k = winderSteps(landing);
  if (k < 1) return null;
  const r = arrivingRun(asm, landing);
  const q = departingRun(asm, landing);
  if (!r || !q) return null;
  const riser = r.stepCount > 0 && Math.abs(r.endZ - r.startZ) > 1e-9
    ? (r.endZ - r.startZ) / r.stepCount
    : (Math.min(q.startZ, q.endZ) - landing.top) / k;
  const er = runDir(r, r.length), eq = runDir(q, 0);
  const pivot = lineIntersection(r.end, leftOf(er), q.start, leftOf(eq))
    ?? { x: (r.end.x + q.start.x) / 2, y: (r.end.y + q.start.y) / 2 };
  const path = turnPath(r, q, landing);
  const lens: number[] = [0];
  for (let i = 1; i < path.length; i++) lens.push(lens[i - 1] + dist(path[i - 1], path[i]));
  const L = lens[lens.length - 1];
  if (L < 1e-6) return null;
  const pathAt = (s: number): Point => {
    for (let i = 1; i < path.length; i++) {
      if (s <= lens[i] + 1e-12 || i === path.length - 1) {
        const seg = lens[i] - lens[i - 1];
        return add(path[i - 1], sub(path[i], path[i - 1]), seg > 1e-12 ? (s - lens[i - 1]) / seg : 0);
      }
    }
    return path[path.length - 1];
  };
  // Ray directions from the pivot: 0 = the arriving run's top edge, k = the next run's first riser
  const dirs: Point[] = [];
  for (let i = 0; i <= k; i++) {
    let v = sub(pathAt((L * i) / k), pivot);
    if (len(v) < 1e-9) v = i === 0 ? er : eq;
    const l = len(v);
    dirs.push({ x: v.x / l, y: v.y / l });
  }
  const sgn = cross(dirs[0], sub(pathAt(L / 2), pivot)) >= 0 ? 1 : -1;
  const lines: WinderGeometry['lines'] = [];
  for (let i = 1; i < k; i++) {
    const h = rayHits(landing.vertices, pivot, dirs[i]);
    if (h) lines.push({ a: add(pivot, dirs[i], h.t0), b: add(pivot, dirs[i], h.t1), z: landing.top + riser * (i + 1) });
  }
  const treads: WinderGeometry['treads'] = [];
  for (let i = 0; i < k; i++) {
    const poly = clipHalf(clipHalf([...landing.vertices], pivot, dirs[i], sgn), pivot, dirs[i + 1], -sgn);
    if (poly.length >= 3) treads.push({ poly, top: landing.top + riser * (i + 1) });
  }
  return { pivot, lines, treads, path: L, floor: landing.top - landing.thickness };
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
  // Winder risers climbed after each run (on the landing it arrives on)
  const winders = new Map<StairRun, number>();
  for (const l of asm.landings) {
    const k = winderSteps(l);
    const r = k > 0 ? arrivingRun(asm, l) : undefined;
    if (r) winders.set(r, (winders.get(r) ?? 0) + k);
  }
  let z = baseZ;
  for (const r of asm.runs) {
    const z1 = z + riser * r.stepCount;
    runs.set(r.id, { startZ: round4(z), endZ: round4(z1) });
    z = z1 + riser * (winders.get(r) ?? 0);
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
  const o = (side === 'left' ? 1 : -1) * r.width / 2;
  const p = runAt(r, s, o);
  return { x: p.x, y: p.y, z: nosingZ(r, s), run: { run: r, s } };
}

/** Points of one run edge between s0 and s1 (with the knee where the last tread starts; along the arc of a curved run). */
function runEdge(r: StairRun, side: RailSide, s0: number, s1: number): ChainPt[] {
  const knee = r.length - r.length / r.stepCount;
  const pts = [runEdgePoint(r, side, s0)];
  const inner = runSamples(r, [knee / r.length]).map(t => t * r.length).filter(s => s > s0 + 1e-6 && s < s1 - 1e-6);
  for (const s of inner) pts.push(runEdgePoint(r, side, s));
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
  const winderJoin = runs.map(() => false);
  for (let k = 0; k + 1 < runs.length; k++) {
    const r = runs[k], q = runs[k + 1];
    const bk = runEdgePoint(r, side, r.length), aq = runEdgePoint(q, side, 0);
    const landing = landingBetween(asm, bk, aq, 0.02 + 1e-6);
    if (landing) {
      joins[k] = walkLanding(landing.vertices, bk, aq, side).slice(1, -1);
      winderJoin[k] = winderSteps(landing) > 0;
      continue;
    }
    const ur = runDir(r, r.length), uq = runDir(q, 0);
    // Curved runs continue into each other (tangent) or meet a landing
    if (r.arc || q.arc) continue;
    const x = lineIntersection(bk, ur, aq, uq);
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
      if (winderJoin[k] && joins[k].length > 0) {
        // Across winders the rail climbs with the walking surface to the next run's first nosing
        const from = edge[edge.length - 1];
        const to = runEdgePoint(runs[k + 1], side, s0[k + 1]);
        const path = [from, ...joins[k], to];
        let total = 0;
        for (let i = 1; i < path.length; i++) total += dist(path[i - 1], path[i]);
        let acc = 0;
        for (let i = 1; i + 1 < path.length; i++) {
          acc += dist(path[i - 1], path[i]);
          chain.push({ x: path[i].x, y: path[i].y, z: from.z + (to.z - from.z) * (total > 1e-9 ? acc / total : 0) });
        }
      } else {
        for (const p of joins[k]) chain.push({ x: p.x, y: p.y, z });
      }
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

export interface PlanSeg { a: Point; b: Point; above: boolean; /** Outline (stringer / end) rather than a tread line. */ edge?: boolean }

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
  const hw = r.width / 2;
  const at = (t: number, o: number) => runAt(r, r.length * t, o);
  const goingUp = r.endZ > r.startZ;
  const cut = goingUp && r.endZ - r.startZ > 1e-9
    ? Math.max(0, Math.min(1, (cutZ - r.startZ) / (r.endZ - r.startZ)))
    : r.startZ >= cutZ ? 0 : 1;
  const lines: PlanSeg[] = [];
  const ts = runSamples(r, [cut]);
  for (const o of [hw, -hw]) {
    for (let i = 0; i + 1 < ts.length; i++) {
      lines.push({ a: at(ts[i], o), b: at(ts[i + 1], o), above: ts[i] >= cut - 1e-9, edge: true });
    }
  }
  lines.push({ a: at(0, hw), b: at(0, -hw), above: cut <= 0, edge: true });
  lines.push({ a: at(1, hw), b: at(1, -hw), above: cut < 1, edge: true });
  for (let i = 1; i < r.stepCount; i++) {
    const t = i / r.stepCount;
    lines.push({ a: at(t, hw), b: at(t, -hw), above: t > cut + 1e-9 });
  }
  let breakLine: Point[] | undefined;
  if (cut > 0 && cut < 1) {
    const z = Math.min(0.06, 0.25 / r.length);
    breakLine = [at(cut - z, hw), at(cut - z / 4, hw * 0.1), at(cut + z / 4, -hw * 0.1), at(cut + z, -hw)];
  }
  const os = runSamples(r);
  const outline = [...os.map(t => at(t, hw)), ...[...os].reverse().map(t => at(t, -hw))];
  return { lines, outline, breakLine, cut };
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
    for (const t of runSamples(r)) push(runAt(r, r.length * t));
    const q = runs[k + 1];
    if (!q) break;
    for (const p of turnPath(r, q, landingBetween(asm, r.end, q.start, r.width)).slice(1, -1)) push(p);
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
  // Winders: going on the walking line across the turn
  for (const l of asm.landings) {
    const w = winderGeometry(asm, l);
    if (!w) continue;
    const g = w.path / winderSteps(l) / upm;
    if (g < going) { going = g; goingAt = l.id; }
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
  runs: { start: Point; end: Point; startZ: number; endZ: number; steps: number; arc?: RunArc; width?: number }[];
  /** `steps` > 0: winder landing (that many risers in the turn). */
  landings: { vertices: Point[]; top: number; steps?: number }[];
}

/**
 * Runs and landings for clicked walking-line points: straight (2 points),
 * L / quarter turn (start, corner, end) or U / half turn (start, landing
 * entry, landing exit, end). Runs stop at the landing edge; risers are shared
 * out in proportion to the run lengths, all of one height. With `winders`
 * > 0 each landing turns as that many winder risers instead (counted in
 * `steps`).
 */
export function layoutStair(points: readonly Point[], width: number, steps: number, baseZ: number, topZ: number, winders = 0): StairLayout | null {
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
  const wk = Math.max(0, Math.round(winders));
  const counts: number[] = [];
  const nr = n - wk * landings.length;
  let left = nr;
  for (let i = 0; i < segs.length; i++) {
    const rest = segs.length - i - 1;
    const c = i === segs.length - 1 ? left : Math.max(1, Math.min(left - rest, Math.round(nr * lengths[i] / total)));
    counts.push(c);
    left -= c;
  }
  if (counts.some(c => c < 1)) return null;
  const riser = (topZ - baseZ) / n;
  let z = baseZ;
  const runs = segs.map(([a, b], i) => {
    const z1 = z + riser * counts[i];
    const run = { start: a, end: b, startZ: round4(z), endZ: round4(z1), steps: counts[i] };
    z = z1 + (i < landings.length ? riser * wk : 0);
    return run;
  });
  // Landing polygons counter-clockwise; each at the top of the run before it.
  return {
    runs,
    landings: landings.map((v, i) => ({
      vertices: signedArea(v) < 0 ? [...v].reverse() : v, top: runs[i].endZ, ...(wk > 0 ? { steps: wk } : {}),
    })),
  };
}
