import type { CanonicalElement, PolygonElement } from '../../model/elements.ts';
import type { SurfacePrimitive } from '../primitives/types.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';
import { createRoofGeometry } from '../utils/roofGeometry.ts';

const DEFAULT_ROOF_THICKNESS = 0.2;

/**
 * Build a SurfacePrimitive for a roof element.
 * For flat roofs, uses standard vertical extrusion.
 * For sloped roofs, delegates geometry to roofGeometry.ts via `prebuilt`.
 */
export function buildRoofPrimitive(
  element: CanonicalElement,
  levelElevation: number,
): SurfacePrimitive | null {
  if (element.geometry !== 'polygon') return null;
  const el = element as PolygonElement;
  if (el.vertices.length < 3) return null;

  const baseOffset = parseFloat(el.attrs.base_offset) || 0;
  const thickness = parseFloat(el.attrs.thickness) || DEFAULT_ROOF_THICKNESS;
  const baseY = levelElevation + baseOffset;
  const roofType = el.attrs.roof_type || 'flat';
  const slopeDeg = parseFloat(el.attrs.slope) || 0;
  const material = resolveBimMaterial(el.attrs.material, el.tableName);

  // Use roofGeometry for pitched roofs (it handles flat as well, but we can skip for perf).
  // Always delegate so prebuilt geometry carries slope info.
  const prebuilt = createRoofGeometry({
    kind: 'extrude',
    vertices: el.vertices.map(v => ({ x: v.x, y: v.y })),
    baseY,
    height: thickness,
    roofType,
    slopeDeg,
  }) ?? undefined;

  return {
    kind: 'surface',
    id: `surface:${el.id}`,
    elementId: el.id,
    tableName: el.tableName,
    footprint: el.vertices.map(v => ({ x: v.x, y: v.y })),
    extrudeDirection: { x: 0, y: 1, z: 0 },
    height: thickness,
    origin: { x: 0, y: baseY, z: 0 },
    material,
    prebuilt,
  };
}
