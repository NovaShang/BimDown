import type { CanonicalElement, SpatialLineElement } from '../../model/elements.ts';
import type { CompositePrimitive, Vec3 } from '../primitives/types.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';

const DEFAULT_RAILING_HEIGHT = 1.0;
const DEFAULT_BALUSTER_SPACING = 0.12;
const BALUSTER_SIZE = 0.025;
const HANDRAIL_SIZE = 0.04;

export function buildRailingPrimitive(
  element: CanonicalElement,
  levelElevation: number,
): CompositePrimitive | null {
  if (element.geometry !== 'spatial_line' && element.geometry !== 'line') return null;

  let startX: number, startY: number, endX: number, endY: number, startZ: number, endZ: number;
  if (element.geometry === 'spatial_line') {
    const el = element as SpatialLineElement;
    startX = el.start.x; startY = el.start.y;
    endX = el.end.x; endY = el.end.y;
    startZ = el.startZ;
    endZ = el.endZ;
  } else {
    const baseOffset = parseFloat(element.attrs.base_offset) || 0;
    const z = levelElevation + baseOffset;
    startX = element.start.x; startY = element.start.y;
    endX = element.end.x; endY = element.end.y;
    startZ = z;
    endZ = z;
  }

  const dx = endX - startX;
  const dy = endY - startY;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) return null;

  const height = parseFloat(element.attrs.height) || DEFAULT_RAILING_HEIGHT;
  const material = resolveBimMaterial(element.attrs.material, element.tableName);

  const path: Vec3[] = [
    { x: startX, y: startZ, z: -startY },
    { x: endX,   y: endZ,   z: -endY },
  ];

  return {
    kind: 'composite',
    id: `composite:${element.id}`,
    elementId: element.id,
    tableName: element.tableName,
    material,
    rule: {
      type: 'railing',
      path,
      height,
      balusterSpacing: DEFAULT_BALUSTER_SPACING,
      balusterProfile: { kind: 'rect', width: BALUSTER_SIZE, depth: BALUSTER_SIZE },
      handrailProfile: { kind: 'rect', width: HANDRAIL_SIZE, depth: HANDRAIL_SIZE },
      material,
    },
  };
}
