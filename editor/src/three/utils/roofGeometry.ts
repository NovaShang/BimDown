import { BufferGeometry, Float32BufferAttribute, Vector2 } from 'three';
import { ShapeUtils } from 'three';
import type { ExtrudeParams } from './elementTo3D.ts';
import { createExtrudeGeometry } from './extrudePolygon.ts';

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
function computeOBB(vertices: { x: number; y: number }[]): OBB {
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

/** Get the span-direction coordinate of a vertex. */
function spanCoord(v: { x: number; y: number }, obb: OBB): number {
  return obb.ridgeAlongX ? v.y : v.x;
}

/**
 * Insert new vertices where polygon edges cross given span-direction cut lines.
 * This ensures the triangulation has vertices at ridge/break lines.
 */
function insertCutVertices(
  vertices: { x: number; y: number }[],
  obb: OBB,
  cutPositions: number[], // absolute span-direction coordinates to cut at
): { x: number; y: number }[] {
  const result: { x: number; y: number }[] = [];
  const n = vertices.length;

  for (let i = 0; i < n; i++) {
    const a = vertices[i];
    const b = vertices[(i + 1) % n];
    result.push(a);

    const aS = spanCoord(a, obb);
    const bS = spanCoord(b, obb);
    const lo = Math.min(aS, bS);
    const hi = Math.max(aS, bS);

    // Collect all cuts that cross this edge, sorted by parameter t
    const cuts: { t: number }[] = [];
    for (const cutPos of cutPositions) {
      if (cutPos > lo + 0.0001 && cutPos < hi - 0.0001) {
        const t = (cutPos - aS) / (bS - aS);
        cuts.push({ t });
      }
    }
    // Sort by t so insertions are in order along the edge
    cuts.sort((a, b) => a.t - b.t);

    for (const { t } of cuts) {
      result.push({
        x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y),
      });
    }
  }

  return result;
}

/** Triangulate a 2D polygon using ShapeUtils (requires Vector2). */
function triangulate(vertices: { x: number; y: number }[]): number[] {
  const contour = vertices.map(v => new Vector2(v.x, v.y));
  const faces = ShapeUtils.triangulateShape(contour, []);
  const indices: number[] = [];
  for (const [a, b, c] of faces) indices.push(a, b, c);
  return indices;
}

/** Compute normalized span position (0..1) for a vertex. */
function spanT(v: { x: number; y: number }, obb: OBB): number {
  const val = spanCoord(v, obb);
  return obb.span > 0.001 ? (val - obb.spanMin) / obb.span : 0.5;
}

/** Compute normalized ridge position (0..1) for a vertex. */
function ridgeT(v: { x: number; y: number }, obb: OBB): number {
  const val = obb.ridgeAlongX ? v.x : v.y;
  return obb.ridgeLen > 0.001 ? (val - obb.ridgeMin) / obb.ridgeLen : 0.5;
}

/**
 * Compute top-surface elevation above baseY for a vertex, based on roof type.
 */
function roofElevation(
  sT: number, rT: number,
  thickness: number, slopeDeg: number,
  span: number, ridgeLen: number,
  roofType: string,
): number {
  const tanSlope = Math.tan((slopeDeg * Math.PI) / 180);
  const halfSpan = span / 2;

  switch (roofType) {
    case 'shed':
      return thickness + sT * span * tanSlope;

    case 'gable': {
      const distFromCenter = Math.abs(sT - 0.5) * 2; // 0 at ridge, 1 at eaves
      return thickness + (1 - distFromCenter) * halfSpan * tanSlope;
    }

    case 'hip': {
      const spanRise = (1 - Math.abs(sT - 0.5) * 2) * halfSpan * tanSlope;
      // Taper at ridge ends: hip lines from corners meet ridge
      const hipInset = Math.min(halfSpan / ridgeLen, 0.5); // normalized inset
      let rFactor = 1;
      if (rT < hipInset) rFactor = rT / hipInset;
      else if (rT > 1 - hipInset) rFactor = (1 - rT) / hipInset;
      return thickness + spanRise * rFactor;
    }

    case 'mansard': {
      const mansardBand = 0.3;
      const steepTan = Math.tan((Math.min(slopeDeg + 20, 70) * Math.PI) / 180);
      const bandWidth = halfSpan * mansardBand;
      const distFromEdge = Math.min(sT, 1 - sT) * span;
      if (distFromEdge < bandWidth) {
        return thickness + distFromEdge * steepTan;
      }
      return thickness + bandWidth * steepTan;
    }

    default:
      return thickness;
  }
}

