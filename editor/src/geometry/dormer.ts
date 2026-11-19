/**
 * Dormer (Revit: a small roof + walls, then Dormer Opening on the host roof),
 * built from normal elements in one step: a polygon `opening` hosted on the
 * main roof where the dormer roof stands above it, a small roof (gable: two
 * sloped sides, gable front and back; shed: one plane rising from the front
 * eave), a front wall and two cheek walls topped by the dormer roof
 * (top_attach_id), all on the main roof's level.
 *
 * Local frame at the clicked point F on a sloped roof plane: b = uphill
 * (the plane's gradient), a = along the contour. The main roof's top surface
 * is z = zF + tanα·b; walls stand on the roof underside at the front.
 * Values are model units (level-relative heights); slopes in degrees.
 */
import type { Point } from '../model/elements.ts';
import { pointInPolygon, verticalThickness, type RoofSolution } from './roofSolver.ts';

export type DormerKind = 'gable' | 'shed';

export interface DormerOptions {
  kind: DormerKind;
  /** Outside width between the cheek wall centre lines. */
  width: number;
  /** Front wall height above the main roof's top surface at the front, to the dormer eave. */
  frontHeight: number;
  /** Dormer roof slope (gable sides / shed plane), degrees. */
  slope: number;
  /** Dormer roof overhang past the walls. */
  overhang: number;
}

export const DORMER_DEFAULTS: DormerOptions = { kind: 'gable', width: 1.6, frontHeight: 1.3, slope: 35, overhang: 0.2 };

export interface DormerRoofHost {
  vertices: Point[];
  /** Roof base_offset (underside at the eaves, level-relative). */
  baseOffset: number;
  thickness: number;
  solution: RoofSolution;
}

export interface DormerWall { start: Point; end: Point; baseOffset: number; top: number; role: 'front' | 'cheek' }

export interface DormerLayout {
  /** Hole in the main roof (plan polygon, counter-clockwise). */
  opening: Point[];
  /** Dormer roof footprint (counter-clockwise, edge 0 = the front). */
  roof: Point[];
  roofType: DormerKind;
  /** Per roof edge slope, degrees (edge i = roof[i] → roof[i + 1]). */
  edgeSlopes: number[];
  /** Dormer roof base_offset (underside at its sloped eaves). */
  roofBase: number;
  walls: DormerWall[];
  /** Uphill unit vector and the front centre, for previews. */
  uphill: Point;
  front: Point;
}

/** Smallest roof pitch (degrees) a dormer can be placed on. */
const MIN_PITCH = 8;

const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * The dormer for a click at `p` on `host`, or a reason it can't be built:
 * 'outside' (not on the roof), 'flat' (plane too shallow), 'shallow'
 * (shed dormer not flatter than the roof), 'tall' (its opening would run
 * past the clicked roof plane: over the ridge, a hip or the roof edge).
 */
export function layoutDormer(host: DormerRoofHost, p: Point, opts: DormerOptions): DormerLayout | 'outside' | 'flat' | 'shallow' | 'tall' {
  const L = layoutOnPlane(host, p, opts);
  if (typeof L === 'string') return L;
  // The opening must stay on the clicked roof plane (not run over a ridge, hip or the roof edge).
  const sol = host.solution;
  const plane = sol.pieces.find(pc => pointInPolygon(p, pc.poly))!.plane;
  const c = L.opening.reduce((acc, q) => ({ x: acc.x + q.x / L.opening.length, y: acc.y + q.y / L.opening.length }), { x: 0, y: 0 });
  for (const q of L.opening) {
    const d = Math.hypot(c.x - q.x, c.y - q.y) || 1;
    const k = Math.min(1, 0.002 / d);
    const t = { x: q.x + (c.x - q.x) * k, y: q.y + (c.y - q.y) * k };
    if (!sol.pieces.some(pc => pc.plane === plane && pointInPolygon(t, pc.poly))) return 'tall';
  }
  return L;
}

