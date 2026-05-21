import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseGeoJsonFile,
  stringifyFeatureCollection,
  extractLineGeometry,
  type BimDownFeature,
  type BimDownFeatureCollection,
} from '../utils/geojson.js';
import { readCsv } from '../utils/csv.js';
import { GEOJSON_FILE_NAMES } from '../schema/registry.js';

const TOLERANCE = 0.01; // 1cm in meters
const MAX_FACE_EDGES = 10000; // safety limit for face tracing

/** Boundary element SVG file names to collect line segments from */
const BOUNDARY_TABLES = ['wall', 'structure_wall', 'curtain_wall', 'room_separator'];

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

interface Face {
  polygon: { x: number; y: number }[];
  signedArea: number;
}

interface Segment {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  id: string;
}

export interface SpaceBoundaryResult {
  warnings: string[];
  geojsonWritten: boolean;
}

// ─── Main entry point ───────────────────────────────────

export function computeSpaceBoundaries(
  levelDir: { name: string; path: string },
  globalDir?: string,
): SpaceBoundaryResult {
  const warnings: string[] = [];

  const spaceCsvPath = join(levelDir.path, 'space.csv');
  if (!existsSync(spaceCsvPath)) return { warnings, geojsonWritten: false };

  const spaceCsv = readCsv(spaceCsvPath);
  if (spaceCsv.rows.length === 0) return { warnings, geojsonWritten: false };

  // 1. Collect all boundary line segments (level-local + global)
  const segments = collectBoundarySegments(levelDir.path);
  if (globalDir) {
    segments.push(...collectBoundarySegments(globalDir));
  }
  if (segments.length === 0) {
    warnings.push(`${levelDir.name}/  no boundary elements found for space boundary computation`);
    return { warnings, geojsonWritten: false };
  }

  // 2. Split segments at T-junctions AND proper crossings so the half-edge
  // topology is correct (two walls that cross each other must become four
  // half-length segments meeting at the intersection point).
  const splitSegments = splitAtIntersections(segments);

  // 3-5. Build half-edge structure
  const { vertices, halfEdges } = buildHalfEdgeStructure(splitSegments);

  // Report dangling endpoints (degree 1 vertices)
  for (const v of vertices) {
    if (v.outgoing.length === 1) {
      const he = v.outgoing[0];
      warnings.push(
        `[warn] ${levelDir.name}/  ${he.sourceId} endpoint (${v.x.toFixed(3)}, ${v.y.toFixed(3)}) has no connected line element`,
      );
    }
  }

  // 6. Trace faces
  const faces = traceFaces(halfEdges);

  // 7. Match seed points to faces
  const matchedSpaces = new Map<string, Face>();
  for (const row of spaceCsv.rows) {
    const seedX = parseFloat(row.x ?? '');
    const seedY = parseFloat(row.y ?? '');
    if (isNaN(seedX) || isNaN(seedY)) continue;

    let bestFace: Face | null = null;
    let bestArea = Infinity;

    for (const face of faces) {
      // Skip outer boundary face (CW winding = negative signed area)
      if (face.signedArea <= 0) continue;
      if (face.signedArea < bestArea && pointInPolygon(seedX, seedY, face.polygon)) {
        bestFace = face;
        bestArea = face.signedArea;
      }
    }

    if (bestFace) {
      matchedSpaces.set(row.id, bestFace);
    } else {
      warnings.push(
        `[warn] ${levelDir.name}/space.csv  ${row.id} at (${row.x}, ${row.y}) has no enclosing boundary`,
      );
    }
  }

  if (matchedSpaces.size === 0) return { warnings, geojsonWritten: false };

  // 8. Write space.svg
  writeSvg(levelDir.path, matchedSpaces);
  return { warnings, geojsonWritten: true };
}

// ─── Segment collection ─────────────────────────────────

function collectBoundarySegments(levelPath: string): Segment[] {
  const segments: Segment[] = [];

  for (const table of BOUNDARY_TABLES) {
    const geomName = GEOJSON_FILE_NAMES[table];
    if (!geomName) continue;
    const path = join(levelPath, `${geomName}.geojson`);
    if (!existsSync(path)) continue;

    try {
      const fc = parseGeoJsonFile(path);
      for (const f of fc.features) {
        if (f.geometry.type !== 'LineString') continue;
        const id = String(f.properties?.id ?? '');
        if (!id) continue;
        const lg = extractLineGeometry(f);
        if (lg.length < TOLERANCE) continue;
        segments.push({
          startX: lg.start_x, startY: lg.start_y,
          endX: lg.end_x, endY: lg.end_y,
          id,
        });
      }
    } catch { /* skip */ }
  }

  return segments;
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
        if (t <= TOLERANCE || t >= 1 - TOLERANCE) continue;

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

        if (t <= TOLERANCE || t >= 1 - TOLERANCE) continue;
        if (s <= TOLERANCE || s >= 1 - TOLERANCE) continue;

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

function pointInPolygon(px: number, py: number, polygon: { x: number; y: number }[]): boolean {
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

// ─── GeoJSON output ─────────────────────────────────────

function writeSvg(levelPath: string, matchedSpaces: Map<string, Face>): void {
  const features: BimDownFeature[] = [];
  for (const [spaceId, face] of matchedSpaces) {
    // Close the ring per RFC 7946
    const ring = face.polygon.map((p) => [
      Number(p.x.toFixed(3)),
      Number(p.y.toFixed(3)),
    ] as [number, number]);
    if (ring.length === 0) continue;
    const first = ring[0], last = ring[ring.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) ring.push([first[0], first[1]]);
    features.push({
      type: 'Feature',
      properties: { id: spaceId },
      geometry: { type: 'Polygon', coordinates: [ring] },
    });
  }
  const fc: BimDownFeatureCollection = { type: 'FeatureCollection', features };
  writeFileSync(join(levelPath, 'space.geojson'), stringifyFeatureCollection(fc), 'utf-8');
}
