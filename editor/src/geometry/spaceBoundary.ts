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
 *
 * Steps 1–4 depend only on the walls, so they run once per wall set
 * (`getSpaceFaceGraph`, cached on the wall geometry) and every seed on the
 * level only does step 5. Splitting and vertex merging use uniform grids
 * but visit candidates in the original order, so the result is identical
 * to the plain O(n²) version (spaceBoundary.legacy.ts, checked by tests).
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
  index: number;
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
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** Interior faces (positive signed area) of the wall graph, in trace order. */
export interface SpaceFaceGraph {
  faces: readonly Face[];
}

// ─── Public entry points ───────────────────────────────────────────────────

/**
 * Returns the smallest enclosing polygon for `seedPoint` derived from the
 * given walls, or `null` if no enclosing face exists (open region / dangling
 * walls). The polygon vertices are returned in the natural CCW traversal of
 * the interior face — the caller can use them directly with the polygon
 * renderer.
 */
export function deriveSpaceBoundary(seedPoint: Point, walls: LineElement[]): Point[] | null {
  return findSpaceBoundary(getSpaceFaceGraph(walls), seedPoint);
}

/** Smallest interior face of `graph` containing `seedPoint` (first one wins on ties). */
export function findSpaceBoundary(graph: SpaceFaceGraph, seedPoint: Point): Point[] | null {
  const px = seedPoint.x, py = seedPoint.y;
  let bestFace: Face | null = null;
  let bestArea = Infinity;
  for (const face of graph.faces) {
    if (face.signedArea >= bestArea) continue;
    // A point outside the bbox can't be inside (ray casting counts an even
    // number of crossings there), so this only skips the polygon test.
    if (px < face.minX || px > face.maxX || py < face.minY || py > face.maxY) continue;
    if (pointInPolygon(px, py, face.polygon)) {
      bestFace = face;
      bestArea = face.signedArea;
    }
  }
  return bestFace ? bestFace.polygon : null;
}

const GRAPH_CACHE_SIZE = 32;
const graphCache = new Map<string, SpaceFaceGraph>();

/**
 * Face graph of a wall set, cached on the walls' geometry (endpoints + arc
 * parameters, in order), so re-renders, other seeds and other passes over an
 * unchanged level reuse it. Small LRU: one entry per level / wall revision.
 */
export function getSpaceFaceGraph(walls: LineElement[]): SpaceFaceGraph {
  const key = wallsKey(walls);
  const hit = graphCache.get(key);
  if (hit) {
    graphCache.delete(key);
    graphCache.set(key, hit);
    return hit;
  }
  const graph = buildSpaceFaceGraph(walls);
  graphCache.set(key, graph);
  if (graphCache.size > GRAPH_CACHE_SIZE) {
    graphCache.delete(graphCache.keys().next().value!);
  }
  return graph;
}

/** Steps 1–4: the interior faces of the planar graph formed by `walls`. */
export function buildSpaceFaceGraph(walls: LineElement[]): SpaceFaceGraph {
  const segments = collectSegments(walls);
  if (segments.length === 0) return { faces: [] };
  const split = splitAtIntersections(segments);
  const { halfEdges } = buildHalfEdgeStructure(split);
  const faces = traceFaces(halfEdges).filter(f => f.signedArea > 0); // skip outer / CW faces
  return { faces };
}

