import type { CanonicalElement, LineElement } from '../../model/elements.ts';
import type { InstancePrimitive } from '../primitives/types.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';

/**
 * Build an InstancePrimitive (box visual) for a door or window element.
 * The opening CSG cut is handled by the host wall's builder — this renders
 * the door panel / window pane sitting in the opening.
 */
export function buildDoorWindowPrimitive(
  element: CanonicalElement,
  levelElevation: number,
): InstancePrimitive | null {
  if (element.geometry !== 'line' && element.geometry !== 'spatial_line') return null;
  const el = element as LineElement;

  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const defaultHeight = el.tableName === 'window' ? 1.2 : 2.1;
  const openingHeight = parseFloat(el.attrs.height) || defaultHeight;
  const baseOffset = parseFloat(el.attrs.base_offset) || 0;
  const baseY = levelElevation + baseOffset;
  const cy = baseY + openingHeight / 2;

  const cx = (el.start.x + el.end.x) / 2;
  const cySvg = (el.start.y + el.end.y) / 2;
  const angle = Math.atan2(dy, dx);

  const thickness = el.strokeWidth || 0.04;
  const material = resolveBimMaterial(el.attrs.material, el.tableName);

  return {
    kind: 'instance',
    id: `instance:${el.id}`,
    elementId: el.id,
    tableName: el.tableName,
    position: { x: cx, y: cy, z: -cySvg },
    rotation: { x: 0, y: angle, z: 0 },
    scale: { x: len, y: openingHeight, z: thickness },
    source: { type: 'box' },
    material,
  };
}
