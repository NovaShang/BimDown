/**
 * Pure core of room derivation (no file I/O, safe in the browser): wall /
 * separator segments + seed points → enclosed faces, matched rooms and room
 * problems. `space-boundary.ts` reads a level directory and calls this; the
 * IFC importer calls it on its in-memory result.
 */

export const TOLERANCE = 0.01; // 1cm in meters
const MAX_FACE_EDGES = 10000; // safety limit for face tracing

// ─── Data structures ────────────────────────────────────

interface Vertex {
  x: number;
  y: number;
  id: number;
  outgoing: HalfEdge[];
}

interface HalfEdge {
  from: Vertex;
  to: Vertex;
  twin: HalfEdge;
  next: HalfEdge;
  visited: boolean;
  sourceId: string;
}

export interface Face {
  polygon: { x: number; y: number }[];
  signedArea: number;
}

export interface Segment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  id: string;
}

/**
 * A derived-room problem: the polygons are still written (backward compatible),
 * but their areas are wrong.
 *   shared    — several seeds land in one enclosed area, so the rooms get
 *               identical polygons (usually a wall gap or a missing room_separator)
 *   contains  — the polygon of spaceIds encloses the rooms in `inside`, whose
 *               walls don't touch it, so its area double-counts them
 *   unbounded — the seed is outside every closed loop; no polygon is generated
 */
export interface RoomIssue {
  kind: 'shared' | 'contains' | 'unbounded';
  level: string;
  spaceIds: string[];
  /** For `contains`: the enclosed rooms. */
  inside?: string[];
}

// ─── Rooms from segments ────────────────────────────────

export interface RoomSeed { id: string; x: number; y: number; /** Coordinates as written in space.csv, for warnings. */ raw?: [string, string] }

export interface DerivedRooms {
  /** Space id → the face it lies in. */
  matched: Map<string, Face>;
  roomIssues: RoomIssue[];
  warnings: string[];
}

/**
 * Trace the faces of `segments` and match each seed to the smallest interior
 * face holding it. `level` names the level in warnings, `units` the area unit.
 */
export function deriveRooms(level: string, segments: Segment[], seeds: RoomSeed[], units = 'm'): DerivedRooms {
  const warnings: string[] = [];
  const roomIssues: RoomIssue[] = [];
  const matched = new Map<string, Face>();

  // Split segments at T-junctions AND proper crossings so the half-edge
  // topology is correct (two walls that cross each other must become four
  // half-length segments meeting at the intersection point).
  const splitSegments = splitAtIntersections(segments);
  const { vertices, halfEdges } = buildHalfEdgeStructure(splitSegments);

  // Report dangling endpoints (degree 1 vertices)
  for (const v of vertices) {
    if (v.outgoing.length === 1) {
      const he = v.outgoing[0];
      warnings.push(
        `[warn] ${level}/  ${he.sourceId} endpoint (${v.x.toFixed(3)}, ${v.y.toFixed(3)}) has no connected line element`,
      );
    }
  }

  const faces = traceFaces(halfEdges);

  // Match seed points to faces
  const seedMap = new Map<string, { x: number; y: number }>();
  for (const seed of seeds) {
    if (isNaN(seed.x) || isNaN(seed.y)) continue;
    let bestFace: Face | null = null;
    let bestArea = Infinity;
    for (const face of faces) {
      // Skip outer boundary face (CW winding = negative signed area)
      if (face.signedArea <= 0) continue;
      if (face.signedArea < bestArea && pointInPolygon(seed.x, seed.y, face.polygon)) {
        bestFace = face;
        bestArea = face.signedArea;
      }
    }
    if (bestFace) {
      matched.set(seed.id, bestFace);
      seedMap.set(seed.id, { x: seed.x, y: seed.y });
    } else {
      roomIssues.push({ kind: 'unbounded', level, spaceIds: [seed.id] });
      warnings.push(
        `[warn] ${level}/space.csv  ${seed.id} at (${seed.raw?.[0] ?? seed.x}, ${seed.raw?.[1] ?? seed.y}) has no enclosing boundary — the seed is outside every closed loop of walls/room separators (wall gap or seed outside the building); no polygon generated`,
      );
    }
  }

  // Overlap / leak checks on the derived rooms (warnings only).
  const overlap = findRoomOverlaps(level, matched, seedMap, units);
  roomIssues.push(...overlap.roomIssues);
  warnings.push(...overlap.warnings);
  return { matched, roomIssues, warnings };
}

