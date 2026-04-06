import type { CanonicalElement, LineElement, SpatialLineElement } from '../../model/elements.ts';
import type { PathPrimitive, Vec3 } from '../primitives/types.ts';
import { shapeFromAttrs } from '../primitives/profiles.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';

/**
 * Build a PathPrimitive for beam / brace elements.
 * Profile derived from shape attribute (rect/round/i/t/l/c/cross).
 * Path is the beam centerline in world coords.
 */
export function buildBeamPrimitive(
  element: CanonicalElement,
  levelElevation: number,
): PathPrimitive | null {
  if (element.geometry !== 'line' && element.geometry !== 'spatial_line') return null;

  const sizeX = parseFloat(element.attrs.size_x) || 0.3;
  const sizeY = parseFloat(element.attrs.size_y) || 0.5;
  const shape = element.attrs.shape || 'rect';
  const profile = shapeFromAttrs(shape, sizeX, sizeY);
  const material = resolveBimMaterial(element.attrs.material, element.tableName);

  const path = elementToHorizontalPath(element, levelElevation);
  if (!path) return null;

  return {
    kind: 'path',
    id: `path:${element.id}`,
    elementId: element.id,
    tableName: element.tableName,
    profile,
    path,
    material,
  };
}

/**
 * Convert a line/spatial_line element to a 3D centerline path.
 * For spatial_line (with start_z/end_z), Y comes from the Z attributes.
 * For line, Y is computed from levelElevation + base_offset.
 */
export function elementToHorizontalPath(
  element: CanonicalElement,
  levelElevation: number,
): [Vec3, Vec3] | null {
  if (element.geometry === 'spatial_line') {
    const el = element as SpatialLineElement;
    const dx = el.end.x - el.start.x;
    const dy = el.end.y - el.start.y;
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return null;
    return [
      { x: el.start.x, y: el.startZ, z: -el.start.y },
      { x: el.end.x,   y: el.endZ,   z: -el.end.y },
    ];
  }
  if (element.geometry === 'line') {
    const el = element as LineElement;
    const dx = el.end.x - el.start.x;
    const dy = el.end.y - el.start.y;
    if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return null;
    const baseOffset = parseFloat(el.attrs.base_offset) || 0;
    const y = levelElevation + baseOffset;
    return [
      { x: el.start.x, y, z: -el.start.y },
      { x: el.end.x,   y, z: -el.end.y },
    ];
  }
  return null;
}
