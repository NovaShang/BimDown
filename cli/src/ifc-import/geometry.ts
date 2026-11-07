/**
 * Product geometry from web-ifc meshes: world-space triangles (IFC Z-up,
 * meters, openings already cut) and the measurements the converters use —
 * plan footprint (polygon union), oriented boxes, principal axis,
 * cross-section extents and roof slopes.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- jsts and web-ifc are untyped */
// @ts-ignore - jsts has no type definitions
import 'jsts/org/locationtech/jts/monkey.js';
// @ts-ignore
import GeometryFactory from 'jsts/org/locationtech/jts/geom/GeometryFactory.js';
// @ts-ignore
import PrecisionModel from 'jsts/org/locationtech/jts/geom/PrecisionModel.js';
// @ts-ignore
import Coordinate from 'jsts/org/locationtech/jts/geom/Coordinate.js';
// @ts-ignore
import CascadedPolygonUnion from 'jsts/org/locationtech/jts/operation/union/CascadedPolygonUnion.js';
// @ts-ignore
import ArrayList from 'jsts/java/util/ArrayList.js';
// @ts-ignore
import DouglasPeuckerSimplifier from 'jsts/org/locationtech/jts/simplify/DouglasPeuckerSimplifier.js';
import type { IfcModel } from './model.js';
import { type V2, type V3, type Obb2, cross3, dot3, len3, minAreaRect, norm3, sub3, polygonArea } from './math.js';

export interface WorldMesh {
  /** xyz triples, IFC world (Z up), meters. */
  positions: Float64Array;
  indices: Uint32Array;
  min: V3;
  max: V3;
}

/** A plan polygon: outer ring (CCW) and holes (CW), open rings. */
export interface PlanPolygon { outer: V2[]; holes: V2[][]; area: number }

const GRID = 1e4; // 0.1 mm precision grid for polygon unions
const factory: any = new GeometryFactory(new PrecisionModel(GRID));

/**
 * Stream the meshes of `ids` into world-space triangle soups. Calls
 * `progress(done, total)` between batches.
 */
export function loadMeshes(model: IfcModel, ids: number[], progress?: (done: number, total: number) => void): Map<number, WorldMesh> {
  const out = new Map<number, WorldMesh>();
  const { api } = model;
  const BATCH = 200;
  for (let start = 0; start < ids.length; start += BATCH) {
    const batch = ids.slice(start, start + BATCH);
    try {
      api.StreamMeshes(model.id, batch, (mesh: any) => {
        const m = flatMeshToWorld(model, mesh);
        if (m) out.set(mesh.expressID, m);
      });
    } catch {
      // A broken representation in the batch: retry one by one.
      for (const id of batch) {
        try {
          api.StreamMeshes(model.id, [id], (mesh: any) => {
            const m = flatMeshToWorld(model, mesh);
            if (m) out.set(mesh.expressID, m);
          });
        } catch { /* skipped: no usable geometry */ }
      }
    }
    progress?.(Math.min(ids.length, start + BATCH), ids.length);
  }
  return out;
}

function flatMeshToWorld(model: IfcModel, mesh: any): WorldMesh | null {
  const { api } = model;
  const parts: { pos: Float64Array; idx: Uint32Array }[] = [];
  let nv = 0, ni = 0;
  const geoms = mesh.geometries;
  for (let g = 0; g < geoms.size(); g++) {
    const placed = geoms.get(g);
    const geo = api.GetGeometry(model.id, placed.geometryExpressID);
    try {
      const verts = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      const idx = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
      const m = placed.flatTransformation as number[];
      const n = verts.length / 6;
      const pos = new Float64Array(n * 3);
      for (let i = 0; i < n; i++) {
        const x = verts[i * 6], y = verts[i * 6 + 1], z = verts[i * 6 + 2];
        const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
        // web-ifc meshes are Y-up: IFC (X, Y, Z) = (x, -z, y)
        pos[i * 3] = wx;
        pos[i * 3 + 1] = -wz;
        pos[i * 3 + 2] = wy;
      }
      parts.push({ pos, idx: new Uint32Array(idx) });
      nv += n;
      ni += idx.length;
    } finally {
      geo.delete?.();
    }
  }
  if (nv === 0 || ni === 0) return null;
  const positions = new Float64Array(nv * 3);
  const indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const p of parts) {
    positions.set(p.pos, vo * 3);
    for (let i = 0; i < p.idx.length; i++) indices[io + i] = p.idx[i] + vo;
    vo += p.pos.length / 3;
    io += p.idx.length;
  }
  return withBounds(positions, indices);
}

