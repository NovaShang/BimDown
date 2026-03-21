/**
 * Wall junction fill algorithm.
 *
 * When two walls meet at a shared endpoint, their rectangular bodies leave
 * a triangular gap at the corner. This module detects shared endpoints and
 * computes fill-patch triangles to close those gaps.
 *
 * Algorithm:
 * 1. Build a spatial index of wall endpoints (with tolerance for FP matching)
 * 2. At each junction (2+ walls share an endpoint), sort walls by direction angle
 * 3. For each adjacent pair in the sorted ring, emit a fill triangle:
 *    (junction_point, right_edge_of_wall_A, left_edge_of_wall_B)
 */

export interface WallSegment {
  id: string;
  x1: number; y1: number;
  x2: number; y2: number;
  halfWidth: number;
  fill: string;
}

export interface JunctionPatch {
  /** Triangle vertices */
  points: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  fill: string;
}

/** Tolerance for endpoint matching (meters) */
const EPS = 0.002;

/** Quantize a coordinate for spatial hashing */
function quantize(v: number): number {
  return Math.round(v / EPS) * EPS;
}

function key(x: number, y: number): string {
  return `${quantize(x).toFixed(4)},${quantize(y).toFixed(4)}`;
}

interface JunctionWall {
  seg: WallSegment;
  /** Direction pointing AWAY from the junction point */
  dx: number;
  dy: number;
  angle: number;
  halfWidth: number;
}

/**
 * Compute fill patches for all wall junctions.
 */
export function computeWallJunctions(walls: WallSegment[]): JunctionPatch[] {
  if (walls.length < 2) return [];

  // Build endpoint → walls map
  // Each wall contributes to two endpoints (start and end)
  const endpointMap = new Map<string, { x: number; y: number; walls: JunctionWall[] }>();

  for (const seg of walls) {
    addEndpoint(endpointMap, seg.x1, seg.y1, seg, seg.x2 - seg.x1, seg.y2 - seg.y1);
    addEndpoint(endpointMap, seg.x2, seg.y2, seg, seg.x1 - seg.x2, seg.y1 - seg.y2);
  }

  const patches: JunctionPatch[] = [];

  for (const junction of endpointMap.values()) {
    if (junction.walls.length < 2) continue;

    const P = junction;
    const sorted = junction.walls.slice().sort((a, b) => a.angle - b.angle);

    for (let i = 0; i < sorted.length; i++) {
      const wA = sorted[i];
      const wB = sorted[(i + 1) % sorted.length];

      // Normal of each wall (90° CCW from direction)
      const nAx = -wA.dy, nAy = wA.dx;
      const nBx = -wB.dy, nBy = wB.dx;

      // Right edge of wall A at junction: P - nA * hA
      const rA = { x: P.x - nAx * wA.halfWidth, y: P.y - nAy * wA.halfWidth };
      // Left edge of wall B at junction: P + nB * hB
      const lB = { x: P.x + nBx * wB.halfWidth, y: P.y + nBy * wB.halfWidth };

      // Skip degenerate triangles (collinear walls)
      const area = Math.abs(
        (rA.x - P.x) * (lB.y - P.y) - (lB.x - P.x) * (rA.y - P.y),
      );
      if (area < 1e-8) continue;

      // Use the darker/more prominent fill
      const fill = wA.seg.fill !== 'none' ? wA.seg.fill : wB.seg.fill;

      patches.push({
        points: [{ x: P.x, y: P.y }, rA, lB],
        fill,
      });
    }
  }

  return patches;
}

function addEndpoint(
  map: Map<string, { x: number; y: number; walls: JunctionWall[] }>,
  ex: number, ey: number,
  seg: WallSegment,
  awayDx: number, awayDy: number,
) {
  const len = Math.sqrt(awayDx * awayDx + awayDy * awayDy);
  if (len < 0.001) return;

  const dx = awayDx / len;
  const dy = awayDy / len;

  const k = key(ex, ey);
  let entry = map.get(k);
  if (!entry) {
    entry = { x: ex, y: ey, walls: [] };
    map.set(k, entry);
  }
  entry.walls.push({
    seg,
    dx,
    dy,
    angle: Math.atan2(dy, dx),
    halfWidth: seg.halfWidth,
  });
}

/**
 * Render junction patches as SVG polygon strings.
 */
export function junctionPatchesToSvg(patches: JunctionPatch[]): string {
  return patches.map(p => {
    const pts = p.points.map(v => `${v.x},${v.y}`).join(' ');
    return `<polygon points="${pts}" fill="${p.fill}" stroke="none" />`;
  }).join('\n');
}
