/**
 * Copy of editor/src/geometry/roofSolver.ts (the editor's
 * footprint roof solver), so `render` draws the same ridges, hips, valleys
 * and slope arrows the editor does. Keep the two in sync.
 */
/**
 * Footprint roof solver (Revit "roof by footprint").
 *
 * Every footprint edge either defines a slope (an eave: a plane rising inward
 * from the edge at its slope angle) or not (a gable / rake edge: the roof is
 * cut vertically there). The roof's underside is the lowest of the planes that
 * can reach a point, where an edge's plane reaches the wedge between the
 * bisectors at its two corners (and its own inner side). For convex footprints
 * that is exactly the lower envelope of all planes; the wedge restriction is
 * what keeps an L / T / U roof correct at its re-entrant corners (valleys)
 * instead of one wing's plane cutting through the other wing. No bounding-box
 * assumption anywhere.
 *
 * Also handled here: a mansard deck (a cap on the rise), extrusion roofs (a
 * profile across the first edge, extruded along it) and convex-decomposed
 * openings, so the roof mesh needs no CSG.
 *
 * Pure geometry, no three.js: the CLI renderer carries a copy of this file.
 */

export type P2 = { x: number; y: number };

/** rise(p) = a·x + b·y + c, metres above the eave (roof base). */
export interface Plane { a: number; b: number; c: number }

/** Half-plane a·x + b·y + c ≥ 0. */
interface HalfPlane { a: number; b: number; c: number }

/** Extrusion roof: underside rise `z` at distance `u` across the first edge. */
export interface ExtrusionProfile {
  /** Point on the first edge line (u = 0). */
  origin: P2;
  /** Unit vector across the first edge, pointing into the footprint. */
  across: P2;
  pts: { u: number; z: number }[];
}

export interface RoofInput {
  outline: P2[];
  /** Slope in degrees per edge outline[i] → outline[i+1]; ≤ 0 = not slope-defining. */
  edgeSlopes: number[];
  /** Maximum rise (mansard upper deck). */
  cap?: number;
  /** Extrusion roof: replaces the edge planes. */
  profile?: ExtrusionProfile;
}

export interface RoofPiece {
  /** Convex, counter-clockwise. */
  poly: P2[];
  /** Index into `planes`. */
  plane: number;
}

export type RoofLineKind = 'ridge' | 'hip' | 'valley';
export interface RoofLine { a: P2; b: P2; kind: RoofLineKind }

export interface RoofSolution {
  planes: Plane[];
  /** Footprint edge index per plane (−1: cap, flat or profile plane). */
  planeEdge: number[];
  pieces: RoofPiece[];
  /** Underside rise above the eave at a plan point (0 outside every plane). */
  rise(p: P2): number;
  /** Fold lines between roof planes. */
  lines: RoofLine[];
  maxRise: number;
  /** Largest slope (degrees) of any plane; 0 for a flat roof. */
  maxSlopeDeg: number;
}

const EPS = 1e-9;
const AREA_EPS = 1e-7;

// ─── Polygon helpers ─────────────────────────────────────────────────────────

export function signedArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Drop consecutive duplicates (and a closing repeat of the first vertex). */
export function cleanRing(poly: P2[], eps = 1e-6): P2[] {
  const out: P2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > eps) out.push({ x: p.x, y: p.y });
  }
  while (out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps) out.pop();
  return out;
}

const evalHp = (h: HalfPlane, p: P2) => h.a * p.x + h.b * p.y + h.c;
export const riseOf = (pl: Plane, p: P2) => pl.a * p.x + pl.b * p.y + pl.c;

/** Keep the part of a convex polygon where f ≥ 0 (Sutherland–Hodgman, one plane). */
export function clipHalf(poly: P2[], h: HalfPlane): P2[] {
  const out: P2[] = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const fa = evalHp(h, a), fb = evalHp(h, b);
    if (fa >= -EPS) out.push(a);
    if ((fa > EPS && fb < -EPS) || (fa < -EPS && fb > EPS)) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return cleanRing(out, 1e-9);
}