export function withBounds(positions: Float64Array, indices: Uint32Array): WorldMesh {
  const min = { x: Infinity, y: Infinity, z: Infinity }, max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2];
    if (x < min.x) min.x = x; if (x > max.x) max.x = x;
    if (y < min.y) min.y = y; if (y > max.y) max.y = y;
    if (z < min.z) min.z = z; if (z > max.z) max.z = z;
  }
  return { positions, indices, min, max };
}

/** Concatenate meshes (e.g. the parts of an aggregate). */
export function mergeMeshes(meshes: WorldMesh[]): WorldMesh | null {
  const list = meshes.filter(Boolean);
  if (list.length === 0) return null;
  if (list.length === 1) return list[0];
  let nv = 0, ni = 0;
  for (const m of list) { nv += m.positions.length; ni += m.indices.length; }
  const positions = new Float64Array(nv);
  const indices = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const m of list) {
    positions.set(m.positions, vo);
    const base = vo / 3;
    for (let i = 0; i < m.indices.length; i++) indices[io + i] = m.indices[i] + base;
    vo += m.positions.length;
    io += m.indices.length;
  }
  return withBounds(positions, indices);
}

export function planPoints(mesh: WorldMesh): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < mesh.positions.length; i += 3) out.push({ x: mesh.positions[i], y: mesh.positions[i + 1] });
  return out;
}

export function planObb(mesh: WorldMesh): Obb2 | null {
  return minAreaRect(planPoints(mesh));
}

/** Vertices with z inside [z0, z1]. */
export function planPointsInBand(mesh: WorldMesh, z0: number, z1: number): V2[] {
  const out: V2[] = [];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) if (p[i + 2] >= z0 && p[i + 2] <= z1) out.push({ x: p[i], y: p[i + 1] });
  return out;
}

// ─── Footprint ───────────────────────────────────────────────────────────────

function snap(v: number): number {
  return Math.round(v * GRID) / GRID;
}

/**
 * Plan silhouette: union of every projected triangle, closed by ±1 mm to
 * remove float gaps, simplified at `tolerance`. Largest polygon first.
 * `zMax` keeps only triangles at or below that height (e.g. a space's floor).
 */
export function footprint(mesh: WorldMesh, tolerance = 0.005, zMax = Infinity): PlanPolygon[] {
  const p = mesh.positions, idx = mesh.indices;
  const tris: any[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    if (Math.min(p[a + 2], p[b + 2], p[c + 2]) > zMax) continue;
    const ax = snap(p[a]), ay = snap(p[a + 1]), bx = snap(p[b]), by = snap(p[b + 1]), cx = snap(p[c]), cy = snap(p[c + 1]);
    const area2 = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
    if (Math.abs(area2) < 2e-7) continue; // vertical face or sliver
    const ring = area2 > 0
      ? [new Coordinate(ax, ay), new Coordinate(bx, by), new Coordinate(cx, cy), new Coordinate(ax, ay)]
      : [new Coordinate(ax, ay), new Coordinate(cx, cy), new Coordinate(bx, by), new Coordinate(ax, ay)];
    tris.push(factory.createPolygon(factory.createLinearRing(ring)));
  }
  if (tris.length === 0) return [];
  let g: any;
  try {
    g = CascadedPolygonUnion.union(toJavaList(tris));
    g = g.buffer(0.001, 2).buffer(-0.001, 2);
  } catch {
    try {
      g = factory.createMultiPolygon(tris).buffer(0.001, 2).buffer(-0.001, 2);
    } catch {
      return [];
    }
  }
  if (tolerance > 0) g = DouglasPeuckerSimplifier.simplify(g, tolerance);
  return polygonsOf(g).sort((a, b) => b.area - a.area);
}

/** CascadedPolygonUnion.union takes a java.util.Collection. */
function toJavaList(items: any[]): any {
  const list = new (ArrayList as any)();
  for (const it of items) list.add(it);
  return list;
}

function ringOf(ls: any): V2[] {
  const cs = ls.getCoordinates();
  const out: V2[] = [];
  for (let i = 0; i < cs.length - 1; i++) out.push({ x: cs[i].x, y: cs[i].y });
  return out;
}

