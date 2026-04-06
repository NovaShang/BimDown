import type { CanonicalElement } from '../../model/elements.ts';
import type { PathPrimitive } from '../primitives/types.ts';
import { shapeFromAttrs } from '../primitives/profiles.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';
import { elementToHorizontalPath } from './beamBuilder.ts';

/**
 * Build a PathPrimitive for MEP line elements: duct, pipe, conduit, cable_tray.
 * Profile defaults: round for pipe/conduit, rect for duct/cable_tray (overridable via shape attr).
 */
export function buildMepPrimitive(
  element: CanonicalElement,
  levelElevation: number,
): PathPrimitive | null {
  if (element.geometry !== 'line' && element.geometry !== 'spatial_line') return null;

  const sizeX = parseFloat(element.attrs.size_x) || 0.2;
  const sizeY = parseFloat(element.attrs.size_y) || 0.2;
  const defaultShape = (element.tableName === 'pipe' || element.tableName === 'conduit') ? 'round' : 'rect';
  const shape = element.attrs.shape || defaultShape;
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
