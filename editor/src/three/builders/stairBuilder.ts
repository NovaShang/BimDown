import type { CanonicalElement, SpatialLineElement } from '../../model/elements.ts';
import type { CompositePrimitive } from '../primitives/types.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';

export function buildStairPrimitive(
  element: CanonicalElement,
): CompositePrimitive | null {
  if (element.geometry !== 'spatial_line') return null;
  const el = element as SpatialLineElement;

  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return null;

  const width = parseFloat(el.attrs.width) || 1.2;
  const stepCount = Math.max(1, parseInt(el.attrs.step_count) || 18);
  const material = resolveBimMaterial(el.attrs.material, el.tableName);

  return {
    kind: 'composite',
    id: `composite:${el.id}`,
    elementId: el.id,
    tableName: el.tableName,
    material,
    rule: {
      type: 'stair',
      start: { x: el.start.x, y: el.start.y },
      end: { x: el.end.x, y: el.end.y },
      startZ: el.startZ,
      endZ: el.endZ,
      width,
      stepCount,
      material,
    },
  };
}