function isPiece(poly: P2[]): boolean {
  return poly.length >= 3 && Math.abs(signedArea(poly)) > AREA_EPS;
}

/** Ear-clipping triangulation of a simple polygon (any orientation). */
export function triangulate(poly: P2[]): P2[][] {
  const pts = cleanRing(poly);
  if (pts.length < 3) return [];
  const ccw = signedArea(pts) >= 0 ? pts : pts.slice().reverse();
  const idx = ccw.map((_, i) => i);
  const tris: P2[][] = [];
  const cross = (o: P2, a: P2, b: P2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const inTri = (p: P2, a: P2, b: P2, c: P2) =>
    cross(a, b, p) >= -EPS && cross(b, c, p) >= -EPS && cross(c, a, p) >= -EPS;
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const i0 = idx[(k + idx.length - 1) % idx.length], i1 = idx[k], i2 = idx[(k + 1) % idx.length];
      const a = ccw[i0], b = ccw[i1], c = ccw[i2];
      const cr = cross(a, b, c);
      if (cr <= EPS) {
        // Collinear: drop the middle vertex.
        if (Math.abs(cr) <= EPS) { idx.splice(k, 1); clipped = true; break; }
        continue;
      }
      let ear = true;
      for (const j of idx) {
        if (j === i0 || j === i1 || j === i2) continue;
        const p = ccw[j];
        if ((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y) || (p.x === c.x && p.y === c.y)) continue;
        if (inTri(p, a, b, c)) { ear = false; break; }
      }
      if (!ear) continue;
      tris.push([a, b, c]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // degenerate input: give up on the rest
  }
  if (idx.length === 3) {
    const t = idx.map(i => ccw[i]);
    if (Math.abs(signedArea(t)) > AREA_EPS) tris.push(signedArea(t) > 0 ? t : t.reverse());
  }
  return tris;
}

/** Convex polygon minus convex polygon: up to n convex pieces. */
function subtractConvex(piece: P2[], hole: P2[]): P2[][] {
  const h = signedArea(hole) >= 0 ? hole : hole.slice().reverse();
  const out: P2[][] = [];
  let rest = piece;
  for (let i = 0; i < h.length && rest.length >= 3; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    // Inside of a CCW edge is its left: (b−a) × (p−a) ≥ 0.
    const inside: HalfPlane = { a: -(b.y - a.y), b: b.x - a.x, c: (b.y - a.y) * a.x - (b.x - a.x) * a.y };
    const outside: HalfPlane = { a: -inside.a, b: -inside.b, c: -inside.c };
    const part = clipHalf(rest, outside);
    if (isPiece(part)) out.push(part);
    rest = clipHalf(rest, inside);
  }
  return out;
}

/** Pieces minus a set of (any-shape) holes. */
export function subtractHoles<T extends { poly: P2[] }>(pieces: T[], holes: P2[][]): T[] {
  let cur = pieces;
  for (const hole of holes) {
    for (const tri of triangulate(hole)) {
      const next: T[] = [];
      for (const pc of cur) {
        if (!bboxOverlap(pc.poly, tri)) { next.push(pc); continue; }
        for (const poly of subtractConvex(pc.poly, tri)) next.push({ ...pc, poly });
      }
      cur = next;
    }
  }
  return cur;
}

function bboxOverlap(a: P2[], b: P2[]): boolean {
  const ba = bounds(a), bb = bounds(b);
  return ba.minX <= bb.maxX + EPS && bb.minX <= ba.maxX + EPS && ba.minY <= bb.maxY + EPS && bb.minY <= ba.maxY + EPS;
}

function bounds(poly: P2[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Convex polygon ∩ convex polygon (CCW clip). */
export function intersectConvex(subject: P2[], clip: P2[]): P2[] {
  const c = signedArea(clip) >= 0 ? clip : clip.slice().reverse();
  let out = subject;
  for (let i = 0; i < c.length && out.length >= 3; i++) {
    const a = c[i], b = c[(i + 1) % c.length];
    out = clipHalf(out, { a: -(b.y - a.y), b: b.x - a.x, c: (b.y - a.y) * a.x - (b.x - a.x) * a.y });
  }
  return out;
}

export function pointInPolygon(p: P2, poly: P2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

export function centroid(poly: P2[]): P2 {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const c = p.x * q.y - q.x * p.y;
    a += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) < 1e-12) {
    const n = poly.length || 1;
    return { x: poly.reduce((s, v) => s + v.x, 0) / n, y: poly.reduce((s, v) => s + v.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

// ─── Solver ─────────────────────────────────────────────────────────────────

interface EdgeFrame { a: P2; b: P2; n: P2; tan: number; mid: P2 }

/** Signed distance from edge e's line (positive on the footprint side), as a linear function. */
const distFn = (e: EdgeFrame): HalfPlane => ({ a: e.n.x, b: e.n.y, c: -(e.a.x * e.n.x + e.a.y * e.n.y) });
const scale = (h: HalfPlane, k: number): HalfPlane => ({ a: h.a * k, b: h.b * k, c: h.c * k });
const minus = (p: HalfPlane, q: HalfPlane): HalfPlane => ({ a: p.a - q.a, b: p.b - q.b, c: p.c - q.c });

export function solveRoof(input: RoofInput): RoofSolution {
  const outline = cleanRing(input.outline);
  const n = outline.length;
  const orient = signedArea(outline) >= 0 ? 1 : -1;
  const planes: Plane[] = [];
  const planeEdge: number[] = [];
  const empty: RoofSolution = {
    planes: [{ a: 0, b: 0, c: 0 }], planeEdge: [-1], pieces: [], rise: () => 0, lines: [], maxRise: 0, maxSlopeDeg: 0,
  };
  if (n < 3) return empty;

  const edges: EdgeFrame[] = outline.map((a, i) => {
    const b = outline[(i + 1) % n];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const slope = input.edgeSlopes[i] ?? 0;
    return {
      a, b, n: { x: -uy * orient, y: ux * orient },
      tan: slope > 0 ? Math.tan((Math.min(slope, 89) * Math.PI) / 180) : 0,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  });

  const tris = triangulate(outline);
  const zeroPlane = (): number => {
    planes.push({ a: 0, b: 0, c: 0 });
    planeEdge.push(-1);
    return planes.length - 1;
  };

  // ── Extrusion roof: one plane per profile segment, banded across the first edge.
  if (input.profile && input.profile.pts.length >= 2) {
    const { origin, across } = input.profile;
    const pts = [...input.profile.pts].sort((p, q) => p.u - q.u);
    const uFn: HalfPlane = { a: across.x, b: across.y, c: -(origin.x * across.x + origin.y * across.y) };
    const bands: { lo: number; hi: number; plane: number }[] = [];
    const addPlane = (k: number, z0: number) => {
      // rise = z0 + k·(u)  with u = uFn(p)
      planes.push({ a: k * uFn.a, b: k * uFn.b, c: z0 + k * uFn.c });
      planeEdge.push(-1);
      return planes.length - 1;
    };
    bands.push({ lo: -Infinity, hi: pts[0].u, plane: addPlane(0, pts[0].z) });
    for (let i = 0; i + 1 < pts.length; i++) {
      const du = pts[i + 1].u - pts[i].u;
      if (du < 1e-9) continue;
      const k = (pts[i + 1].z - pts[i].z) / du;
      bands.push({ lo: pts[i].u, hi: pts[i + 1].u, plane: addPlane(k, pts[i].z - k * pts[i].u) });
    }
    bands.push({ lo: pts[pts.length - 1].u, hi: Infinity, plane: addPlane(0, pts[pts.length - 1].z) });
    const pieces: RoofPiece[] = [];
    for (const tri of tris) {
      for (const band of bands) {
        let poly = tri;
        if (band.lo > -Infinity) poly = clipHalf(poly, { ...uFn, c: uFn.c - band.lo });
        if (band.hi < Infinity) poly = clipHalf(poly, scale({ ...uFn, c: uFn.c - band.hi }, -1));
        if (isPiece(poly)) pieces.push({ poly, plane: band.plane });
      }
    }
    const rise = (p: P2) => {
      const u = evalHp(uFn, p);
      for (const band of bands) if (u >= band.lo - 1e-9 && u <= band.hi + 1e-9) return riseOf(planes[band.plane], p);
      return 0;
    };
    return finish(planes, planeEdge, pieces, rise, outline);
  }

  // ── Footprint roof: one plane per slope-defining edge, limited to its wedge.
  const sloped = edges.map(e => e.tan > 0);
  if (!sloped.some(Boolean)) {
    const z = zeroPlane();
    return finish(planes, planeEdge, tris.map(poly => ({ poly, plane: z })), () => 0, outline);
  }

  const wedges: { plane: number; hps: HalfPlane[] }[] = [];
  edges.forEach((e, i) => {
    if (!sloped[i]) return;
    const d = distFn(e);
    const pl = { a: d.a * e.tan, b: d.b * e.tan, c: d.c * e.tan };
    // Collinear eaves with one slope share a plane (T / U footprints).
    let pi = planes.findIndex((q, k) => planeEdge[k] >= 0
      && Math.abs(q.a - pl.a) < 1e-9 && Math.abs(q.b - pl.b) < 1e-9 && Math.abs(q.c - pl.c) < 1e-7);
    if (pi < 0) {
      planes.push(pl);
      planeEdge.push(i);
      pi = planes.length - 1;
    }
    const hps: HalfPlane[] = [d];
    for (const j of [(i + n - 1) % n, (i + 1) % n]) {
      const o = edges[j];
      // Boundary through the shared corner: where this plane meets the
      // neighbour's plane, or the neighbour's own line when it is a gable.
      const g = sloped[j] ? minus(scale(d, e.tan), scale(distFn(o), o.tan)) : distFn(o);
      const s = evalHp(g, e.mid);
      if (Math.abs(s) < 1e-9) continue; // collinear neighbour
      hps.push(scale(g, s > 0 ? 1 : -1));
    }
    wedges.push({ plane: pi, hps });
  });
  let capPlane = -1;
  if (input.cap !== undefined && input.cap > 0) {
    planes.push({ a: 0, b: 0, c: input.cap });
    planeEdge.push(-1);
    capPlane = planes.length - 1;
  }
  let zero = -1;

  const inWedge = (w: { hps: HalfPlane[] }, p: P2, tol = 1e-7) => w.hps.every(h => evalHp(h, p) >= -tol);
  const activeAt = (p: P2, tol?: number) => {
    const act: number[] = [];
    for (const w of wedges) if (!act.includes(w.plane) && inWedge(w, p, tol)) act.push(w.plane);
    if (capPlane >= 0) act.push(capPlane);
    return act;
  };
  const rise = (p: P2) => {
    let z = Infinity;
    for (const pl of activeAt(p, 1e-6)) z = Math.min(z, riseOf(planes[pl], p));
    return z === Infinity ? 0 : Math.max(0, z);
  };

  // Cells: footprint triangles split along every wedge boundary, so each cell
  // sees one fixed set of reachable planes; the lower envelope inside a cell
  // is then a plain convex clip per plane.
  const lines = uniqueLines(wedges.flatMap(w => w.hps));
  const pieces: RoofPiece[] = [];
  for (const tri of tris) {
    let cells: P2[][] = [tri];
    for (const ln of lines) {
      const next: P2[][] = [];
      for (const cell of cells) {
        let pos = false, neg = false;
        for (const p of cell) {
          const v = evalHp(ln, p);
          if (v > 1e-9) pos = true; else if (v < -1e-9) neg = true;
        }
        if (!(pos && neg)) { next.push(cell); continue; }
        const a = clipHalf(cell, ln), b = clipHalf(cell, scale(ln, -1));
        if (isPiece(a)) next.push(a);
        if (isPiece(b)) next.push(b);
      }
      cells = next;
    }
    for (const cell of cells) {
      const act = activeAt(centroid(cell));
      if (act.length === 0) {
        if (zero < 0) zero = zeroPlane();
        pieces.push({ poly: cell, plane: zero });
        continue;
      }
      for (const i of act) {
        let poly = cell;
        for (const j of act) {
          if (j === i || poly.length < 3) continue;
          // keep plane_i ≤ plane_j
          const pi = planes[i], pj = planes[j];
          poly = clipHalf(poly, { a: pj.a - pi.a, b: pj.b - pi.b, c: pj.c - pi.c });
        }
        if (isPiece(poly)) pieces.push({ poly, plane: i });
      }
    }
  }
  return finish(planes, planeEdge, pieces, rise, outline);
}

function uniqueLines(hps: HalfPlane[]): HalfPlane[] {
  const out: HalfPlane[] = [];
  for (const h of hps) {
    const len = Math.hypot(h.a, h.b);
    if (len < 1e-12) continue;
    const k = { a: h.a / len, b: h.b / len, c: h.c / len };
    if (out.some(o => (Math.abs(o.a - k.a) < 1e-7 && Math.abs(o.b - k.b) < 1e-7 && Math.abs(o.c - k.c) < 1e-6)
      || (Math.abs(o.a + k.a) < 1e-7 && Math.abs(o.b + k.b) < 1e-7 && Math.abs(o.c + k.c) < 1e-6))) continue;
    out.push(k);
  }
  return out;
}

function finish(planes: Plane[], planeEdge: number[], pieces: RoofPiece[], rise: (p: P2) => number, outline: P2[]): RoofSolution {
  const ccwPieces = pieces.map(pc => ({ ...pc, poly: signedArea(pc.poly) >= 0 ? pc.poly : pc.poly.slice().reverse() }));
  let maxRise = 0;
  for (const pc of ccwPieces) for (const p of pc.poly) maxRise = Math.max(maxRise, riseOf(planes[pc.plane], p));
  let maxSlopeDeg = 0;
  const used = new Set(ccwPieces.map(p => p.plane));
  for (const i of used) {
    const g = Math.hypot(planes[i].a, planes[i].b);
    maxSlopeDeg = Math.max(maxSlopeDeg, (Math.atan(g) * 180) / Math.PI);
  }
  return {
    planes, planeEdge, pieces: ccwPieces, rise,
    lines: foldLines(planes, ccwPieces, rise, outline),
    maxRise, maxSlopeDeg,
  };
}

/** Boundaries between pieces of different planes, merged per plane pair and classified. */
function foldLines(planes: Plane[], pieces: RoofPiece[], rise: (p: P2) => number, outline: P2[]): RoofLine[] {
  const DELTA = 1e-3;
  const planeAt = (p: P2): number => {
    for (const pc of pieces) {
      let inside = true;
      const poly = pc.poly;
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        if ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) < -1e-9) { inside = false; break; }
      }
      if (inside) return pc.plane;
    }
    return -1;
  };
  const samePlane = (i: number, j: number) => {
    const p = planes[i], q = planes[j];
    return Math.abs(p.a - q.a) < 1e-9 && Math.abs(p.b - q.b) < 1e-9 && Math.abs(p.c - q.c) < 1e-7;
  };
  const groups = new Map<string, { dir: P2; origin: P2; spans: [number, number][] }>();
  for (const pc of pieces) {
    const poly = pc.poly;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-6) continue;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      // Outward (right) normal of a CCW edge.
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const probe = { x: m.x + uy * DELTA, y: m.y - ux * DELTA };
      if (!pointInPolygon(probe, outline)) continue;
      const other = planeAt(probe);
      if (other < 0 || other === pc.plane || samePlane(other, pc.plane)) continue;
      const key = pc.plane < other ? `${pc.plane}|${other}` : `${other}|${pc.plane}`;
      let g = groups.get(key);
      if (!g) groups.set(key, g = { dir: { x: ux, y: uy }, origin: a, spans: [] });
      const t = (p: P2) => (p.x - g!.origin.x) * g!.dir.x + (p.y - g!.origin.y) * g!.dir.y;
      const ta = t(a), tb = t(b);
      g.spans.push([Math.min(ta, tb), Math.max(ta, tb)]);
    }
  }
  const out: RoofLine[] = [];
  for (const g of groups.values()) {
    g.spans.sort((p, q) => p[0] - q[0]);
    const merged: [number, number][] = [];
    for (const s of g.spans) {
      const last = merged[merged.length - 1];
      if (last && s[0] <= last[1] + 1e-5) last[1] = Math.max(last[1], s[1]);
      else merged.push([s[0], s[1]]);
    }
    for (const [t0, t1] of merged) {
      if (t1 - t0 < 1e-4) continue;
      const a = { x: g.origin.x + g.dir.x * t0, y: g.origin.y + g.dir.y * t0 };
      const b = { x: g.origin.x + g.dir.x * t1, y: g.origin.y + g.dir.y * t1 };
      const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const nx = -g.dir.y, ny = g.dir.x;
      const h = rise(m);
      const h1 = rise({ x: m.x + nx * DELTA * 5, y: m.y + ny * DELTA * 5 });
      const h2 = rise({ x: m.x - nx * DELTA * 5, y: m.y - ny * DELTA * 5 });
      const convex = h - (h1 + h2) / 2 > 0;
      const level = Math.abs(rise(a) - rise(b)) < 1e-6;
      out.push({ a, b, kind: !convex ? 'valley' : level ? 'ridge' : 'hip' });
    }
  }
  return out;
}

// ─── Mesh ───────────────────────────────────────────────────────────────────

export type V3 = [number, number, number];

/**
 * Closed roof solid (plan x, y, elevation z): underside at baseZ + rise,
 * top `vThick` above it, plumb-cut edges along the footprint and the holes.
 * Triangles are wound counter-clockwise seen from outside.
 */
export function roofSolidTriangles(sol: RoofSolution, outline: P2[], baseZ: number, vThick: number, holes: P2[][] = []): V3[][] {
  const pieces = holes.length > 0 ? subtractHoles(sol.pieces, holes) : sol.pieces;
  const under = (pc: RoofPiece, p: P2) => baseZ + Math.max(0, riseOf(sol.planes[pc.plane], p));
  const tris: V3[][] = [];
  for (const pc of pieces) {
    const poly = pc.poly;
    for (let i = 1; i + 1 < poly.length; i++) {
      const a = poly[0], b = poly[i], c = poly[i + 1];
      tris.push([[a.x, a.y, under(pc, a) + vThick], [b.x, b.y, under(pc, b) + vThick], [c.x, c.y, under(pc, c) + vThick]]);
      tris.push([[a.x, a.y, under(pc, a)], [c.x, c.y, under(pc, c)], [b.x, b.y, under(pc, b)]]);
    }
  }
  const z = (p: P2) => baseZ + sol.rise(p);
  const ring = (r: P2[], outward: boolean) => sideWalls(r, pieces, z, vThick, outward, tris);
  ring(cleanRing(outline), true);
  for (const h of holes) ring(cleanRing(h), false);
  return tris;
}

/** Vertical faces along a ring, split where the roof surface folds. */
function sideWalls(ring: P2[], pieces: RoofPiece[], z: (p: P2) => number, vThick: number, outward: boolean, tris: V3[][]): void {
  if (ring.length < 3) return;
  // Walk counter-clockwise for the outline (faces out) and clockwise for holes.
  const ccw = signedArea(ring) >= 0;
  const r = ccw === outward ? ring : ring.slice().reverse();
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 1e-9) continue;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const ts = [0, 1];
    for (const pc of pieces) {
      for (const p of pc.poly) {
        const t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / len;
        if (t <= 1e-6 || t >= 1 - 1e-6) continue;
        const off = Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux);
        if (off < 1e-5) ts.push(t);
      }
    }
    ts.sort((p, q) => p - q);
    for (let k = 0; k + 1 < ts.length; k++) {
      if (ts[k + 1] - ts[k] < 1e-7) continue;
      const p = { x: a.x + (b.x - a.x) * ts[k], y: a.y + (b.y - a.y) * ts[k] };
      const q = { x: a.x + (b.x - a.x) * ts[k + 1], y: a.y + (b.y - a.y) * ts[k + 1] };
      const zp = z(p), zq = z(q);
      tris.push([[p.x, p.y, zp], [q.x, q.y, zq], [q.x, q.y, zq + vThick]]);
      tris.push([[p.x, p.y, zp], [q.x, q.y, zq + vThick], [p.x, p.y, zp + vThick]]);
    }
  }
}