/**
 * Determine which span-direction cut lines are needed for a roof type.
 * Returns absolute span coordinates where edges should be split.
 */
function getCutPositions(obb: OBB, roofType: string): number[] {
  const mid = (obb.spanMin + obb.spanMax) / 2;
  switch (roofType) {
    case 'gable':
    case 'hip':
      return [mid];
    case 'mansard': {
      const band = 0.3;
      const lo = obb.spanMin + obb.span * band;
      const hi = obb.spanMax - obb.span * band;
      return [lo, mid, hi];
    }
    default:
      return [];
  }
}

/**
 * Create a 3D roof geometry from polygon footprint + roof parameters.
 * Flat/zero-slope → simple extrusion. Sloped → custom mesh with ridge vertices.
 */
export function createRoofGeometry(params: ExtrudeParams): BufferGeometry | null {
  const { vertices, baseY, height, roofType = 'flat', slopeDeg = 0 } = params;
  if (vertices.length < 3) return null;

  // Flat roof or zero slope → simple extrusion (same as slab)
  if (roofType === 'flat' || slopeDeg === 0) {
    return createExtrudeGeometry(params);
  }

  const obb = computeOBB(vertices);

  // Insert ridge/break-line vertices so triangulation captures the peak
  const cutPositions = getCutPositions(obb, roofType);
  const augmented = cutPositions.length > 0
    ? insertCutVertices(vertices, obb, cutPositions)
    : vertices;
  const n = augmented.length;

  // Compute top elevation for each augmented vertex
  const topElevs: number[] = [];
  for (const v of augmented) {
    topElevs.push(
      roofElevation(spanT(v, obb), ridgeT(v, obb), height, slopeDeg, obb.span, obb.ridgeLen, roofType),
    );
  }

  // Triangulate the 2D polygon
  const triIndices = triangulate(augmented);
  if (triIndices.length === 0) return null;

  const positions: number[] = [];
  const normals: number[] = [];

  // --- Bottom face (flat at baseY, normal down) ---
  for (let i = triIndices.length - 3; i >= 0; i -= 3) {
    const i0 = triIndices[i], i1 = triIndices[i + 1], i2 = triIndices[i + 2];
    for (const idx of [i2, i1, i0]) {
      positions.push(augmented[idx].x, baseY, -augmented[idx].y);
      normals.push(0, -1, 0);
    }
  }

  // --- Top face (sloped, per-face normals) ---
  for (let i = 0; i < triIndices.length; i += 3) {
    const i0 = triIndices[i], i1 = triIndices[i + 1], i2 = triIndices[i + 2];
    const v = [i0, i1, i2].map(idx => ({
      x: augmented[idx].x,
      y: baseY + topElevs[idx],
      z: -augmented[idx].y,
    }));

    // Face normal via cross product
    const ax = v[1].x - v[0].x, ay = v[1].y - v[0].y, az = v[1].z - v[0].z;
    const bx = v[2].x - v[0].x, by = v[2].y - v[0].y, bz = v[2].z - v[0].z;
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= len; ny /= len; nz /= len;
    if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }

    for (const p of v) {
      positions.push(p.x, p.y, p.z);
      normals.push(nx, ny, nz);
    }
  }

  // --- Side faces (quads connecting bottom edge to top edge) ---
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const b0x = augmented[i].x, b0z = -augmented[i].y;
    const b1x = augmented[j].x, b1z = -augmented[j].y;
    const t0y = baseY + topElevs[i];
    const t1y = baseY + topElevs[j];

    // Outward normal (perpendicular to edge in XZ plane)
    const edx = b1x - b0x, edz = b1z - b0z;
    const el = Math.sqrt(edx * edx + edz * edz) || 1;
    const snx = -edz / el, snz = edx / el;

    // Tri 1: bot-i, bot-j, top-j
    positions.push(b0x, baseY, b0z, b1x, baseY, b1z, b1x, t1y, b1z);
    normals.push(snx, 0, snz, snx, 0, snz, snx, 0, snz);
    // Tri 2: bot-i, top-j, top-i
    positions.push(b0x, baseY, b0z, b1x, t1y, b1z, b0x, t0y, b0z);
    normals.push(snx, 0, snz, snx, 0, snz, snx, 0, snz);
  }

  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return geo;
}
