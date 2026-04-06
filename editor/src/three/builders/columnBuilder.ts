import type { CanonicalElement, PointElement } from '../../model/elements.ts';
import type { InstancePrimitive } from '../primitives/types.ts';
import { shapeFromAttrs } from '../primitives/profiles.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';
import { resolveHeight } from '../utils/elementTo3D.ts';

const DEFAULT_COLUMN_HEIGHT = 3.0;

/**
 * Build an InstancePrimitive for column / structure_column elements.
 * Uses profile extrusion (rect/round/I/T/L/C/cross) of the specified height.
 */
export function buildColumnPrimitive(
  element: CanonicalElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): InstancePrimitive | null {
  if (element.geometry !== 'point') return null;
  const el = element as PointElement;

  const sizeX = parseFloat(el.attrs.size_x) || el.width || 0.3;
  const sizeY = parseFloat(el.attrs.size_y) || el.height || 0.3;
  const shape = el.attrs.shape || 'rect';
  const profile = shapeFromAttrs(shape, sizeX, sizeY);
  const material = resolveBimMaterial(el.attrs.material, el.tableName);

  const { height, baseOffset } = resolveHeight(el.attrs, levelElevation, levelElevations, DEFAULT_COLUMN_HEIGHT);
  const baseY = levelElevation + baseOffset;
  const rotationDeg = parseFloat(el.attrs.rotation || '0');

  return {
    kind: 'instance',
    id: `instance:${el.id}`,
    elementId: el.id,
    tableName: el.tableName,
    position: { x: el.position.x, y: baseY, z: -el.position.y },
    rotation: { x: 0, y: -rotationDeg * Math.PI / 180, z: 0 },
    scale: { x: 1, y: 1, z: 1 },
    source: { type: 'profile', profile, height },
    material,
  };
}
