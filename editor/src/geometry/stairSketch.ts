/**
 * Stair by sketch (Revit "Create Sketch"): a boundary outline and riser
 * lines → the runs and landings of the stair model (spec stair.yaml).
 *
 * Risers are ordered into a chain along the walking direction (the first
 * one drawn sits at the bottom end). Consecutive parallel risers with even
 * spacing form a run: risers = lines, going = their spacing, the run ending
 * one going after its last line (its last tread is flush with the landing or
 * floor). Turned risers between two runs are winders: the earlier run's last
 * line is then the first winder riser, and the turn becomes a winder landing
 * (stair_landing.step_count). Runs with nothing between them meet at a flat
 * landing: the part of the boundary between the two runs (or, with no
 * boundary, the square / strip joining their ends).
 */
import type { Point } from '../model/elements.ts';
import type { StairLayout } from './stairCore.ts';

export interface StairSketch {
  /** Closed outline (optional for a single run). */
  boundary: Point[];
  /** Riser lines, in the order drawn. */
  risers: [Point, Point][];
}

export type SketchError = 'risers' | 'boundary' | 'runs';

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Point, b: Point, k = 1): Point => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y;
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (s: [Point, Point]): Point => ({ x: (s[0].x + s[1].x) / 2, y: (s[0].y + s[1].y) / 2 });
const unit = (v: Point): Point => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l }; };
const round4 = (v: number) => Math.round(v * 1e4) / 1e4;

/** Riser lines this close in direction (sine of the angle) count as parallel. */
const PARALLEL_SIN = Math.sin((3 * Math.PI) / 180);

function signedArea(v: readonly Point[]): number {
  let a = 0;
  for (let i = 0; i < v.length; i++) a += cross(v[i], v[(i + 1) % v.length]);
  return a / 2;
}

/** Keep the part of `poly` where dot(q − p, n) ≥ 0. */
function clip(poly: Point[], p: Point, n: Point): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const sa = dot(sub(a, p), n), sb = dot(sub(b, p), n);
    if (sa >= -1e-9) out.push(a);
    if ((sa >= -1e-9) !== (sb >= -1e-9)) out.push(add(a, sub(b, a), sa / (sa - sb)));
  }
  return out;
}

function convexHull(pts: Point[]): Point[] {
  const p = [...pts].sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const lower: Point[] = [], upper: Point[] = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(sub(lower[lower.length - 1], lower[lower.length - 2]), sub(q, lower[lower.length - 2])) <= 1e-12) lower.pop();
    lower.push(q);
  }
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(sub(upper[upper.length - 1], upper[upper.length - 2]), sub(q, upper[upper.length - 2])) <= 1e-12) upper.pop();
    upper.push(q);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Risers ordered along the stair: the shortest nearest-neighbour chain, starting at the end nearer the first riser drawn. */
export function orderRisers(risers: readonly [Point, Point][]): number[] {
  const n = risers.length;
  const m = risers.map(mid);
  let best: number[] = [], bestLen = Infinity;
  for (let s = 0; s < n; s++) {
    const order = [s];
    const used = new Set([s]);
    let total = 0;
    while (order.length < n) {
      const last = m[order[order.length - 1]];
      let k = -1, d = Infinity;
      for (let j = 0; j < n; j++) if (!used.has(j) && dist(last, m[j]) < d) { d = dist(last, m[j]); k = j; }
      order.push(k); used.add(k); total += d;
    }
    if (total < bestLen - 1e-9) { bestLen = total; best = order; }
  }
  const i0 = best.indexOf(0);
  if (i0 > (n - 1) / 2) best.reverse();
  return best;
}

interface Group { lines: [Point, Point][] }

