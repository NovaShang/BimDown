/**
 * Wall miter-join computations.
 *
 * At shared endpoints, adjusts each wall's polygon corners and outline
 * endpoints so they meet at the miter intersection — producing continuous
 * outlines identical to SVG stroke-linejoin="miter", but computed
 * per-junction to support different wall thicknesses.
 */

export interface WallSegment {
  id: string;
  x1: number; y1: number;
  x2: number; y2: number;
  halfWidth: number;
  fill: string;
}

interface Pt { x: number; y: number }

/**
 * Per-endpoint corner adjustment for a wall.
 * "left"/"right" are relative to the away-from-junction direction:
 *   left  = CCW (+normal_away) side
 *   right = CW  (−normal_away) side
 */
export interface CornerAdjustment {
  left: Pt;
  right: Pt;
}


const EPS = 0.002;
const MITER_LIMIT = 4;

function quantize(v: number) { return Math.round(v / EPS) * EPS; }
function ptKey(x: number, y: number) { return `${quantize(x).toFixed(4)},${quantize(y).toFixed(4)}`; }

interface JunctionWall {
  seg: WallSegment;
  which: 'start' | 'end';
  dx: number; dy: number;
  angle: number;
  halfWidth: number;
}

type JunctionMap = Map<string, { x: number; y: number; walls: JunctionWall[] }>;

function addEndpoint(
  map: JunctionMap,
  ex: number, ey: number, seg: WallSegment, which: 'start' | 'end',
  awayDx: number, awayDy: number,
) {
  const len = Math.sqrt(awayDx * awayDx + awayDy * awayDy);
  if (len < 0.001) return;
  const dx = awayDx / len, dy = awayDy / len;
  const k = ptKey(ex, ey);
  let entry = map.get(k);
  if (!entry) { entry = { x: ex, y: ey, walls: [] }; map.set(k, entry); }
  entry.walls.push({ seg, which, dx, dy, angle: Math.atan2(dy, dx), halfWidth: seg.halfWidth });
}