// ─── Roof parameters from element attrs ─────────────────────────────────────

/** Parse a semicolon-separated number list ("30;0;30;0"). Blank entries → NaN. */
export function parseNumberList(s: string | undefined): number[] {
  if (!s || !s.trim()) return [];
  return s.split(';').map(v => (v.trim() === '' ? NaN : Number(v)));
}

export function formatNumberList(vs: number[]): string {
  return vs.map(v => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0')).join(';');
}

/**
 * Per-edge slopes a legacy roof (roof_type + one slope, no edge_slopes) implies:
 * hip → every edge, gable → every edge but the wing ends, shed → one eave.
 */
export function legacyEdgeSlopes(outline: P2[], roofType: string, slopeDeg: number): number[] {
  const n = outline.length;
  if (roofType === 'flat' || !(slopeDeg > 0) || n < 3) return new Array(n).fill(0);
  if (roofType === 'hip' || roofType === 'mansard') return new Array(n).fill(slopeDeg);
  const len = (i: number) => {
    const a = outline[i], b = outline[(i + 1) % n];
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  const { minX, minY, maxX, maxY } = bounds(outline);
  const alongX = maxX - minX >= maxY - minY;
  const dirOf = (i: number) => {
    const a = outline[i], b = outline[(i + 1) % n];
    const l = len(i) || 1;
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l };
  };
  if (roofType === 'shed') {
    // Low eave on the min side across the long axis (the old bbox planes).
    let best = -1, bestKey = Infinity;
    for (let i = 0; i < n; i++) {
      const d = dirOf(i);
      if (Math.abs(alongX ? d.x : d.y) < 0.99) continue;
      const a = outline[i], b = outline[(i + 1) % n];
      const key = alongX ? (a.y + b.y) / 2 : (a.x + b.x) / 2;
      if (key < bestKey - 1e-9) { bestKey = key; best = i; }
    }
    if (best < 0) for (let i = 0; i < n; i++) if (best < 0 || len(i) > len(best)) best = i;
    return outline.map((_, i) => (i === best ? slopeDeg : 0));
  }
  // gable: wing ends are short edges between two convex corners.
  const orient = signedArea(outline) >= 0 ? 1 : -1;
  const convex = (v: number) => {
    const p = outline[(v + n - 1) % n], c = outline[v], q = outline[(v + 1) % n];
    return ((c.x - p.x) * (q.y - c.y) - (c.y - p.y) * (q.x - c.x)) * orient > 1e-9;
  };
  const ends = outline.map((_, i) => convex(i) && convex((i + 1) % n)
    && len(i) < len((i + n - 1) % n) - 1e-6 && len(i) < len((i + 1) % n) - 1e-6);
  if (!ends.some(Boolean)) {
    // No wing ends (e.g. a square): gable ends across the long axis.
    for (let i = 0; i < n; i++) {
      const d = dirOf(i);
      if (Math.abs(alongX ? d.y : d.x) > 0.99) ends[i] = true;
    }
  }
  return outline.map((_, i) => (ends[i] ? 0 : slopeDeg));
}

/** Rise cap of a legacy mansard: the deck sits 30 % of the half-span in from the eaves. */
export function mansardCap(outline: P2[], steepDeg: number): number {
  const { minX, minY, maxX, maxY } = bounds(outline);
  const halfSpan = Math.min(maxX - minX, maxY - minY) / 2;
  return halfSpan * 0.3 * Math.tan((steepDeg * Math.PI) / 180);
}

/** Mansard lower slope: the roof's slope + 20°, at most 70°. */
export const mansardSlope = (slopeDeg: number) => Math.min(slopeDeg + 20, 70);

export interface RoofAttrs {
  roof_type?: string;
  slope?: string;
  edge_slopes?: string;
  profile?: string;
}

/** Solver input for a roof element (edge_slopes > legacy roof_type + slope). */
export function roofInputFor(outline: P2[], attrs: RoofAttrs): RoofInput {
  const ring = cleanRing(outline);
  const roofType = attrs.roof_type || 'flat';
  const slope = parseFloat(attrs.slope || '0') || 0;
  if (roofType === 'extrusion') {
    const profile = parseProfile(attrs.profile);
    if (ring.length >= 3 && profile.length >= 2) {
      const a = ring[0], b = ring[1];
      const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const orient = signedArea(ring) >= 0 ? 1 : -1;
      return {
        outline: ring, edgeSlopes: [],
        profile: { origin: a, across: { x: (-(b.y - a.y) / len) * orient, y: ((b.x - a.x) / len) * orient }, pts: profile },
      };
    }
    return { outline: ring, edgeSlopes: new Array(ring.length).fill(0) };
  }
  const explicit = parseNumberList(attrs.edge_slopes);
  if (explicit.length === ring.length && explicit.some(v => v > 0)) {
    const edgeSlopes = explicit.map(v => (Number.isFinite(v) && v > 0 ? v : 0));
    // A mansard keeps its upper deck over explicit (steep) edge slopes.
    const cap = roofType === 'mansard' ? mansardCap(ring, Math.max(...edgeSlopes)) : undefined;
    return { outline: ring, edgeSlopes, cap };
  }
  if (roofType === 'mansard' && slope > 0) {
    const steep = mansardSlope(slope);
    return { outline: ring, edgeSlopes: new Array(ring.length).fill(steep), cap: mansardCap(ring, steep) };
  }
  return { outline: ring, edgeSlopes: legacyEdgeSlopes(ring, roofType, slope) };
}

/** "u,z;u,z;…" → profile points (blank / malformed pairs dropped). */
export function parseProfile(s: string | undefined): { u: number; z: number }[] {
  if (!s) return [];
  const out: { u: number; z: number }[] = [];
  for (const pair of s.split(';')) {
    const [u, z] = pair.split(',').map(v => Number(v.trim()));
    if (Number.isFinite(u) && Number.isFinite(z)) out.push({ u, z });
  }
  return out;
}

/** Vertical thickness of a sloped roof slab whose perpendicular thickness is `t`. */
export function verticalThickness(t: number, slopeDeg: number): number {
  const c = Math.cos((Math.min(slopeDeg, 80) * Math.PI) / 180);
  return c > 1e-6 ? t / c : t;
}
