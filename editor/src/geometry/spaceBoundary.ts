/**
 * Derives the polygon boundary of a `space` seed point from surrounding wall
 * line elements. Ported from `bimdown-spec/cli/src/build/space-boundary.ts`,
 * adapted to operate on `CanonicalElement` (LineElement) inputs rather than
 * GeoJSON files.
 *
 * Algorithm (half-edge / face tracing):
 *   1. Collect line segments from wall-like LineElements. Arcs are tessellated
 *      via `tessellateArc` into 4–8 line sub-segments.
 *   2. Split segments at T-junctions and proper crossings so the planar graph
 *      is topologically correct.
 *   3. Build a doubly-connected edge list (DCEL): each undirected edge becomes
 *      a pair of half-edges; outgoing edges per vertex are angle-sorted.
 *   4. Trace faces by repeatedly following `next` (CW-most outgoing from the
 *      twin's vertex). The face with positive signed area is the interior of
 *      a CCW polygon; the exterior boundary has negative signed area.
 *   5. Pick the smallest-area interior face that contains the seed point.
 */
import type { LineElement, Point } from '../model/elements.ts';
import { tessellateArc } from './arc.ts';

const TOLERANCE = 0.01; // 1cm in meters
const MAX_FACE_EDGES = 10000;

/** Tables whose LineElements participate in space boundary derivation. */
export const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'] as const;

// ─── Internal types ────────────────────────────────────────────────────────

interface Segment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  id: string;
}

interface Vertex {
  x: number;
  y: number;
  outgoing: HalfEdge[];
}

interface HalfEdge {
  from: Vertex;
  to: Vertex;
  twin: HalfEdge;
  next: HalfEdge;
  visited: boolean;
}

interface Face {
  polygon: Point[];
  signedArea: number;
}

// ─── Public entry point ────────────────────────────────────────────────────

/**
 * Returns the smallest enclosing polygon for `seedPoint` derived from the
 * given walls, or `null` if no enclosing face exists (open region / dangling
 * walls). The polygon vertices are returned in the natural CCW traversal of
 * the interior face — the caller can use them directly with the polygon
 * renderer.
 */
export function deriveSpaceBoundary(seedPoint: Point, walls: LineElement[]): Point[] | null {
  const segments = collectSegments(walls);
  if (segments.length === 0) return null;

  const split = splitAtIntersections(segments);
  const { halfEdges } = buildHalfEdgeStructure(split);
  const faces = traceFaces(halfEdges);

  let bestFace: Face | null = null;
  let bestArea = Infinity;
  for (const face of faces) {
    if (face.signedArea <= 0) continue; // skip outer / CW faces
    if (face.signedArea < bestArea && pointInPolygon(seedPoint.x, seedPoint.y, face.polygon)) {
      bestFace = face;
      bestArea = face.signedArea;
    }
  }
  return bestFace ? bestFace.polygon : null;
}

// ─── Segment collection (CanonicalElement → Segment) ───────────────────────

function collectSegments(walls: LineElement[]): Segment[] {
  const segments: Segment[] = [];
  for (const w of walls) {
    if (w.arc) {
      // Tessellate arc into a small polyline. Use coarser sampling than the
      // renderer (we only need topological fidelity, not pixel smoothness).
      const pts = tessellateArc(w.start, w.end, w.arc, 0.25);
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        if (dx * dx + dy * dy < TOLERANCE * TOLERANCE) continue;
        segments.push({ startX: a.x, startY: a.y, endX: b.x, endY: b.y, id: w.id });
      }
    } else {
      const dx = w.end.x - w.start.x, dy = w.end.y - w.start.y;
      if (dx * dx + dy * dy < TOLERANCE * TOLERANCE) continue;
      segments.push({
        startX: w.start.x, startY: w.start.y,
        endX: w.end.x, endY: w.end.y,
        id: w.id,
      });
    }
  }
  return segments;
}

