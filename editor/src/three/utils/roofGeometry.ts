import { BufferGeometry, Float32BufferAttribute, Vector2 } from 'three';
import { ShapeUtils } from 'three';
import type { ExtrudeParams } from './elementTo3D.ts';
import { createExtrudeGeometry } from './extrudePolygon.ts';

type P2 = { x: number; y: number };

interface OBB {
  ridgeAlongX: boolean;
  span: number;
  ridgeLen: number;
  spanMin: number;
  spanMax: number;
  ridgeMin: number;
  ridgeMax: number;
}

/** Compute AABB-based oriented bounding box. Ridge runs along the longer axis. */
function computeOBB(vertices: P2[]): OBB {
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  for (const v of vertices) {
    if (v.x < minX) minX = v.x;
    if (v.x > maxX) maxX = v.x;
    if (v.y < minY) minY = v.y;
    if (v.y > maxY) maxY = v.y;
  }
  const dx = maxX - minX;
  const dy = maxY - minY;
  const ridgeAlongX = dx >= dy;
  return {
    ridgeAlongX,
    span: ridgeAlongX ? dy : dx,
    ridgeLen: ridgeAlongX ? dx : dy,
    spanMin: ridgeAlongX ? minY : minX,
    spanMax: ridgeAlongX ? maxY : maxX,
    ridgeMin: ridgeAlongX ? minX : minY,
    ridgeMax: ridgeAlongX ? maxX : maxY,
  };
}

/** Roof plane: rise above the eave level = a·x + b·y + c. */
interface Plane { a: number; b: number; c: number }

const rise = (p: Plane, v: P2) => p.a * v.x + p.b * v.y + p.c;

/**
 * The roof's slope planes. The top surface is their lower envelope
 * (min over planes), which is exactly how a roof of equal slopes behaves:
 *   shed    — one plane rising across the span
 *   gable   — two planes meeting at the ridge on the mid-span line
 *   hip     — gable + two end planes; hips run 45° from the corners
 *   mansard — steep lower band on both eaves, flat deck in the middle
 */
function roofPlanes(obb: OBB, roofType: string, slopeDeg: number): Plane[] {
  const tan = Math.tan((slopeDeg * Math.PI) / 180);
  // Distance-to-a-bbox-side planes, expressed in plan x / y.
  const fromSpanMin = (k: number): Plane => obb.ridgeAlongX
    ? { a: 0, b: k, c: -k * obb.spanMin } : { a: k, b: 0, c: -k * obb.spanMin };
  const fromSpanMax = (k: number): Plane => obb.ridgeAlongX
    ? { a: 0, b: -k, c: k * obb.spanMax } : { a: -k, b: 0, c: k * obb.spanMax };
  const fromRidgeMin = (k: number): Plane => obb.ridgeAlongX
    ? { a: k, b: 0, c: -k * obb.ridgeMin } : { a: 0, b: k, c: -k * obb.ridgeMin };
  const fromRidgeMax = (k: number): Plane => obb.ridgeAlongX
    ? { a: -k, b: 0, c: k * obb.ridgeMax } : { a: 0, b: -k, c: k * obb.ridgeMax };
  switch (roofType) {
    case 'shed':
      return [fromSpanMin(tan)];
    case 'gable':
      return [fromSpanMin(tan), fromSpanMax(tan)];
    case 'hip':
      return [fromSpanMin(tan), fromSpanMax(tan), fromRidgeMin(tan), fromRidgeMax(tan)];
    case 'mansard': {
      const steep = Math.tan((Math.min(slopeDeg + 20, 70) * Math.PI) / 180);
      const band = (obb.span / 2) * 0.3;
      return [fromSpanMin(steep), fromSpanMax(steep), { a: 0, b: 0, c: band * steep }];
    }
    default:
      return [];
  }
}

function envelope(planes: Plane[], v: P2): number {
  let z = Infinity;
  for (const p of planes) z = Math.min(z, rise(p, v));
  return Math.max(0, z);
}

/** Add a vertex wherever an edge crosses a line where two planes are equal (a possible fold). */
function insertFoldVertices(vertices: P2[], planes: Plane[]): P2[] {
  const out: P2[] = [];
  const n = vertices.length;
  for (let i = 0; i < n; i++) {
    const a = vertices[i], b = vertices[(i + 1) % n];
    out.push(a);
    const ts: number[] = [];
    for (let p = 0; p < planes.length; p++) {
      for (let q = p + 1; q < planes.length; q++) {
        const da = rise(planes[p], a) - rise(planes[q], a);
        const db = rise(planes[p], b) - rise(planes[q], b);
        if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
          const t = da / (da - db);
          if (t > 1e-6 && t < 1 - 1e-6) ts.push(t);
        }
      }
    }
    ts.sort((x, y) => x - y);
    for (const t of ts) out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  }
  return out;
}

