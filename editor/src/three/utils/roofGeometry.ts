import { BufferGeometry, Float32BufferAttribute } from 'three';
import type { ExtrudeParams } from './elementTo3D.ts';
import {
  solveRoof, roofInputFor, roofSolidTriangles, verticalThickness,
  type P2, type RoofSolution, type V3,
} from '../../geometry/roofSolver.ts';

/**
 * Roof slab mesh: underside on the roof planes (geometry/roofSolver.ts) at
 * `baseY` + rise, top a constant vertical thickness above, plumb-cut eaves,
 * gables and holes. A roof without slope is the same slab, flat.
 */
export function roofGeometryFromSolution(
  sol: RoofSolution, outline: P2[], baseY: number, thickness: number, holes: P2[][] = [],
): BufferGeometry | null {
  if (outline.length < 3) return null;
  const vThick = verticalThickness(thickness, sol.maxSlopeDeg);
  return trianglesToGeometry(roofSolidTriangles(sol, outline, baseY, vThick, holes));
}

/** Plan-space triangles (x, y, elevation) → flat-shaded three.js geometry (x, elevation, −y). */
export function trianglesToGeometry(tris: V3[][]): BufferGeometry | null {
  const positions: number[] = [];
  const normals: number[] = [];
  for (const [a, b, c] of tris) {
    const A = [a[0], a[2], -a[1]], B = [b[0], b[2], -b[1]], C = [c[0], c[2], -c[1]];
    const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2];
    const vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-12) continue;
    nx /= len; ny /= len; nz /= len;
    positions.push(...A, ...B, ...C);
    normals.push(nx, ny, nz, nx, ny, nz, nx, ny, nz);
  }
  if (positions.length === 0) return null;
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  return geo;
}

/**
 * Roof from legacy extrude params (roof_type + one slope over the footprint):
 * the same planes the roof element uses when it has no edge_slopes.
 */
export function createRoofGeometry(params: ExtrudeParams): BufferGeometry | null {
  const { baseY, height, roofType = 'flat', slopeDeg = 0 } = params;
  if (params.vertices.length < 3) return null;
  const sol = solveRoof(roofInputFor(params.vertices, { roof_type: roofType, slope: String(slopeDeg) }));
  return roofGeometryFromSolution(sol, params.vertices, baseY, height);
}
