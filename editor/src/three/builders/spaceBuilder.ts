import type { CanonicalElement, PolygonElement } from '../../model/elements.ts';
import type { SurfacePrimitive } from '../primitives/types.ts';
import { resolveHeight } from '../utils/elementTo3D.ts';

const DEFAULT_ROOM_HEIGHT = 3.0;

/**
 * Build a SurfacePrimitive for a space element (rendered as wireframe).
 * Height defaults to 3m unless overridden by top_level_id / height attrs.
 */
export function buildSpacePrimitive(
  element: CanonicalElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): SurfacePrimitive | null {
  if (element.geometry !== 'polygon') return null;
  const el = element as PolygonElement;
  if (el.vertices.length < 3) return null;

  const resolved = resolveHeight(el.attrs, levelElevation, levelElevations, DEFAULT_ROOM_HEIGHT);
  const baseY = levelElevation + resolved.baseOffset;

  return {
    kind: 'surface',
    id: `surface:${el.id}`,
    elementId: el.id,
    tableName: el.tableName,
    footprint: el.vertices.map(v => ({ x: v.x, y: v.y })),
    extrudeDirection: { x: 0, y: 1, z: 0 },
    height: resolved.height,
    origin: { x: 0, y: baseY, z: 0 },
    material: 'default',
    wireframe: true,
  };
}