/** Sutherland–Hodgman: keep the part of `poly` where f(v) ≤ 0 (f linear). */
function clipHalfPlane(poly: P2[], f: (v: P2) => number): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa <= 1e-9) out.push(a);
    if ((fa < -1e-9 && fb > 1e-9) || (fa > 1e-9 && fb < -1e-9)) {
      const t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/** Facet polygons: the part of the footprint where each plane is the lowest. */
function facetRegions(vertices: P2[], planes: Plane[]): P2[][] {
  if (planes.length <= 1) return [vertices];
  const regions: P2[][] = [];
  for (let i = 0; i < planes.length; i++) {
    let poly = vertices;
    for (let j = 0; j < planes.length && poly.length >= 3; j++) {
      if (j === i) continue;
      poly = clipHalfPlane(poly, v => rise(planes[i], v) - rise(planes[j], v));
    }
    if (poly.length >= 3 && Math.abs(signedArea(poly)) > 1e-9) regions.push(poly);
  }
  return regions;
}

function signedArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

/** Triangulate a 2D polygon using ShapeUtils (requires Vector2); every triangle CCW. */
function triangulate(vertices: P2[]): number[] {
  const contour = vertices.map(v => new Vector2(v.x, v.y));
  const faces = ShapeUtils.triangulateShape(contour, []);
  const indices: number[] = [];
  for (const [a, b, c] of faces) {
    const p = vertices[a], q = vertices[b], r = vertices[c];
    const ccw = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) >= 0;
    if (ccw) indices.push(a, b, c); else indices.push(a, c, b);
  }
  return indices;
}

/**
 * Create a 3D roof geometry from polygon footprint + roof parameters.
 * Flat/zero-slope → simple extrusion. Sloped → closed mesh: flat soffit at
 * baseY, sloped top (one planar facet per roof plane, so ridges and hips are
 * real edges), and vertical eave / gable sides.
 */
export function createRoofGeometry(params: ExtrudeParams): BufferGeometry | null {
  const { baseY, height, roofType = 'flat', slopeDeg = 0 } = params;
  if (params.vertices.length < 3) return null;

  // Flat roof or zero slope → simple extrusion (same as slab)
  if (roofType === 'flat' || slopeDeg === 0) {
    return createExtrudeGeometry(params);
  }

  // Work counter-clockwise so every face below winds outward.
  let vertices = params.vertices.map(v => ({ x: v.x, y: v.y }));
  if (signedArea(vertices) < 0) vertices = vertices.reverse();

  const obb = computeOBB(vertices);
  const planes = roofPlanes(obb, roofType, slopeDeg);
  if (planes.length === 0) return createExtrudeGeometry(params);
  const outline = insertFoldVertices(vertices, planes);
  const top = (v: P2) => baseY + height + envelope(planes, v);

  const positions: number[] = [];
  const normals: number[] = [];
  const tri = (a: [number, number, number], b: [number, number, number], c: [number, number, number]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) return;
    nx /= len; ny /= len; nz /= len;
    positions.push(...a, ...b, ...c);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  };
  // Plan (x, y) at elevation h → three.js world (x, h, −y).
  const w = (v: P2, h: number): [number, number, number] => [v.x, h, -v.y];

  // --- Bottom face (flat at baseY, facing down) ---
  const bottom = triangulate(outline);
  if (bottom.length === 0) return null;
  for (let i = 0; i < bottom.length; i += 3) {
    tri(w(outline[bottom[i + 2]], baseY), w(outline[bottom[i + 1]], baseY), w(outline[bottom[i]], baseY));
  }

  // --- Top faces: each facet triangulated on its own plane ---
  for (const region of facetRegions(outline, planes)) {
    const r = signedArea(region) < 0 ? region.slice().reverse() : region;
    const idx = triangulate(r);
    for (let i = 0; i < idx.length; i += 3) {
      const [a, b, c] = [r[idx[i]], r[idx[i + 1]], r[idx[i + 2]]];
      tri(w(a, top(a)), w(b, top(b)), w(c, top(c)));
    }
  }

  // --- Side faces (quads from the soffit edge up to the roof edge) ---
  const n = outline.length;
  for (let i = 0; i < n; i++) {
    const a = outline[i], b = outline[(i + 1) % n];
    const ta = top(a), tb = top(b);
    tri(w(a, baseY), w(b, baseY), w(b, tb));
    tri(w(a, baseY), w(b, tb), w(a, ta));
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return geo;
}