function polygonsOf(g: any): PlanPolygon[] {
  const out: PlanPolygon[] = [];
  const n = g.getNumGeometries();
  for (let i = 0; i < n; i++) {
    const poly = g.getGeometryN(i);
    if (poly.getGeometryType() !== 'Polygon' || poly.isEmpty()) continue;
    let outer = ringOf(poly.getExteriorRing());
    if (polygonArea(outer) < 0) outer = outer.reverse();
    const holes: V2[][] = [];
    for (let h = 0; h < poly.getNumInteriorRing(); h++) {
      let ring = ringOf(poly.getInteriorRingN(h));
      if (Math.abs(polygonArea(ring)) < 0.01) continue; // drop holes under 100 cm²
      if (polygonArea(ring) > 0) ring = ring.reverse();
      holes.push(ring);
    }
    if (outer.length >= 3) out.push({ outer, holes, area: poly.getArea() });
  }
  return out;
}

function jstsPolygon(poly: PlanPolygon): any {
  const shell = factory.createLinearRing([...poly.outer, poly.outer[0]].map(p => new Coordinate(p.x, p.y)));
  const holes = poly.holes.map(h => factory.createLinearRing([...h, h[0]].map(p => new Coordinate(p.x, p.y))));
  return factory.createPolygon(shell, holes);
}

/** A plan obstacle for seed placement: a line with a half width. */
export interface Obstacle { a: V2; b: V2; half: number }

/**
 * A seed point for a room: inside `poly`, in its largest part once the
 * walls crossing it are cut out (so the seed lands in the main room, not in
 * a cubicle or on a wall the IFC space spans).
 */
export function seedPoint(poly: PlanPolygon, obstacles: Obstacle[]): V2 {
  let g = jstsPolygon(poly);
  try {
    const env = g.getEnvelopeInternal();
    const cut: any[] = [];
    for (const o of obstacles) {
      if (Math.max(o.a.x, o.b.x) < env.getMinX() - 1 || Math.min(o.a.x, o.b.x) > env.getMaxX() + 1) continue;
      if (Math.max(o.a.y, o.b.y) < env.getMinY() - 1 || Math.min(o.a.y, o.b.y) > env.getMaxY() + 1) continue;
      const ls = factory.createLineString([new Coordinate(o.a.x, o.a.y), new Coordinate(o.b.x, o.b.y)]);
      cut.push(ls.buffer(o.half + 0.05, 2));
    }
    if (cut.length) {
      const rest = g.difference(CascadedPolygonUnion.union(toJavaList(cut)));
      const parts = polygonsOf(rest).sort((x, y) => y.area - x.area);
      if (parts.length && parts[0].area > 0.05) return interiorPoint(parts[0]);
    }
  } catch { /* fall back to the plain interior point */ }
  return interiorPoint(poly);
}

/** A point well inside a polygon (jsts interior point: on the widest horizontal chord). */
export function interiorPoint(poly: PlanPolygon): V2 {
  const g = jstsPolygon(poly);
  // Shrink first so the seed keeps clear of the walls; fall back to the plain interior point.
  for (const d of [0.25, 0.1, 0]) {
    try {
      const inner = d > 0 ? g.buffer(-d) : g;
      if (inner.isEmpty()) continue;
      const c = inner.getInteriorPoint().getCoordinate();
      if (c) return { x: c.x, y: c.y };
    } catch { /* try a smaller inset */ }
  }
  const c = g.getCentroid().getCoordinate();
  return { x: c.x, y: c.y };
}

// ─── Axes and sections ───────────────────────────────────────────────────────

export interface Axis3 { start: V3; end: V3; dir: V3; length: number }

/** Principal axis (PCA of vertices), clipped to the mesh extent along it. */
export function principalAxis(mesh: WorldMesh): Axis3 | null {
  const p = mesh.positions;
  const n = p.length / 3;
  if (n < 2) return null;
  let cx = 0, cy = 0, cz = 0;
  for (let i = 0; i < p.length; i += 3) { cx += p[i]; cy += p[i + 1]; cz += p[i + 2]; }
  cx /= n; cy /= n; cz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i] - cx, y = p[i + 1] - cy, z = p[i + 2] - cz;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  // Power iteration on the covariance matrix
  let v = { x: 1, y: 0.7, z: 0.3 };
  for (let k = 0; k < 64; k++) {
    const w = { x: xx * v.x + xy * v.y + xz * v.z, y: xy * v.x + yy * v.y + yz * v.z, z: xz * v.x + yz * v.y + zz * v.z };
    const l = len3(w);
    if (l < 1e-15) break;
    v = { x: w.x / l, y: w.y / l, z: w.z / l };
  }
  const dir = cleanDir(v);
  let tMin = Infinity, tMax = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const t = (p[i] - cx) * dir.x + (p[i + 1] - cy) * dir.y + (p[i + 2] - cz) * dir.z;
    if (t < tMin) tMin = t; if (t > tMax) tMax = t;
  }
  const c = { x: cx, y: cy, z: cz };
  const start = { x: c.x + dir.x * tMin, y: c.y + dir.y * tMin, z: c.z + dir.z * tMin };
  const end = { x: c.x + dir.x * tMax, y: c.y + dir.y * tMax, z: c.z + dir.z * tMax };
  return { start, end, dir, length: tMax - tMin };
}

