/**
 * Boundaries picked from walls (Revit "Pick Walls" for floors, roofs and
 * ceilings): the loop of walls under the cursor, moved to the chosen wall
 * face (interior finish, core, centre line or exterior), plus an overhang.
 *
 *  - click on a wall → the outer loop of the wall network it belongs to
 *    (the whole building outline);
 *  - click inside a closed room of walls → that room's loop.
 */
import type { LineElement, Point } from '../model/elements.ts';
import type { TypeCatalog } from '../model/types/catalog.ts';
import { resolvedLayers } from '../model/types/catalog.ts';
import { layerBands } from './layerBands.ts';
import { deriveOuterBoundaries, getSpaceFaceGraph, findSpaceBoundary } from './spaceBoundary.ts';
import { matchRoomEdges, signedArea, type RoomEdge } from './roomArea.ts';

export type BoundaryFace = 'interior' | 'core' | 'centerline' | 'core_exterior' | 'exterior';
export const BOUNDARY_FACES: BoundaryFace[] = ['interior', 'core', 'centerline', 'core_exterior', 'exterior'];

export interface PickedLoop {
  /** Centre-line loop, counter-clockwise (inside on the left). */
  outline: Point[];
  /** Its edges with the wall each lies on. */
  edges: RoomEdge[];
  /** Picked by clicking a wall (outer loop) rather than inside a room. */
  outer: boolean;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Point on (or within half its thickness + `tol` of) a wall's body. */
function wallUnder(p: Point, walls: LineElement[], tol: number): LineElement | null {
  let best: LineElement | null = null, bestD = Infinity;
  for (const w of walls) {
    const d = distToSegment(p, w.start, w.end);
    if (d <= (w.strokeWidth || 0) / 2 + tol && d < bestD) { best = w; bestD = d; }
  }
  return best;
}

/** Merge consecutive collinear edges on the same wall (face tracing splits at T-junctions). */
function mergeCollinear(outline: Point[]): Point[] {
  const out = [...outline];
  let changed = true;
  while (changed && out.length > 3) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; i++) {
      const a = out[(i + out.length - 1) % out.length], b = out[i], c = out[(i + 1) % out.length];
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
      if (Math.abs(cross) < 1e-9 && dot > 0) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}

/**
 * The wall loop picked at `p`. `walls`: wall-like lines of the level; with
 * `allowOuter` false only a room loop is taken (ceilings).
 */
export function pickLoop(p: Point, walls: LineElement[], opts: { allowOuter?: boolean; tol?: number } = {}): PickedLoop | null {
  const tol = opts.tol ?? 0.05;
  const hit = opts.allowOuter === false ? null : wallUnder(p, walls, tol);
  let outline: Point[] | null = null;
  let outer = false;
  if (hit) {
    const loops = deriveOuterBoundaries(walls);
    let best: Point[] | null = null;
    for (const loop of loops) {
      const onLoop = loop.some((a, i) => {
        const b = loop[(i + 1) % loop.length];
        return distToSegment(hit.start, a, b) < 0.02 && distToSegment(hit.end, a, b) < 0.02;
      }) || loop.some((a, i) => distToSegment({ x: (hit.start.x + hit.end.x) / 2, y: (hit.start.y + hit.end.y) / 2 }, a, loop[(i + 1) % loop.length]) < 0.02);
      if (onLoop && (!best || Math.abs(signedArea(loop)) > Math.abs(signedArea(best)))) best = loop;
    }
    // A wall inside the building (not on its outline): the loop around the whole network.
    if (!best) {
      for (const loop of loops) {
        if (!best || Math.abs(signedArea(loop)) > Math.abs(signedArea(best))) {
          if (pointInLoop(p, loop)) best = loop;
        }
      }
    }
    if (best) { outline = best; outer = true; }
  }
  if (!outline) outline = findSpaceBoundary(getSpaceFaceGraph(walls), p);
  if (!outline || outline.length < 3) return null;
  let ring = mergeCollinear(outline);
  if (signedArea(ring) < 0) ring = ring.slice().reverse();
  return { outline: ring, edges: matchRoomEdges(ring, walls), outer };
}

function pointInLoop(p: Point, poly: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/**
 * Inward distance (towards the loop's inside) from a wall's centre line to
 * the chosen face. `roomOnLeft`: the inside lies on the wall's left.
 */
export function faceDistance(face: BoundaryFace, wall: LineElement | null, roomOnLeft: boolean, types?: TypeCatalog): number {
  if (!wall || wall.tableName === 'room_separator') return 0;
  const half = (wall.strokeWidth || 0) / 2;
  switch (face) {
    case 'centerline': return 0;
    case 'exterior': return -half;
    case 'interior': return half;
    case 'core':
    case 'core_exterior': {
      const layers = resolvedLayers(wall, types);
      const core = layers ? layerBands(layers, wall.strokeWidth).filter(b => b.function === 'core') : [];
      // No layers: the whole wall is core
      if (core.length === 0) return face === 'core' ? half : -half;
      const lo = Math.min(...core.map(b => b.lo)), hi = Math.max(...core.map(b => b.hi));
      // The core face on the inside: left normal offsets, inside on the left → hi.
      // core_exterior (Revit "Extend into wall (to core)"): the core's outer face.
      if (face === 'core') return roomOnLeft ? hi : -lo;
      return roomOnLeft ? lo : -hi;
    }
  }
}

/** Offset each edge inward by `dist[i]`, re-intersecting the corners (steps where parallel). */
export function offsetLoop(edges: RoomEdge[], dist: number[]): Point[] | null {
  const n = edges.length;
  if (n < 3) return null;
  const lines = edges.map((e, i) => {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
    const l = Math.hypot(dx, dy) || 1;
    const nx = -dy / l, ny = dx / l; // CCW loop: inside on the left
    return { p: { x: e.a.x + nx * dist[i], y: e.a.y + ny * dist[i] }, u: { x: dx / l, y: dy / l }, n: { x: nx, y: ny }, d: dist[i], a: e.a };
  });
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const L1 = lines[(i + n - 1) % n], L2 = lines[i];
    const den = L1.u.x * L2.u.y - L1.u.y * L2.u.x;
    if (Math.abs(den) < 1e-9) {
      // Collinear neighbours: a step when their offsets differ.
      if (Math.abs(L1.d - L2.d) > 1e-9) out.push({ x: L2.a.x + L1.n.x * L1.d, y: L2.a.y + L1.n.y * L1.d });
      out.push(L2.p);
      continue;
    }
    const t = ((L2.p.x - L1.p.x) * L2.u.y - (L2.p.y - L1.p.y) * L2.u.x) / den;
    out.push({ x: L1.p.x + L1.u.x * t, y: L1.p.y + L1.u.y * t });
  }
  if (!(Math.abs(signedArea(out)) > 1e-6) || signedArea(out) < 0) return null;
  return mergeCollinear(out);
}

/** Loop moved to `face`, then out by `extra` (an overhang, metres). */
export function boundaryAt(loop: PickedLoop, face: BoundaryFace, types?: TypeCatalog, extra = 0): Point[] | null {
  const dist = loop.edges.map(e => {
    if (!e.wall) return -extra;
    const w = e.wall;
    const ex = e.b.x - e.a.x, ey = e.b.y - e.a.y;
    const wx = w.end.x - w.start.x, wy = w.end.y - w.start.y;
    // Inside normal of the edge (−ey, ex) against the wall's left normal (−wy, wx).
    const roomOnLeft = ey * wy + ex * wx > 0;
    return faceDistance(face, w, roomOnLeft, types) - extra;
  });
  return offsetLoop(loop.edges, dist);
}

// ─── Associated boundaries (boundary_walls) ─────────────────────────────────
// A floor / roof / ceiling made by picking walls keeps their ids
// (`boundary_walls`), the face (`boundary_face`) and the outward offset
// (`boundary_offset`, a roof's overhang); its outline is rebuilt from those
// walls when they move, flip or change thickness.

export const BOUNDED_TABLES = new Set(['slab', 'structure_slab', 'roof', 'ceiling']);

export const boundaryWallIds = (attrs: Record<string, string>): string[] =>
  (attrs.boundary_walls ?? '').split(';').map(s => s.trim()).filter(Boolean);

/** The wall ids a picked loop runs along, in loop order. */
export function loopWallIds(loop: PickedLoop): string[] {
  const out: string[] = [];
  for (const e of loop.edges) if (e.wall && !out.includes(e.wall.id)) out.push(e.wall.id);
  return out;
}

/** A point inside a polygon: its centroid when inside, else just inside its first long edge. */
function insidePoint(poly: Point[]): Point | null {
  if (poly.length < 3) return null;
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const c = p.x * q.y - q.x * p.y;
    a += c; cx += (p.x + q.x) * c; cy += (p.y + q.y) * c;
  }
  if (Math.abs(a) > 1e-12) {
    const c = { x: cx / (3 * a), y: cy / (3 * a) };
    if (pointInLoop(c, poly)) return c;
  }
  const sign = a >= 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    const l = Math.hypot(q.x - p.x, q.y - p.y);
    if (l < 1e-6) continue;
    const m = { x: (p.x + q.x) / 2 - sign * (q.y - p.y) / l * 0.05, y: (p.y + q.y) / 2 + sign * (q.x - p.x) / l * 0.05 };
    if (pointInLoop(m, poly)) return m;
  }
  return null;
}

