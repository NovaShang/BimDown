import { Shape, ExtrudeGeometry, type BufferGeometry } from 'three';
import type { ExtrudeParams } from './elementTo3D.ts';

/** Create an extruded 3D geometry from a 2D polygon footprint + height.
 *  Kept as a standalone util because roofGeometry.ts (flat-roof case) and
 *  DrawingOverlay3D (polygon preview) depend on it. */
export function createExtrudeGeometry(params: ExtrudeParams): BufferGeometry | null {
  if (params.vertices.length < 3) return null;

  const shape = new Shape();
  shape.moveTo(params.vertices[0].x, params.vertices[0].y);
  for (let i = 1; i < params.vertices.length; i++) {
    shape.lineTo(params.vertices[i].x, params.vertices[i].y);
  }
  shape.closePath();

  const geo = new ExtrudeGeometry(shape, { depth: params.height, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, params.baseY, 0);

  return geo;
}