function wallsKey(walls: LineElement[]): string {
  const parts: string[] = [];
  for (const w of walls) {
    const a = w.arc;
    parts.push(a
      ? `${w.start.x},${w.start.y},${w.end.x},${w.end.y},${a.rx},${a.ry},${a.rotation},${a.largeArc ? 1 : 0},${a.sweep ? 1 : 0}`
      : `${w.start.x},${w.start.y},${w.end.x},${w.end.y}`);
  }
  return parts.join(';');
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

// ─── Uniform grid over segment bboxes / endpoints ──────────────────────────

/** Bbox slack: candidates are a superset of what the exact tests accept. */
const GRID_PAD = 2 * TOLERANCE;
/** Segments covering more cells than this go to a list checked against all. */
const MAX_CELLS_PER_SEGMENT = 4096;

class SegmentGrid {
  private minX: number;
  private minY: number;
  private cols: number;
  private rows: number;
  private cell: number;
  /** cell → segment indices whose padded bbox overlaps it (ascending). */
  private segCells = new Map<number, number[]>();
  /** cell → endpoint indices (2i = start, 2i+1 = end of segment i; ascending). */
  private epCells = new Map<number, number[]>();
  private bigSegments: number[] = [];
  private stamp: Int32Array;
  private stampValue = 0;

  constructor(segments: Segment[]) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sumLen = 0;
    for (const s of segments) {
      minX = Math.min(minX, s.startX, s.endX); maxX = Math.max(maxX, s.startX, s.endX);
      minY = Math.min(minY, s.startY, s.endY); maxY = Math.max(maxY, s.startY, s.endY);
      sumLen += Math.hypot(s.endX - s.startX, s.endY - s.startY);
    }
    this.minX = minX - GRID_PAD;
    this.minY = minY - GRID_PAD;
    const w = maxX - minX + 2 * GRID_PAD, h = maxY - minY + 2 * GRID_PAD;
    // About one average segment per cell, at most ~1M cells.
    let cell = Math.max(sumLen / Math.max(1, segments.length), 4 * TOLERANCE);
    cell = Math.max(cell, Math.sqrt((w * h) / 1e6));
    this.cell = cell;
    this.cols = Math.floor(w / cell) + 1;
    this.rows = Math.floor(h / cell) + 1;
    this.stamp = new Int32Array(segments.length);

    for (let i = 0; i < segments.length; i++) {
      const s = segments[i];
      const [c0, r0, c1, r1] = this.range(
        Math.min(s.startX, s.endX) - GRID_PAD, Math.min(s.startY, s.endY) - GRID_PAD,
        Math.max(s.startX, s.endX) + GRID_PAD, Math.max(s.startY, s.endY) + GRID_PAD,
      );
      if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_SEGMENT) {
        this.bigSegments.push(i);
      } else {
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) push(this.segCells, r * this.cols + c, i);
        }
      }
      push(this.epCells, this.cellOf(s.startX, s.startY), 2 * i);
      push(this.epCells, this.cellOf(s.endX, s.endY), 2 * i + 1);
    }
  }

  private col(x: number): number {
    return Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
  }

  private row(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
  }

  private cellOf(x: number, y: number): number {
    return this.row(y) * this.cols + this.col(x);
  }

  private range(x0: number, y0: number, x1: number, y1: number): [number, number, number, number] {
    return [this.col(x0), this.row(y0), this.col(x1), this.row(y1)];
  }

  /** Endpoint indices that may lie within the padded bbox of `s`, ascending. */
  endpointsNear(s: Segment): number[] {
    const [c0, r0, c1, r1] = this.range(
      Math.min(s.startX, s.endX) - GRID_PAD, Math.min(s.startY, s.endY) - GRID_PAD,
      Math.max(s.startX, s.endX) + GRID_PAD, Math.max(s.startY, s.endY) + GRID_PAD,
    );
    const out: number[] = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.epCells.get(r * this.cols + c);
        if (list) for (const e of list) out.push(e);
      }
    }
    return out.sort((a, b) => a - b);
  }

  /** Segment indices whose padded bbox may overlap that of `s`, ascending. */
  segmentsNear(s: Segment): number[] {
    const [c0, r0, c1, r1] = this.range(
      Math.min(s.startX, s.endX) - GRID_PAD, Math.min(s.startY, s.endY) - GRID_PAD,
      Math.max(s.startX, s.endX) + GRID_PAD, Math.max(s.startY, s.endY) + GRID_PAD,
    );
    const stamp = ++this.stampValue;
    const out: number[] = [];
    const add = (j: number) => {
      if (this.stamp[j] === stamp) return;
      this.stamp[j] = stamp;
      out.push(j);
    };
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_CELLS_PER_SEGMENT) {
      // A huge query: cheaper to scan everything.
      for (let j = 0; j < this.stamp.length; j++) add(j);
      return out;
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const list = this.segCells.get(r * this.cols + c);
        if (list) for (const j of list) add(j);
      }
    }
    for (const j of this.bigSegments) add(j);
    return out.sort((a, b) => a - b);
  }
}

function push(map: Map<number, number[]>, key: number, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

// ─── Split at T-junctions + crossings ──────────────────────────────────────

function splitAtIntersections(segments: Segment[]): Segment[] {
  let result = [...segments];
  let changed = true;

  while (changed) {
    changed = false;

    const grid = new SegmentGrid(result);
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

      // (a) T-junctions — every segment endpoint, in segment order
      for (const e of grid.endpointsNear(seg)) {
        const src = result[e >> 1];
        const epX = e & 1 ? src.endX : src.startX;
        const epY = e & 1 ? src.endY : src.startY;
        if (Math.abs(epX - seg.startX) < TOLERANCE && Math.abs(epY - seg.startY) < TOLERANCE) continue;
        if (Math.abs(epX - seg.endX) < TOLERANCE && Math.abs(epY - seg.endY) < TOLERANCE) continue;

        const t = ((epX - seg.startX) * dx + (epY - seg.startY) * dy) / lenSq;
        if (t <= TOLERANCE || t >= 1 - TOLERANCE) continue;

        const closestX = seg.startX + t * dx;
        const closestY = seg.startY + t * dy;
        const dxe = epX - closestX, dye = epY - closestY;
        if (dxe * dxe + dye * dye < TOLERANCE * TOLERANCE) {
          splitPoints.push({ x: epX, y: epY, t });
        }
      }

      // (b) Proper crossings
      for (const j of grid.segmentsNear(seg)) {
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
  // Vertices bucketed by TOLERANCE-sized cells: a match (|dx|, |dy| < TOL)
  // sits in the 3×3 neighbourhood (5×5 searched, for floor() rounding). The
  // earliest-created match wins, same as a linear scan in creation order.
  const buckets = new Map<string, Vertex[]>();
  const cellKey = (cx: number, cy: number) => `${cx},${cy}`;

  function findOrCreateVertex(x: number, y: number): Vertex {
    const cx = Math.floor(x / TOLERANCE), cy = Math.floor(y / TOLERANCE);
    let found: Vertex | null = null;
    for (let i = -2; i <= 2; i++) {
      for (let j = -2; j <= 2; j++) {
        const list = buckets.get(cellKey(cx + i, cy + j));
        if (!list) continue;
        for (const v of list) {
          if (found && v.index >= found.index) break; // lists are in creation order
          if (Math.abs(v.x - x) < TOLERANCE && Math.abs(v.y - y) < TOLERANCE) found = v;
        }
      }
    }
    if (found) return found;
    const v: Vertex = { x, y, index: vertices.length, outgoing: [] };
    vertices.push(v);
    const key = cellKey(cx, cy);
    const list = buckets.get(key);
    if (list) list.push(v);
    else buckets.set(key, [v]);
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
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < polygon.length; i++) {
      const j = (i + 1) % polygon.length;
      signedArea += polygon[i].x * polygon[j].y;
      signedArea -= polygon[j].x * polygon[i].y;
      const p = polygon[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    signedArea /= 2;

    faces.push({ polygon, signedArea, minX, minY, maxX, maxY });
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