// ─── Derived-room overlap checks ────────────────────────

/**
 * Faces of one planar subdivision never overlap, except that a face's traced
 * outline ignores holes: a loop of walls that doesn't touch the surrounding
 * walls (an island) lies inside the outer face's polygon. So derived rooms can
 * only overlap in two ways — two seeds in the same face, or one room's seed
 * inside another room's (larger) face.
 */
function findRoomOverlaps(
  level: string,
  matched: Map<string, Face>,
  seeds: Map<string, { x: number; y: number }>,
  units: string,
): { warnings: string[]; roomIssues: RoomIssue[] } {
  const warnings: string[] = [];
  const roomIssues: RoomIssue[] = [];

  const byFace = new Map<Face, string[]>();
  for (const [id, face] of matched) {
    const ids = byFace.get(face);
    if (ids) ids.push(id);
    else byFace.set(face, [id]);
  }

  for (const [face, ids] of byFace) {
    if (ids.length < 2) continue;
    roomIssues.push({ kind: 'shared', level, spaceIds: ids });
    warnings.push(
      `[warn] ${level}/space.csv  ${ids.join(', ')} share one enclosed area (${fmtArea(face.signedArea, units)}) and get identical polygons — a wall gap or missing room_separator likely merges these rooms`,
    );
  }

  // Each room's immediate container: the smallest other matched face holding its seed.
  const contained = new Map<Face, string[]>();
  for (const [id, face] of matched) {
    const seed = seeds.get(id)!;
    let parent: Face | null = null;
    for (const other of byFace.keys()) {
      if (other === face || other.signedArea <= face.signedArea) continue;
      if (parent && other.signedArea >= parent.signedArea) continue;
      if (pointInPolygon(seed.x, seed.y, other.polygon)) parent = other;
    }
    if (!parent) continue;
    const list = contained.get(parent);
    if (list) list.push(id);
    else contained.set(parent, [id]);
  }

  for (const [outer, inner] of contained) {
    const outerIds = byFace.get(outer)!;
    roomIssues.push({ kind: 'contains', level, spaceIds: outerIds, inside: inner });
    warnings.push(
      `[warn] ${level}/space.csv  ${outerIds.join(', ')} polygon (${fmtArea(outer.signedArea, units)}) contains ${inner.join(', ')} — their walls don't connect to the surrounding walls, so the outer area also counts them; join the walls or add a room_separator`,
    );
  }

  return { warnings, roomIssues };
}

function fmtArea(a: number, units: string): string {
  return `${a.toFixed(1)} ${units}²`;
}

// ─── Segment intersection splitting ─────────────────────

/**
 * Pre-process segments so that the half-edge topology will be correct:
 *
 *   1. **T-junctions**: when an endpoint of segment B falls on the interior
 *      of segment A, split A at that point.
 *   2. **Proper crossings**: when two segments cross in each other's interior
 *      (neither touches the other's endpoint), split BOTH at the computed
 *      intersection point.
 *
 * Both passes run in the same loop: every segment collects all of its split
 * points from both sources, then is broken into sub-segments in one shot.
 * The outer `while (changed)` loop handles cascading splits (a new sub-segment
 * may become a T-junction target for yet another segment).
 */