function layoutOnPlane(host: DormerRoofHost, p: Point, opts: DormerOptions): DormerLayout | 'outside' | 'flat' | 'shallow' {
  const sol = host.solution;
  if (!pointInPolygon(p, host.vertices)) return 'outside';
  const piece = sol.pieces.find(pc => pointInPolygon(p, pc.poly));
  if (!piece) return 'outside';
  const pl = sol.planes[piece.plane];
  const g = Math.hypot(pl.a, pl.b);
  if (Math.atan(g) * 180 / Math.PI < MIN_PITCH) return 'flat';
  const u = { x: pl.a / g, y: pl.b / g };
  // a to the right of uphill: (a, b) is a counter-clockwise frame in plan
  const v = { x: u.y, y: -u.x };
  const at = (a: number, b: number): Point => ({ x: round(p.x + v.x * a + u.x * b), y: round(p.y + v.y * a + u.y * b) });
  const vThick = verticalThickness(host.thickness, sol.maxSlopeDeg);
  const zUnder = host.baseOffset + (pl.a * p.x + pl.b * p.y + pl.c);
  const zTop = zUnder + vThick;
  const eave = zTop + opts.frontHeight;
  const hw = opts.width / 2, o = Math.max(0, opts.overhang);
  const tb = Math.tan(opts.slope * Math.PI / 180);
  if (opts.kind === 'gable') {
    // Underside z(a) = eave + (hw − |a|)·tanβ meets the main roof top at b(a) = (z(a) − zTop) / tanα.
    const bEave = (eave - zTop) / g;
    const ridge = eave + hw * tb;
    const bRidge = (ridge - zTop) / g;
    const roofBase = eave - o * tb;
    return {
      opening: [at(-hw, 0), at(hw, 0), at(hw, bEave), at(0, bRidge), at(-hw, bEave)],
      roof: [at(-hw - o, -o), at(hw + o, -o), at(hw + o, bRidge), at(-hw - o, bRidge)],
      roofType: 'gable',
      edgeSlopes: [0, opts.slope, 0, opts.slope],
      roofBase: round(roofBase),
      walls: [
        { start: at(-hw, 0), end: at(hw, 0), baseOffset: round(zUnder), top: round(ridge + 0.5), role: 'front' },
        { start: at(hw, 0), end: at(hw, bEave), baseOffset: round(zUnder), top: round(eave), role: 'cheek' },
        { start: at(-hw, bEave), end: at(-hw, 0), baseOffset: round(zUnder), top: round(eave), role: 'cheek' },
      ],
      uphill: u, front: p,
    };
  }
  // Shed: underside z(b) = eave + tanγ·b, flatter than the roof, meets it at b* = (eave − zTop) / (tanα − tanγ).
  if (tb >= g - 1e-6) return 'shallow';
  const bBack = (eave - zTop) / (g - tb);
  const roofBase = eave - o * tb;
  const backTop = eave + bBack * tb;
  return {
    opening: [at(-hw, 0), at(hw, 0), at(hw, bBack), at(-hw, bBack)],
    roof: [at(-hw - o, -o), at(hw + o, -o), at(hw + o, bBack), at(-hw - o, bBack)],
    roofType: 'shed',
    edgeSlopes: [opts.slope, 0, 0, 0],
    roofBase: round(roofBase),
    walls: [
      { start: at(-hw, 0), end: at(hw, 0), baseOffset: round(zUnder), top: round(eave + 0.5), role: 'front' },
      { start: at(hw, 0), end: at(hw, bBack), baseOffset: round(zUnder), top: round(backTop + 0.5), role: 'cheek' },
      { start: at(-hw, bBack), end: at(-hw, 0), baseOffset: round(zUnder), top: round(backTop + 0.5), role: 'cheek' },
    ],
    uphill: u, front: p,
  };
}
