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

  return result;
}