function splitAtIntersections(segments: Segment[]): Segment[] {
  let result = [...segments];
  let changed = true;

  while (changed) {
    changed = false;

    const allEndpoints: { x: number; y: number }[] = [];
    for (const seg of result) {
      allEndpoints.push({ x: seg.startX, y: seg.startY });
      allEndpoints.push({ x: seg.endX, y: seg.endY });
    }

    const nextResult: Segment[] = [];

    for (let i = 0; i < result.length; i++) {
      const seg = result[i];
      const dx = seg.endX - seg.startX;
      const dy = seg.endY - seg.startY;
      const lenSq = dx * dx + dy * dy;
      // Tolerances below are distances along the segment (1 cm), not fractions of it
      const segLen = Math.sqrt(lenSq);
      if (lenSq < TOLERANCE * TOLERANCE) {
        nextResult.push(seg);
        continue;
      }

      const splitPoints: { x: number; y: number; t: number }[] = [];

      // (a) T-junction: endpoints of OTHER segments that land on seg's interior.
      for (const ep of allEndpoints) {
        if (Math.abs(ep.x - seg.startX) < TOLERANCE && Math.abs(ep.y - seg.startY) < TOLERANCE) continue;
        if (Math.abs(ep.x - seg.endX) < TOLERANCE && Math.abs(ep.y - seg.endY) < TOLERANCE) continue;

        const t = ((ep.x - seg.startX) * dx + (ep.y - seg.startY) * dy) / lenSq;
        if (t * segLen <= TOLERANCE || (1 - t) * segLen <= TOLERANCE) continue;

        const closestX = seg.startX + t * dx;
        const closestY = seg.startY + t * dy;
        const distSq = (ep.x - closestX) * (ep.x - closestX) + (ep.y - closestY) * (ep.y - closestY);
        if (distSq < TOLERANCE * TOLERANCE) {
          splitPoints.push({ x: ep.x, y: ep.y, t });
        }
      }

      // (b) Proper crossings: solve seg ∩ other as line-line intersection,
      // require BOTH parameters to be strictly in the interior. If `other`
      // touches seg at an endpoint (s ≈ 0 or 1), branch (a) handles it already.
      for (let j = 0; j < result.length; j++) {
        if (j === i) continue;
        const other = result[j];
        const ox = other.endX - other.startX;
        const oy = other.endY - other.startY;

        // det = (dx,dy) × (ox,oy); 0 → parallel / colinear (unsupported here).
        const det = dx * oy - dy * ox;
        if (Math.abs(det) < 1e-12) continue;

        // Solve: seg.start + t·(dx,dy) = other.start + s·(ox,oy)
        const rx = other.startX - seg.startX;
        const ry = other.startY - seg.startY;
        const t = (rx * oy - ry * ox) / det;
        const s = (rx * dy - ry * dx) / det;

        if (t * segLen <= TOLERANCE || (1 - t) * segLen <= TOLERANCE) continue;
        const otherLen = Math.hypot(ox, oy);
        if (s * otherLen <= TOLERANCE || (1 - s) * otherLen <= TOLERANCE) continue;

        splitPoints.push({
          x: seg.startX + t * dx,
          y: seg.startY + t * dy,
          t,
        });
      }

      if (splitPoints.length === 0) {
        nextResult.push(seg);
      } else {
        changed = true;
        splitPoints.sort((a, b) => a.t - b.t);

        // Dedup near-coincident split points (e.g. endpoint-on-interior AND
        // crossing hitting the same spot).
        const unique = [splitPoints[0]];
        for (let k = 1; k < splitPoints.length; k++) {
          if (Math.abs(splitPoints[k].t - unique[unique.length - 1].t) * segLen > TOLERANCE) {
            unique.push(splitPoints[k]);
          }
        }

        let prevX = seg.startX, prevY = seg.startY;
        for (const sp of unique) {
          nextResult.push({ startX: prevX, startY: prevY, endX: sp.x, endY: sp.y, id: seg.id });
          prevX = sp.x;
          prevY = sp.y;
        }
        nextResult.push({ startX: prevX, startY: prevY, endX: seg.endX, endY: seg.endY, id: seg.id });
      }
    }

    result = nextResult;
  }

  return result;
}

// ─── Half-edge construction ─────────────────────────────

