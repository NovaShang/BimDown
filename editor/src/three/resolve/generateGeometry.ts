import { Shape, ExtrudeGeometry, type BufferGeometry } from 'three';
import type { SurfacePrimitive } from '../primitives/types.ts';
import { applyOpenings } from './csg.ts';

/**
 * Convert a resolved SurfacePrimitive to a BufferGeometry ready for rendering.
 * - Uses prebuilt geometry if provided (e.g., pitched roofs).
 * - Otherwise extrudes footprint along extrudeDirection (currently only vertical supported).
 * - Applies opening CSG subtractions via resolve/csg.ts.
 *
 * Returns null if footprint has fewer than 3 vertices.
 */
export function generateSurfaceGeometry(prim: SurfacePrimitive): BufferGeometry | null {
  if (prim.footprint.length < 3) return null;

  let geo: BufferGeometry;
  if (prim.prebuilt) {
    geo = prim.prebuilt;
  } else {
    const g = extrudeFootprint(prim);
    if (!g) return null;
    geo = g;
  }

  if (prim.openings && prim.openings.length > 0) {
    geo = applyOpenings(geo, prim);
  }

  return geo;
}

/**
 * Extrude the 2D footprint (SVG XY space) along extrudeDirection.
 * Footprint is treated as a shape in XY, then rotated so Y→Z (becoming XZ in world),
 * and translated to origin.y. Height measured along extrudeDirection (Y for walls/slabs).
 */
function extrudeFootprint(prim: SurfacePrimitive): BufferGeometry | null {
  const shape = new Shape();
  const verts = prim.footprint;
  shape.moveTo(verts[0].x, verts[0].y);
  for (let i = 1; i < verts.length; i++) {
    shape.lineTo(verts[i].x, verts[i].y);
  }
  shape.closePath();

  const geo = new ExtrudeGeometry(shape, { depth: prim.height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(prim.origin.x, prim.origin.y, prim.origin.z);
  return geo;
}
