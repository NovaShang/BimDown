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

/**
 * Overlay data for one junction gap (document mode).
 * Contains fill polygons and outline segments to render on top of
 * individually-rendered wall elements.
 */
export interface JunctionOverlay {
  outerFill: Pt[];
  innerFill: Pt[];
  fillColor: string;
  outlines: [Pt, Pt][];
  outlineColor: string;
  outlineWidth: number;
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

function buildJunctions(walls: WallSegment[]): JunctionMap {
  const map: JunctionMap = new Map();
  for (const seg of walls) {
    addEndpoint(map, seg.x1, seg.y1, seg, 'start', seg.x2 - seg.x1, seg.y2 - seg.y1);
    addEndpoint(map, seg.x2, seg.y2, seg, 'end', seg.x1 - seg.x2, seg.y1 - seg.y2);
  }
  return map;
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
export function computeCornerAdjustments(walls: WallSegment[]): Map<string, CornerAdjustment> {
  if (walls.length < 2) return new Map();
  const junctions = buildJunctions(walls);
  const result = new Map<string, CornerAdjustment>();

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

      result.set(`${w.seg.id}:${w.which}`, {
        left: miters[prevGap] ?? ccwPt(P, w),
        right: miters[thisGap] ?? cwPt(P, w),
      });
    }
  }

  return result;
}

/**
 * Compute junction overlay data for document mode rendering.
 * Each overlay covers one gap between adjacent walls at a junction,
 * providing fill polygons and outline segments to render on top of
 * individually-rendered wall elements.
 */
export function computeJunctionOverlays(
  walls: WallSegment[],
  outlineColor: string,
  outlineWidth: number,
): JunctionOverlay[] {
  if (walls.length < 2) return [];
  const junctions = buildJunctions(walls);
  const overlays: JunctionOverlay[] = [];

  for (const junc of junctions.values()) {
    if (junc.walls.length < 2) continue;
    const P = { x: junc.x, y: junc.y };
    const sorted = junc.walls.slice().sort((a, b) => a.angle - b.angle);

    for (let i = 0; i < sorted.length; i++) {
      const wA = sorted[i];
      const wB = sorted[(i + 1) % sorted.length];

      const RA = cwPt(P, wA);
      const LB = ccwPt(P, wB);

      // Skip degenerate (collinear walls)
      const area = Math.abs((RA.x - P.x) * (LB.y - P.y) - (LB.x - P.x) * (RA.y - P.y));
      if (area < 1e-8) continue;

      const LA = ccwPt(P, wA);
      const RB = cwPt(P, wB);

      const M_outer = miterPoint(P, wA, wB);
      const M_inner_raw = rayIntersect(LA, { x: wA.dx, y: wA.dy }, RB, { x: wB.dx, y: wB.dy });
      const M_inner = M_inner_raw && Math.sqrt((M_inner_raw.x - P.x) ** 2 + (M_inner_raw.y - P.y) ** 2)
        <= MITER_LIMIT * Math.max(wA.halfWidth, wB.halfWidth) ? M_inner_raw : null;

      const fillColor = wA.seg.fill !== 'none' ? wA.seg.fill : wB.seg.fill;

      const outerFill = M_outer ? [P, RA, M_outer, LB] : [P, RA, LB];
      const innerFill = M_inner ? [P, LA, M_inner, RB] : [P, LA, RB];

      const outlines: [Pt, Pt][] = [];
      if (M_outer) {
        outlines.push([RA, M_outer], [M_outer, LB]);
      } else {
        outlines.push([RA, LB]);
      }
      if (M_inner) {
        outlines.push([LA, M_inner], [M_inner, RB]);
      } else {
        outlines.push([LA, RB]);
      }

      overlays.push({ outerFill, innerFill, fillColor, outlines, outlineColor, outlineWidth });
    }
  }

  return overlays;
}