/** Snap near-axis directions exactly onto the axis (float noise from PCA). */
function cleanDir(v: V3): V3 {
  const r = { x: Math.abs(v.x) < 1e-4 ? 0 : v.x, y: Math.abs(v.y) < 1e-4 ? 0 : v.y, z: Math.abs(v.z) < 1e-4 ? 0 : v.z };
  return norm3(r);
}

/**
 * Extents of the mesh across an axis: `width` along the horizontal normal,
 * `height` along the in-plane up normal, plus the offsets of the section
 * centre from the axis line (`du` horizontal, `dv` up) and the extent along
 * the axis (`t0`, `t1` from `origin`).
 */
export function sectionExtents(mesh: WorldMesh, origin: V3, dir: V3): {
  width: number; height: number; du: number; dv: number; top: number; t0: number; t1: number;
} {
  const d = norm3(dir);
  // Horizontal normal: up × dir (or X when the axis is vertical)
  let u = cross3({ x: 0, y: 0, z: 1 }, d);
  if (len3(u) < 1e-6) u = { x: 1, y: 0, z: 0 };
  u = norm3(u);
  const v = norm3(cross3(d, u));
  const p = mesh.positions;
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity, tMin = Infinity, tMax = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const q = sub3({ x: p[i], y: p[i + 1], z: p[i + 2] }, origin);
    const pu = dot3(q, u), pv = dot3(q, v), pt = dot3(q, d);
    if (pu < uMin) uMin = pu; if (pu > uMax) uMax = pu;
    if (pv < vMin) vMin = pv; if (pv > vMax) vMax = pv;
    if (pt < tMin) tMin = pt; if (pt > tMax) tMax = pt;
  }
  return { width: uMax - uMin, height: vMax - vMin, du: (uMin + uMax) / 2, dv: (vMin + vMax) / 2, top: vMax, t0: tMin, t1: tMax };
}

/**
 * Upward-facing surface analysis (roofs): area-weighted slope in degrees and
 * the number of distinct downhill directions (1 shed, 2 gable, 4 hip).
 */
export function roofSlopes(mesh: WorldMesh): { slopeDeg: number; directions: number; flatShare: number } {
  const p = mesh.positions, idx = mesh.indices;
  const bins = new Map<number, number>(); // 45° bins of downhill azimuth → area
  let total = 0, flat = 0, slopeSum = 0, slopedArea = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1 = { x: p[b] - p[a], y: p[b + 1] - p[a + 1], z: p[b + 2] - p[a + 2] };
    const e2 = { x: p[c] - p[a], y: p[c + 1] - p[a + 1], z: p[c + 2] - p[a + 2] };
    const nrm = cross3(e1, e2);
    const area = len3(nrm) / 2;
    if (area < 1e-6) continue;
    const nz = nrm.z / (2 * area);
    if (nz <= 0.2) continue; // side faces and the underside
    total += area;
    const slope = (Math.acos(Math.min(1, nz)) * 180) / Math.PI;
    if (slope < 2) { flat += area; continue; }
    slopeSum += slope * area;
    slopedArea += area;
    const az = Math.atan2(nrm.y, nrm.x);
    const bin = ((Math.round(az / (Math.PI / 4)) % 8) + 8) % 8;
    bins.set(bin, (bins.get(bin) ?? 0) + area);
  }
  if (total === 0) return { slopeDeg: 0, directions: 0, flatShare: 1 };
  const significant = [...bins.values()].filter(a => a > slopedArea * 0.08).length;
  return { slopeDeg: slopedArea > 0 ? slopeSum / slopedArea : 0, directions: significant, flatShare: flat / total };
}