/** Runs and landings of a sketched stair between `baseZ` and `topZ`, or what is missing. */
export function sketchToLayout(sk: StairSketch, baseZ: number, topZ: number): StairLayout | { error: SketchError } {
  if (sk.risers.length < 2) return { error: 'risers' };
  const order = orderRisers(sk.risers);
  const lines = order.map(i => sk.risers[i]);
  const dirOf = (s: [Point, Point]) => unit(sub(s[1], s[0]));
  // Split into groups of consecutive parallel, evenly spaced lines
  const groups: Group[] = [];
  for (const l of lines) {
    const g = groups[groups.length - 1];
    if (g) {
      const prev = g.lines[g.lines.length - 1];
      const parallel = Math.abs(cross(dirOf(prev), dirOf(l))) < PARALLEL_SIN;
      const gap = dist(mid(prev), mid(l));
      const spacing = g.lines.length >= 2 ? dist(mid(g.lines[0]), mid(g.lines[1])) : gap;
      if (parallel && gap < spacing * 1.6 + 1e-9 && gap > spacing / 1.6 - 1e-9) { g.lines.push(l); continue; }
    }
    groups.push({ lines: [l] });
  }
  // Runs (2+ lines; single lines at the ends join as one-riser runs) and the winder lines between them
  interface RunG { lines: [Point, Point][]; windersAfter: number }
  const runs: RunG[] = [];
  let pendingWinders = 0;
  groups.forEach((g, i) => {
    const isEnd = i === 0 || i === groups.length - 1;
    if (g.lines.length >= 2 || isEnd || runs.length === 0) {
      if (runs.length > 0) runs[runs.length - 1].windersAfter = pendingWinders;
      pendingWinders = 0;
      runs.push({ lines: g.lines, windersAfter: 0 });
    } else pendingWinders += g.lines.length;
  });
  if (runs.length === 0) return { error: 'runs' };
  const flights = runs.map((rg, k) => {
    const L = rg.lines;
    const along = L.length >= 2 ? unit(sub(mid(L[L.length - 1]), mid(L[0]))) : null;
    // Walking direction: across the lines, towards the next run (or away from the previous one)
    let u = (() => { const d = dirOf(L[0]); return { x: -d.y, y: d.x }; })();
    const ref = along ?? (k + 1 < runs.length ? unit(sub(mid(runs[k + 1].lines[0]), mid(L[0])))
      : k > 0 ? unit(sub(mid(L[0]), mid(runs[k - 1].lines[runs[k - 1].lines.length - 1]))) : u);
    if (dot(u, ref) < 0) u = { x: -u.x, y: -u.y };
    const n = { x: -u.y, y: u.x };
    const pos = L.map(l => dot(mid(l), u));
    const going = L.length >= 2 ? (pos[pos.length - 1] - pos[0]) / (L.length - 1) : NaN;
    const lat = L.reduce((s, l) => s + dot(mid(l), n), 0) / L.length;
    const width = L.reduce((s, l) => s + dist(l[0], l[1]), 0) / L.length;
    return { u, n, pos, going, lat, width, windersAfter: rg.windersAfter, count: L.length };
  });
  // One-line runs take a neighbour's going
  const known = flights.find(f => Number.isFinite(f.going))?.going;
  if (!(known && known > 1e-6)) return { error: 'runs' };
  for (const f of flights) if (!Number.isFinite(f.going)) f.going = known;
  const at = (f: typeof flights[number], s: number, o = 0): Point => add(add({ x: 0, y: 0 }, f.u, s), f.n, f.lat + o);
  const segs = flights.map((f, k) => {
    // Before winders the last line is the first winder riser: the run ends on it
    const intoWinders = k + 1 < flights.length && f.windersAfter > 0;
    const steps = intoWinders ? f.count - 1 : f.count;
    const s0 = f.pos[0];
    const s1 = intoWinders ? f.pos[f.pos.length - 1] : f.pos[f.pos.length - 1] + f.going;
    return { start: at(f, s0), end: at(f, s1), steps, f, s1, s0 };
  });
  if (segs.some(s => s.steps < 1)) return { error: 'runs' };
  const boundary = sk.boundary.length >= 3 ? (signedArea(sk.boundary) < 0 ? [...sk.boundary].reverse() : [...sk.boundary]) : null;
  const landings: StairLayout['landings'] = [];
  const landingSteps: number[] = [];
  for (let k = 0; k + 1 < segs.length; k++) {
    const a = segs[k], b = segs[k + 1];
    let poly: Point[] = [];
    if (boundary) {
      poly = clip(boundary, a.end, a.f.u);
      poly = clip(poly, b.start, { x: -b.f.u.x, y: -b.f.u.y });
    }
    if (poly.length < 3 || Math.abs(signedArea(poly)) < 1e-6) {
      // No boundary: the corner square of an L, the strip across a U
      const hwA = a.f.width / 2, hwB = b.f.width / 2;
      const pts = [at(a.f, a.s1, hwA), at(a.f, a.s1, -hwA), at(b.f, b.s0, hwB), at(b.f, b.s0, -hwB)];
      const corner = [hwA, -hwA].flatMap(oa => [hwB, -hwB].map(ob => {
        const p = at(a.f, a.s1, oa), q = at(b.f, b.s0, ob);
        const den = cross(a.f.u, b.f.u);
        if (Math.abs(den) < 1e-9) return null;
        const t = cross(sub(q, p), b.f.u) / den;
        return t > 1e-9 ? add(p, a.f.u, t) : null;
      })).filter((p): p is Point => !!p);
      poly = convexHull([...pts, ...corner]);
      if (poly.length < 3 || Math.abs(signedArea(poly)) < 1e-6) {
        const depth = Math.max(a.f.width, b.f.width);
        poly = convexHull([...pts, ...pts.map(p => add(p, a.f.u, depth))]);
      }
    }
    if (poly.length < 3) return { error: 'boundary' };
    if (signedArea(poly) < 0) poly.reverse();
    landings.push({ vertices: poly, top: 0 });
    landingSteps.push(a.f.windersAfter > 0 ? a.f.windersAfter + 1 : 0);
  }
  const total = segs.reduce((s, r) => s + r.steps, 0) + landingSteps.reduce((s, k) => s + k, 0);
  const riser = (topZ - baseZ) / total;
  let z = baseZ;
  const outRuns: StairLayout['runs'] = segs.map((s, k) => {
    const z1 = z + riser * s.steps;
    const r = { start: s.start, end: s.end, startZ: round4(z), endZ: round4(z1), steps: s.steps, width: round4(s.f.width) };
    if (landings[k]) landings[k].top = round4(z1);
    z = z1 + riser * (landingSteps[k] ?? 0);
    return r;
  });
  landings.forEach((l, k) => { if (landingSteps[k] > 0) l.steps = landingSteps[k]; });
  return { runs: outRuns, landings };
}
