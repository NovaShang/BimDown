/**
 * Slab body as a three.js geometry (world Y up, plan y = −Z): the outline
 * extruded `thickness` up from `baseY`, holes in the profile; with a slope
 * plane every vertex rises by the plane at its plan point (vertical
 * thickness, planar faces). Shared by the 3D view, sections and IFC.
 */
import { ExtrudeGeometry, Path, Shape, type BufferGeometry } from 'three';
import type { Point } from '../../model/elements.ts';
import { planeAt, type SlopePlane } from '../../geometry/slabSlope.ts';

export function slabBodyGeometry(
  vertices: readonly Point[], baseY: number, thickness: number, holes: readonly Point[][] = [], slope: SlopePlane | null = null,
): BufferGeometry {
  const shape = new Shape();
  shape.moveTo(vertices[0].x, vertices[0].y);
  for (let i = 1; i < vertices.length; i++) shape.lineTo(vertices[i].x, vertices[i].y);
  shape.closePath();
  for (const h of holes) {
    if (h.length < 3) continue;
    const p = new Path();
    p.moveTo(h[0].x, h[0].y);
    for (let i = 1; i < h.length; i++) p.lineTo(h[i].x, h[i].y);
    p.closePath();
    shape.holes.push(p);
  }
  const geo = new ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, baseY, 0);
  if (slope) {
    const pos = geo.getAttribute('position');
    for (let i = 0; i < pos.count; i++) pos.setY(i, pos.getY(i) + planeAt(slope, pos.getX(i), -pos.getZ(i)));
    pos.needsUpdate = true;
    geo.computeVertexNormals();
  }
  return geo;
}
