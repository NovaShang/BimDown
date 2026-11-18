/**
 * Sloped floor (slope arrow) body for IFC and the drawings: the 3D view's
 * geometry (three/utils/slabGeometry.ts) as a faceted brep in world coordinates.
 */
import type { Point } from '../../model/elements.ts';
import type { SlopePlane } from '../../geometry/slabSlope.ts';
import { slabBodyGeometry } from '../../three/utils/slabGeometry.ts';
import { brepFromBuffer } from './geometry.ts';
import type { Solid } from './frame.ts';

export function slopedSlabSolid(
  f: { vertices: Point[]; baseY: number; thickness: number; slope?: SlopePlane | null }, holes: readonly Point[][] = [],
): Solid | null {
  if (!f.slope || f.vertices.length < 3) return null;
  const geo = slabBodyGeometry(f.vertices, f.baseY, f.thickness, holes, f.slope);
  const solid = brepFromBuffer(geo);
  geo.dispose();
  return solid;
}