/** Distance from point P to line segment AB, and the projection parameter t (0..1). */
function pointToSegDist(P: Pt, A: Pt, B: Pt): { dist: number; t: number } {
  const abx = B.x - A.x, aby = B.y - A.y;
  const len2 = abx * abx + aby * aby;
  if (len2 < 1e-10) return { dist: Infinity, t: 0 };
  let t = ((P.x - A.x) * abx + (P.y - A.y) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  const px = A.x + t * abx - P.x, py = A.y + t * aby - P.y;
  return { dist: Math.sqrt(px * px + py * py), t };
}

export interface TJunction {
  /** The wall whose endpoint hits the middle of another wall */
  tWallId: string;
  tWhich: 'start' | 'end';
  /** The main wall being hit */
  mainWallId: string;
  /** The two points where the T-wall sides meet the main wall outline */
  left: Pt;
  right: Pt;
}

function buildJunctions(walls: WallSegment[]): JunctionMap {
  const map: JunctionMap = new Map();
  for (const seg of walls) {
    addEndpoint(map, seg.x1, seg.y1, seg, 'start', seg.x2 - seg.x1, seg.y2 - seg.y1);
    addEndpoint(map, seg.x2, seg.y2, seg, 'end', seg.x1 - seg.x2, seg.y1 - seg.y2);
  }
  return map;
}

/**
 * Detect T-junctions: a wall endpoint landing on another wall's centerline (not at its endpoints).
 * Returns adjustments for the T-wall's endpoint so its sides extend to the main wall's outline.
 */
function detectTJunctions(walls: WallSegment[]): TJunction[] {
  const result: TJunction[] = [];
  // Build set of known junction keys (endpoints shared by 2+ walls)
  const epCount = new Map<string, number>();
  for (const seg of walls) {
    for (const k of [ptKey(seg.x1, seg.y1), ptKey(seg.x2, seg.y2)]) {
      epCount.set(k, (epCount.get(k) ?? 0) + 1);
    }
  }

  for (const seg of walls) {
    const endpoints: [Pt, 'start' | 'end'][] = [
      [{ x: seg.x1, y: seg.y1 }, 'start'],
      [{ x: seg.x2, y: seg.y2 }, 'end'],
    ];
    for (const [ep, which] of endpoints) {
      const k = ptKey(ep.x, ep.y);
      if ((epCount.get(k) ?? 0) >= 2) continue; // already a regular junction

      for (const other of walls) {
        if (other.id === seg.id) continue;
        const A = { x: other.x1, y: other.y1 };
        const B = { x: other.x2, y: other.y2 };
        const { dist, t } = pointToSegDist(ep, A, B);
        if (dist > other.halfWidth * 1.1 || t < 0.01 || t > 0.99) continue;

        // T-junction found. Compute where the T-wall's two sides meet the main wall's outline.
        const mainDx = B.x - A.x, mainDy = B.y - A.y;
        const mainLen = Math.sqrt(mainDx * mainDx + mainDy * mainDy);
        if (mainLen < 0.001) continue;
        const mnx = -mainDy / mainLen, mny = mainDx / mainLen; // main wall normal
        const mainHw = other.halfWidth;

        // Main wall outline side 1: A + n*hw → B + n*hw
        // Main wall outline side 2: A - n*hw → B - n*hw
        const side1A = { x: A.x + mnx * mainHw, y: A.y + mny * mainHw };
        const side1B = { x: B.x + mnx * mainHw, y: B.y + mny * mainHw };
        const side2A = { x: A.x - mnx * mainHw, y: A.y - mny * mainHw };
        const side2B = { x: B.x - mnx * mainHw, y: B.y - mny * mainHw };

        // T-wall direction (away from junction = into the wall)
        const awayDx = which === 'start' ? seg.x2 - seg.x1 : seg.x1 - seg.x2;
        const awayDy = which === 'start' ? seg.y2 - seg.y1 : seg.y1 - seg.y2;
        const awayLen = Math.sqrt(awayDx * awayDx + awayDy * awayDy);
        if (awayLen < 0.001) continue;
        const tux = awayDx / awayLen, tuy = awayDy / awayLen;
        const tnx = -tuy, tny = tux; // T-wall normal
        const tHw = seg.halfWidth;

        // T-wall's two side origins at the endpoint
        const tLeft = { x: ep.x - tnx * tHw, y: ep.y + tux * tHw }; // CCW side
        const tRight = { x: ep.x + tuy * tHw, y: ep.y - tux * tHw }; // CW side

        // Intersect each T-wall side ray (going opposite to away dir) with main wall outline sides
        const backDir = { x: -tux, y: -tuy };
        const mainDir = { x: mainDx / mainLen, y: mainDy / mainLen };

        const intL1 = rayIntersect(tLeft, backDir, side1A, mainDir);
        const intL2 = rayIntersect(tLeft, backDir, side2A, mainDir);
        const intR1 = rayIntersect(tRight, backDir, side1A, mainDir);
        const intR2 = rayIntersect(tRight, backDir, side2A, mainDir);

        // Pick the intersection closest to the endpoint for each side
        const pickClosest = (a: Pt | null, b: Pt | null): Pt | null => {
          if (!a && !b) return null;
          if (!a) return b;
          if (!b) return a;
          const da = (a.x - ep.x) ** 2 + (a.y - ep.y) ** 2;
          const db = (b.x - ep.x) ** 2 + (b.y - ep.y) ** 2;
          return da < db ? a : b;
        };

        const left = pickClosest(intL1, intL2);
        const right = pickClosest(intR1, intR2);
        if (!left || !right) continue;

        result.push({ tWallId: seg.id, tWhich: which, mainWallId: other.id, left, right });
        break;
      }
    }
  }
  return result;
}

/** CW side (−normal_away) of wall at junction point P */
function cwPt(P: Pt, w: JunctionWall): Pt {
  return { x: P.x + w.dy * w.halfWidth, y: P.y - w.dx * w.halfWidth };
}

/** CCW side (+normal_away) of wall at junction point P */
function ccwPt(P: Pt, w: JunctionWall): Pt {
  return { x: P.x - w.dy * w.halfWidth, y: P.y + w.dx * w.halfWidth };
}

/** Intersect two rays: p1 + t*d1 and p2 + s*d2. Returns intersection point or null. */
function rayIntersect(p1: Pt, d1: Pt, p2: Pt, d2: Pt): Pt | null {
  const det = d2.x * d1.y - d1.x * d2.y;
  if (Math.abs(det) < 1e-10) return null;
  const t = (d2.x * (p2.y - p1.y) - d2.y * (p2.x - p1.x)) / det;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

/** Compute miter point for the gap between wi (CW side) and wj (CCW side). */
function miterPoint(P: Pt, wi: JunctionWall, wj: JunctionWall): Pt | null {
  const Ri = cwPt(P, wi);
  const Lj = ccwPt(P, wj);
  const di = { x: wi.dx, y: wi.dy };
  const dj = { x: wj.dx, y: wj.dy };
  const M = rayIntersect(Ri, di, Lj, dj);
  if (!M) return null;
  const dist = Math.sqrt((M.x - P.x) ** 2 + (M.y - P.y) ** 2);
  if (dist > MITER_LIMIT * Math.max(wi.halfWidth, wj.halfWidth)) return null;
  return M;
}

/**
 * Compute per-wall endpoint corner adjustments for miter joins.
 * Key: "wallId:start" or "wallId:end".
 *
 * Mapping to polygon corners (wall direction = start→end):
 *   Start endpoint: p1 = adj.left,  p4 = adj.right
 *   End   endpoint: p2 = adj.right, p3 = adj.left
 */
/** Result of miter computation: per-wall corner adjustments + junction fill data */
export interface MiterResult {
  adjustments: Map<string, CornerAdjustment>;
  /** Fill polygons at junctions (to cover gaps between wall fills) */
  junctionFills: { points: Pt[]; fill: string }[];
}

export function computeCornerAdjustments(walls: WallSegment[]): MiterResult {
  const empty: MiterResult = { adjustments: new Map(), junctionFills: [] };
  if (walls.length < 2) return empty;
  const junctions = buildJunctions(walls);
  const result: MiterResult = { adjustments: new Map(), junctionFills: [] };

  for (const junc of junctions.values()) {
    if (junc.walls.length < 2) continue;
    const P = { x: junc.x, y: junc.y };
    const sorted = junc.walls.slice().sort((a, b) => a.angle - b.angle);
    const n = sorted.length;

    // Miter for each gap: gap[i] is between sorted[i] and sorted[(i+1)%n]
    const miters: (Pt | null)[] = [];
    for (let i = 0; i < n; i++) {
      miters.push(miterPoint(P, sorted[i], sorted[(i + 1) % n]));
    }

    for (let i = 0; i < n; i++) {
      const w = sorted[i];
      const prevGap = (i - 1 + n) % n;
      const thisGap = i;

      result.adjustments.set(`${w.seg.id}:${w.which}`, {
        left: miters[prevGap] ?? ccwPt(P, w),
        right: miters[thisGap] ?? cwPt(P, w),
      });
    }

    // Junction fill polygons — cover triangular gaps between wall fills
    for (let i = 0; i < n; i++) {
      const wA = sorted[i];
      const wB = sorted[(i + 1) % n];
      const RA = cwPt(P, wA);
      const LB = ccwPt(P, wB);
      const M = miters[i];
      const fill = wA.seg.fill !== 'none' ? wA.seg.fill : wB.seg.fill;
      if (fill === 'none') continue;
      result.junctionFills.push({
        points: M ? [P, RA, M, LB] : [P, RA, LB],
        fill,
      });
    }
  }

  // T-junction handling: extend T-wall sides to meet main wall outline
  const tJunctions = detectTJunctions(walls);
  for (const tj of tJunctions) {
    const key = `${tj.tWallId}:${tj.tWhich}`;
    result.adjustments.set(key, { left: tj.left, right: tj.right });
  }

  return result;
}

// ─── Edge clipping: keep only outer edges of the wall polygon union ───

/** Test if point P is strictly inside convex polygon (winding order doesn't matter). */
function isInsideConvex(P: Pt, poly: Pt[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let pos = 0, neg = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    const cross = (b.x - a.x) * (P.y - a.y) - (b.y - a.y) * (P.x - a.x);
    if (cross > 1e-8) pos++;
    else if (cross < -1e-8) neg++;
    if (pos > 0 && neg > 0) return false;
  }
  return true;
}

/**
 * Clip segment [A,B] against a convex polygon. Returns portions OUTSIDE the polygon.
 * Uses Cyrus-Beck parametric clipping.
 */
function clipSegOutside(A: Pt, B: Pt, poly: Pt[]): [Pt, Pt][] {
  const dx = B.x - A.x, dy = B.y - A.y;
  let tEnter = 0, tLeave = 1;
  const n = poly.length;

  // Determine polygon winding
  let area2 = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    area2 += (b.x - a.x) * (b.y + a.y);
  }
  const windSign = area2 > 0 ? 1 : -1;

  for (let i = 0; i < n; i++) {
    const e0 = poly[i], e1 = poly[(i + 1) % n];
    // Inward normal (consistent with winding)
    const nx = -(e1.y - e0.y) * windSign, ny = (e1.x - e0.x) * windSign;
    const denom = nx * dx + ny * dy;
    const num = nx * (A.x - e0.x) + ny * (A.y - e0.y);

    if (Math.abs(denom) < 1e-12) {
      if (num > 1e-8) return [[A, B]]; // parallel and outside
      continue;
    }

    const t = -num / denom;
    if (denom < 0) { if (t > tEnter) tEnter = t; }
    else { if (t < tLeave) tLeave = t; }
  }

  if (tEnter >= tLeave - 1e-8) return [[A, B]]; // no real intersection

  const result: [Pt, Pt][] = [];
  const lerp = (t: number): Pt => ({ x: A.x + dx * t, y: A.y + dy * t });

  if (tEnter > 1e-6) result.push([A, lerp(tEnter)]);
  if (tLeave < 1 - 1e-6) result.push([lerp(tLeave), B]);
  return result;
}

export interface WallPolygon {
  id: string;
  corners: [Pt, Pt, Pt, Pt]; // p1, p2, p3, p4
}

/**
 * Given wall polygons, compute only the outer edge segments
 * (edges not inside any other wall polygon).
 */
export function computeOuterEdges(polygons: WallPolygon[]): [Pt, Pt][] {
  const result: [Pt, Pt][] = [];

  for (let wi = 0; wi < polygons.length; wi++) {
    const [p1, p2, p3, p4] = polygons[wi].corners;
    const edges: [Pt, Pt][] = [[p1, p2], [p2, p3], [p3, p4], [p4, p1]];

    for (const [eA, eB] of edges) {
      let segments: [Pt, Pt][] = [[eA, eB]];

      for (let wj = 0; wj < polygons.length; wj++) {
        if (wj === wi) continue;
        const otherPoly = polygons[wj].corners as unknown as Pt[];
        const next: [Pt, Pt][] = [];
        for (const seg of segments) {
          next.push(...clipSegOutside(seg[0], seg[1], otherPoly));
        }
        segments = next;
        if (segments.length === 0) break;
      }

      result.push(...segments);
    }
  }

  return result;
}