/**
 * The loop of `walls` (the associated ones, as they are now) around `seed`:
 * the face of their own network containing it, else their outer outline.
 */
export function loopOfWalls(walls: LineElement[], seed: Point | null): PickedLoop | null {
  if (walls.length < 2) return null;
  let outline = seed ? findSpaceBoundary(getSpaceFaceGraph(walls), seed) : null;
  let outer = false;
  if (!outline || outline.length < 3) {
    let best: Point[] | null = null;
    for (const loop of deriveOuterBoundaries(walls)) if (!best || Math.abs(signedArea(loop)) > Math.abs(signedArea(best))) best = loop;
    outline = best;
    outer = true;
  }
  if (!outline || outline.length < 3) return null;
  let ring = mergeCollinear(outline);
  if (signedArea(ring) < 0) ring = ring.slice().reverse();
  return { outline: ring, edges: matchRoomEdges(ring, walls), outer };
}

/** Default face of a wall-bounded table. */
export const defaultBoundaryFace = (table: string): BoundaryFace =>
  (table === 'roof' ? 'exterior' : table === 'ceiling' ? 'interior' : 'core');

/**
 * The outline of a wall-bounded element rebuilt from its `boundary_walls`
 * (looked up in `wallsById`), or null when they no longer close a loop.
 */
export function rebuildBoundary(
  host: { tableName: string; vertices: Point[]; attrs: Record<string, string> },
  wallsById: (id: string) => LineElement | undefined,
  types?: TypeCatalog,
): Point[] | null {
  const walls = boundaryWallIds(host.attrs).map(wallsById).filter((w): w is LineElement => !!w);
  const loop = loopOfWalls(walls, insidePoint(host.vertices));
  if (!loop) return null;
  const face = (BOUNDARY_FACES as string[]).includes(host.attrs.boundary_face) ? host.attrs.boundary_face as BoundaryFace : defaultBoundaryFace(host.tableName);
  const offset = parseFloat(host.attrs.boundary_offset ?? '') || 0;
  const out = boundaryAt(loop, face, types, offset);
  return out && out.length >= 3 ? out : null;
}