// ─── Split at T-junctions + crossings ──────────────────────────────────────

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
      if (lenSq < TOLERANCE * TOLERANCE) {
        nextResult.push(seg);
        continue;
      }

      const splitPoints: { x: number; y: number; t: number }[] = [];

      // (a) T-junctions
      for (const ep of allEndpoints) {
        if (Math.abs(ep.x - seg.startX) < TOLERANCE && Math.abs(ep.y - seg.startY) < TOLERANCE) continue;
        if (Math.abs(ep.x - seg.endX) < TOLERANCE && Math.abs(ep.y - seg.endY) < TOLERANCE) continue;

        const t = ((ep.x - seg.startX) * dx + (ep.y - seg.startY) * dy) / lenSq;
        if (t <= TOLERANCE || t >= 1 - TOLERANCE) continue;

        const closestX = seg.startX + t * dx;
        const closestY = seg.startY + t * dy;
        const dxe = ep.x - closestX, dye = ep.y - closestY;
        if (dxe * dxe + dye * dye < TOLERANCE * TOLERANCE) {
          splitPoints.push({ x: ep.x, y: ep.y, t });
        }
      }

      // (b) Proper crossings
      for (let j = 0; j < result.length; j++) {
        if (j === i) continue;
        const other = result[j];
        const ox = other.endX - other.startX;
        const oy = other.endY - other.startY;
        const det = dx * oy - dy * ox;
        if (Math.abs(det) < 1e-12) continue;

        const rx = other.startX - seg.startX;
        const ry = other.startY - seg.startY;
        const t = (rx * oy - ry * ox) / det;
        const s = (rx * dy - ry * dx) / det;

        if (t <= TOLERANCE || t >= 1 - TOLERANCE) continue;
        if (s <= TOLERANCE || s >= 1 - TOLERANCE) continue;

        splitPoints.push({ x: seg.startX + t * dx, y: seg.startY + t * dy, t });
      }

      if (splitPoints.length === 0) {
        nextResult.push(seg);
      } else {
        changed = true;
        splitPoints.sort((a, b) => a.t - b.t);

        const unique = [splitPoints[0]];
        for (let k = 1; k < splitPoints.length; k++) {
          if (Math.abs(splitPoints[k].t - unique[unique.length - 1].t) > TOLERANCE) {
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

// ─── Half-edge construction ────────────────────────────────────────────────

function buildHalfEdgeStructure(segments: Segment[]): { vertices: Vertex[]; halfEdges: HalfEdge[] } {
  const vertices: Vertex[] = [];

  function findOrCreateVertex(x: number, y: number): Vertex {
    for (const v of vertices) {
      if (Math.abs(v.x - x) < TOLERANCE && Math.abs(v.y - y) < TOLERANCE) return v;
    }
    const v: Vertex = { x, y, outgoing: [] };
    vertices.push(v);
    return v;
  }

  const halfEdges: HalfEdge[] = [];

  for (const seg of segments) {
    const v1 = findOrCreateVertex(seg.startX, seg.startY);
    const v2 = findOrCreateVertex(seg.endX, seg.endY);
    if (v1 === v2) continue;
    if (v1.outgoing.some((he) => he.to === v2)) continue; // dedupe duplicate edges

    const he1 = { from: v1, to: v2 } as HalfEdge;
    const he2 = { from: v2, to: v1 } as HalfEdge;
    he1.twin = he2;
    he2.twin = he1;
    he1.visited = false;
    he2.visited = false;

    v1.outgoing.push(he1);
    v2.outgoing.push(he2);
    halfEdges.push(he1, he2);
  }

  for (const v of vertices) {
    v.outgoing.sort((a, b) => {
      const angleA = Math.atan2(a.to.y - v.y, a.to.x - v.x);
      const angleB = Math.atan2(b.to.y - v.y, b.to.x - v.x);
      return angleA - angleB;
    });
  }

  for (const he of halfEdges) {
    const v = he.to;
    const twinIdx = v.outgoing.indexOf(he.twin);
    if (twinIdx === -1) {
      he.next = he.twin;
      continue;
    }
    const prevIdx = (twinIdx - 1 + v.outgoing.length) % v.outgoing.length;
    he.next = v.outgoing[prevIdx];
  }

  return { vertices, halfEdges };
}

// ─── Face tracing ──────────────────────────────────────────────────────────

function traceFaces(halfEdges: HalfEdge[]): Face[] {
  const faces: Face[] = [];

  for (const startHe of halfEdges) {
    if (startHe.visited) continue;

    const polygon: Point[] = [];
    let current = startHe;
    let count = 0;

    do {
      current.visited = true;
      polygon.push({ x: current.from.x, y: current.from.y });
      current = current.next;
      count++;
    } while (current !== startHe && count < MAX_FACE_EDGES);

    if (count >= MAX_FACE_EDGES) continue;

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

// ─── Point-in-polygon (ray casting) ────────────────────────────────────────

function pointInPolygon(px: number, py: number, polygon: Point[]): boolean {
  let crossings = 0;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    const yi = polygon[i].y, yj = polygon[j].y;
    const xi = polygon[i].x, xj = polygon[j].x;
    if ((yi <= py && py < yj) || (yj <= py && py < yi)) {
      const t = (py - yi) / (yj - yi);
      const xIntersect = xi + t * (xj - xi);
      if (px < xIntersect) crossings++;
    }
  }
  return crossings % 2 === 1;
}