function buildHalfEdgeStructure(segments: Segment[]): {
  vertices: Vertex[];
  halfEdges: HalfEdge[];
} {
  const vertices: Vertex[] = [];

  function findOrCreateVertex(x: number, y: number): Vertex {
    for (const v of vertices) {
      if (Math.abs(v.x - x) < TOLERANCE && Math.abs(v.y - y) < TOLERANCE) {
        return v;
      }
    }
    const v: Vertex = { x, y, id: vertices.length, outgoing: [] };
    vertices.push(v);
    return v;
  }

  // Create half-edges for each segment
  const halfEdges: HalfEdge[] = [];

  for (const seg of segments) {
    const v1 = findOrCreateVertex(seg.startX, seg.startY);
    const v2 = findOrCreateVertex(seg.endX, seg.endY);
    if (v1 === v2) continue; // degenerate

    // Check for duplicate edge (same two vertices already connected)
    const isDuplicate = v1.outgoing.some((he) => he.to === v2);
    if (isDuplicate) continue;

    const he1 = { from: v1, to: v2, sourceId: seg.id } as HalfEdge;
    const he2 = { from: v2, to: v1, sourceId: seg.id } as HalfEdge;
    he1.twin = he2;
    he2.twin = he1;
    he1.visited = false;
    he2.visited = false;

    v1.outgoing.push(he1);
    v2.outgoing.push(he2);
    halfEdges.push(he1, he2);
  }

  // Sort outgoing edges at each vertex by angle
  for (const v of vertices) {
    v.outgoing.sort((a, b) => {
      const angleA = Math.atan2(a.to.y - v.y, a.to.x - v.x);
      const angleB = Math.atan2(b.to.y - v.y, b.to.x - v.x);
      return angleA - angleB;
    });
  }

  // Link next pointers:
  // For half-edge `he` arriving at vertex v, the face continues with
  // the outgoing edge one step CW from the twin (which leaves v going back).
  for (const he of halfEdges) {
    const v = he.to;
    const twinIdx = v.outgoing.indexOf(he.twin);
    if (twinIdx === -1) {
      // Should not happen, but handle gracefully
      he.next = he.twin;
      continue;
    }
    const prevIdx = (twinIdx - 1 + v.outgoing.length) % v.outgoing.length;
    he.next = v.outgoing[prevIdx];
  }

  return { vertices, halfEdges };
}

// ─── Face tracing ───────────────────────────────────────

function traceFaces(halfEdges: HalfEdge[]): Face[] {
  const faces: Face[] = [];

  for (const startHe of halfEdges) {
    if (startHe.visited) continue;

    const polygon: { x: number; y: number }[] = [];
    let current = startHe;
    let count = 0;

    do {
      current.visited = true;
      polygon.push({ x: current.from.x, y: current.from.y });
      current = current.next;
      count++;
    } while (current !== startHe && count < MAX_FACE_EDGES);

    if (count >= MAX_FACE_EDGES) continue; // malformed cycle, skip

    // Compute signed area (shoelace formula)
    // Positive = CCW (interior face), Negative = CW (exterior/boundary face)
    let signedArea = 0;
    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length;
      signedArea += polygon[i].x * polygon[j].y;
      signedArea -= polygon[j].x * polygon[i].y;
    }
    signedArea /= 2;

    faces.push({ polygon, signedArea });
  }

  return faces;
}

// ─── Point-in-polygon (ray casting) ─────────────────────

export function pointInPolygon(px: number, py: number, polygon: { x: number; y: number }[]): boolean {
  let crossings = 0;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    const yi = polygon[i].y;
    const yj = polygon[j].y;
    const xi = polygon[i].x;
    const xj = polygon[j].x;

    if ((yi <= py && py < yj) || (yj <= py && py < yi)) {
      const t = (py - yi) / (yj - yi);
      const xIntersect = xi + t * (xj - xi);
      if (px < xIntersect) crossings++;
    }
  }
  return crossings % 2 === 1;
}
