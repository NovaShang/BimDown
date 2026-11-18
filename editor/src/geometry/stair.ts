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
import { LANDING_DEFAULT_THICKNESS, STAIR_DEFAULT_STEPS, arcFromEnds, STAIR_LIMITS, STAIR_RUN_DEFAULT_WIDTH, layoutStair, runPlan, stairRepetitions, winderGeometry } from './stairCore.ts';
import type { StairAssembly, StairLanding, StairLayout, StairRepetition, StairRun } from './stairCore.ts';

export * from './stairCore.ts';

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y });
const len = (a: Point) => Math.hypot(a.x, a.y);
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const num = (s: string | undefined, fallback: number): number => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : fallback;
};

/** Host reference of a part / railing (unprefixed or prefixed). */
export function hostRefOf(el: CanonicalElement): string {
  return el.attrs.host_id || el.hostId || '';
}

/** One run from a `stair` / `stair_run` element; null when it has no length. */
export function runOf(el: CanonicalElement): StairRun | null {
  if (el.geometry !== 'line' && el.geometry !== 'spatial_line') return null;
  const ln = el as LineElement;
  const d = sub(ln.end, ln.start);
  const chord = len(d);
  if (chord < 1e-3) return null;
  const arc = ln.arc ? arcFromEnds(ln.start, ln.end, (ln.arc.rx + ln.arc.ry) / 2, ln.arc.largeArc, ln.arc.sweep) ?? undefined : undefined;
  const length = arc ? Math.abs(arc.sweep) * arc.r : chord;
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
    length, u: { x: d.x / chord, y: d.y / chord },
    ...(arc ? { arc } : {}),
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
    ...(num(p.attrs.step_count, 0) > 0 ? { steps: Math.round(num(p.attrs.step_count, 0)) } : {}),
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

/** Riser target of the auto-fix (m): mid-range of the calculator's limits. */
const RISER_TARGET = 0.17;
/** 2R + G target (m), mid-range of 0.60–0.65. */
const BLONDEL_TARGET = 0.63;

/**
 * Riser count and going that pass the stair calculator for a `rise` (m):
 * riser nearest 170 mm inside 150–190 mm, going = 630 mm − 2R (≥ 260 mm),
 * rounded to the millimetre. The stair tool's and panel's "Fix".
 */
export function comfortableStair(rise: number): { risers: number; riser: number; going: number } {
  const L = STAIR_LIMITS;
  let n = Math.max(1, Math.round(rise / RISER_TARGET));
  while (rise / n > L.riserMax + 1e-9) n++;
  while (n > 1 && rise / (n - 1) <= L.riserMax + 1e-9 && rise / n < L.riserMin - 1e-9) n--;
  const riser = rise / n;
  const going = Math.max(L.goingMin, Math.round((BLONDEL_TARGET - 2 * riser) * 1000) / 1000);
  return { risers: n, riser, going };
}

/**
 * Typed going for the stair being drawn: move the last clicked point along
 * the last run so the runs add up to `going × steps` (Revit's "risers
 * remaining" completion). Points are the walking line (2–4 clicks); null when
 * the last run would vanish.
 */
export function pointsForGoing(points: readonly Point[], width: number, steps: number, going: number): Point[] | null {
  if (points.length < 2 || !(going > 0)) return null;
  const layout = layoutStair(points, width, steps, 0, 1);
  if (!layout) return null;
  const total = layout.runs.reduce((acc, r) => acc + dist(r.start, r.end), 0);
  const a = points[points.length - 2], b = points[points.length - 1];
  const l = dist(a, b);
  if (l < 1e-9) return null;
  const last = layout.runs[layout.runs.length - 1];
  const lastLen = dist(last.start, last.end) + going * steps - total;
  if (lastLen < going) return null;
  const k = (l + going * steps - total) / l;
  return [...points.slice(0, -1), { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k }];
}

/**
 * Walking-line clicks of a stair being drawn, fitted so every run is exactly
 * its risers × `going` (Revit: run length locked by the tread depth; the
 * clicks give directions and how the risers split between runs).
 * `points` are the clicks so far plus the cursor; `required` the clicks of
 * the stair type (2 straight, 3 L, 4 U). The first run's end click snaps to a
 * whole number of treads (1 … steps − 1); the last click ends the remaining
 * treads (less `winders` risers turning in the landing). U-stair landing exit (3rd click) keeps the landing square to run 1.
 */
export function fitStairPoints(points: readonly Point[], required: number, width: number, steps: number, going: number, winders = 0): Point[] {
  if (points.length < 2 || !(going > 0)) return [...points];
  const n = Math.max(2, Math.round(steps));
  const hw = width / 2;
  const out = [...points];
  const s = out[0];
  const dir = (a: Point, b: Point): Point | null => {
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    return l < 1e-9 ? null : { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  const at = (p: Point, u: Point, d: number): Point => ({ x: p.x + u.x * d, y: p.y + u.y * d });
  if (required <= 2) {
    const u = dir(s, out[1]);
    if (u) out[1] = at(s, u, n * going);
    return out;
  }
  // First run: s → corner / landing entry, a whole number of treads before the landing
  const u0 = dir(s, out[1]);
  if (!u0) return out;
  // Winder risers in the turn are not on either run
  const w = Math.max(0, Math.min(n - 2, Math.round(winders)));
  const nr = n - w;
  const n1 = Math.min(nr - 1, Math.max(1, Math.round((Math.hypot(out[1].x - s.x, out[1].y - s.y) - hw) / going)));
  out[1] = at(s, u0, n1 * going + hw);
  const n2 = nr - n1;
  if (required === 3) {
    if (out.length >= 3) {
      const u1 = dir(out[1], out[2]);
      if (u1) out[2] = at(out[1], u1, hw + n2 * going);
    }
    return out;
  }
  // U: landing exit across run 1 (at least one run width away), then the second run back
  if (out.length >= 3) {
    const n0 = { x: -u0.y, y: u0.x };
    const side = (out[2].x - out[1].x) * n0.x + (out[2].y - out[1].y) * n0.y;
    const across = (side < 0 ? -1 : 1) * Math.max(width, Math.abs(side));
    out[2] = at(out[1], n0, across);
  }
  if (out.length >= 4) {
    const u1 = dir(out[2], out[3]);
    if (u1) out[3] = at(out[2], u1, hw + n2 * going);
  }
  return out;
}

/** Default tread depth for a riser height (m): 2R + G = 630 mm, at least the minimum going. */
export function defaultGoing(riser: number): number {
  return Math.max(STAIR_LIMITS.goingMin, Math.round((BLONDEL_TARGET - 2 * riser) * 1000) / 1000);
}

/** The stair's repetitions from a geometry context (`levelElevation` = the stair's level). */
export function stairRepetitionsIn(
  stair: CanonicalElement,
  ctx: { level: { id: string }; levelElevation: number; levelElevations: ReadonlyMap<string, number> },
): StairRepetition[] {
  return stairRepetitions(stair.attrs, ctx.level.id, ctx.levelElevation, ctx.levelElevations);
}

/** A run of a placement layout as a StairRun (previews). */
export function runFromLayout(r: StairLayout['runs'][number], width: number, id = ''): StairRun {
  const d = sub(r.end, r.start);
  const chord = len(d) || 1;
  return {
    id, table: 'stair_run', start: r.start, end: r.end, startZ: r.startZ, endZ: r.endZ,
    width: r.width ?? width, stepCount: r.steps,
    length: r.arc ? Math.abs(r.arc.sweep) * r.arc.r : chord, u: { x: d.x / chord, y: d.y / chord },
    ...(r.arc ? { arc: r.arc } : {}),
  };
}

/** Plan preview of a placement layout: run outlines + treads, landings (with winder risers). */
export function layoutPlan(layout: StairLayout, width: number): { runs: { outline: Point[]; treads: [Point, Point][] }[]; landings: { vertices: Point[]; risers: [Point, Point][] }[] } {
  const runs = layout.runs.map((r, i) => runFromLayout(r, width, `r${i}`));
  const asm: StairAssembly = {
    stairId: '', runs, ownIsRun: true,
    landings: layout.landings.map((l, i) => ({ id: `l${i}`, vertices: l.vertices, top: l.top, thickness: LANDING_DEFAULT_THICKNESS, steps: l.steps })),
  };
  return {
    runs: runs.map(r => {
      const p = runPlan(r, Infinity);
      return { outline: p.outline, treads: p.lines.filter(l => !l.edge).map(l => [l.a, l.b] as [Point, Point]) };
    }),
    landings: asm.landings.map(l => ({ vertices: l.vertices, risers: (winderGeometry(asm, l)?.lines ?? []).map(x => [x.a, x.b] as [Point, Point]) })),
  };
}

// ─── Solid flight ────────────────────────────────────────────────────────────
