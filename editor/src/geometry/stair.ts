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
import { LANDING_DEFAULT_THICKNESS, STAIR_DEFAULT_STEPS, STAIR_LIMITS, STAIR_RUN_DEFAULT_WIDTH, layoutStair, stairRepetitions } from './stairCore.ts';
import type { StairAssembly, StairLanding, StairRepetition, StairRun } from './stairCore.ts';

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

/** The stair's repetitions from a geometry context (`levelElevation` = the stair's level). */
export function stairRepetitionsIn(
  stair: CanonicalElement,
  ctx: { level: { id: string }; levelElevation: number; levelElevations: ReadonlyMap<string, number> },
): StairRepetition[] {
  return stairRepetitions(stair.attrs, ctx.level.id, ctx.levelElevation, ctx.levelElevations);
}

// ─── Solid flight ────────────────────────────────────────────────────────────
