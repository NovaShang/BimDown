import type { CanonicalElement, PointElement, SpatialLineElement } from '../../model/elements.ts';
import type { InstancePrimitive } from '../primitives/types.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';
import { resolveHeight } from '../utils/elementTo3D.ts';

const DEFAULT_POINT_HEIGHT = 0.5;

/**
 * Build an InstancePrimitive (box) for point elements: equipment/terminal/mep_node.
 */
export function buildEquipmentPrimitive(
  element: CanonicalElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): InstancePrimitive | null {
  if (element.geometry !== 'point') return null;
  const el = element as PointElement;

  const { height, baseOffset } = resolveHeight(el.attrs, levelElevation, levelElevations, DEFAULT_POINT_HEIGHT);
  const baseY = levelElevation + baseOffset;
  const rotationDeg = parseFloat(el.attrs.rotation || '0');
  const material = resolveBimMaterial(el.attrs.material, el.tableName);

  return {
    kind: 'instance',
    id: `instance:${el.id}`,
    elementId: el.id,
    tableName: el.tableName,
    position: { x: el.position.x, y: baseY + height / 2, z: -el.position.y },
    rotation: { x: 0, y: -rotationDeg * Math.PI / 180, z: 0 },
    scale: { x: el.width, y: height, z: el.height },
    source: { type: 'box' },
    material,
  };
}

/**
 * Build an InstancePrimitive (box) for a ramp element (spatial_line).
 * Renders as a box at min(startZ, endZ), matching current behavior.
 */
export function buildRampPrimitive(
  element: CanonicalElement,
): InstancePrimitive | null {
  if (element.geometry !== 'spatial_line') return null;
  const el = element as SpatialLineElement;
  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const width = parseFloat(el.attrs.width) || 1.2;
  const thickness = 0.15;
  const cx = (el.start.x + el.end.x) / 2;
  const cySvg = (el.start.y + el.end.y) / 2;
  const baseY = Math.min(el.startZ, el.endZ);
  const cy = baseY + thickness / 2;
  const angle = Math.atan2(dy, dx);
  const material = resolveBimMaterial(el.attrs.material, el.tableName);

  return {
    kind: 'instance',
    id: `instance:${element.id}`,
    elementId: element.id,
    tableName: element.tableName,
    position: { x: cx, y: cy, z: -cySvg },
    rotation: { x: 0, y: angle, z: 0 },
    scale: { x: len, y: thickness, z: width },
    source: { type: 'box' },
    material,
  };
}
