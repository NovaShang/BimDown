import type { CanonicalElement, LineElement } from '../../model/elements.ts';
import type { CompositePrimitive } from '../primitives/types.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';
import { resolveHeight } from '../utils/elementTo3D.ts';

const DEFAULT_WALL_HEIGHT = 3.0;
const MULLION_SIZE = 0.05;
const PANEL_THICKNESS = 0.006;

export function buildCurtainWallPrimitive(
  element: CanonicalElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): CompositePrimitive | null {
  if (element.geometry !== 'line' && element.geometry !== 'spatial_line') return null;
  const el = element as LineElement;

  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  if (len < 0.001) return null;

  const { height, baseOffset } = resolveHeight(el.attrs, levelElevation, levelElevations, DEFAULT_WALL_HEIGHT);
  const baseY = levelElevation + baseOffset;

  const uSpacing = parseFloat(el.attrs.u_spacing) || 0;
  const vSpacing = parseFloat(el.attrs.v_spacing) || 0;
  const uGridCount = uSpacing > 0
    ? Math.max(1, Math.floor(len / uSpacing))
    : Math.max(1, parseInt(el.attrs.u_grid_count) || 3);
  const vGridCount = vSpacing > 0
    ? Math.max(1, Math.floor(height / vSpacing))
    : Math.max(1, parseInt(el.attrs.v_grid_count) || 3);

  // Frame defaults to aluminum even if material attr says glass (matches current behavior)
  const frameMatRaw = resolveBimMaterial(el.attrs.material, el.tableName);
  const frameMaterial = frameMatRaw === 'glass' ? 'aluminum' : frameMatRaw;
  const panelMaterial = resolveBimMaterial(el.attrs.panel_material, el.tableName);

  return {
    kind: 'composite',
    id: `composite:${el.id}`,
    elementId: el.id,
    tableName: el.tableName,
    material: frameMaterial,
    rule: {
      type: 'curtain_wall',
      start: { x: el.start.x, y: el.start.y },
      end: { x: el.end.x, y: el.end.y },
      baseY,
      height,
      uGridCount,
      vGridCount,
      mullionSize: MULLION_SIZE,
      panelThickness: PANEL_THICKNESS,
      frameMaterial,
      panelMaterial,
    },
  };
}
