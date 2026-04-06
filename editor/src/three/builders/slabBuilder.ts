import type { CanonicalElement, PolygonElement } from '../../model/elements.ts';
import type { SurfacePrimitive, PolygonOpening } from '../primitives/types.ts';
import { resolveBimMaterial } from '../utils/bimMaterials.ts';

const DEFAULT_SLAB_THICKNESS = 0.2;

/**
 * Build a SurfacePrimitive for a slab / structure_slab / ceiling / foundation element.
 * Height = thickness (for slab/structure_slab/foundation) or height_offset (for ceiling).
 * Returns null for non-polygon geometry.
 */
export function buildSlabPrimitive(
  element: CanonicalElement,
  levelElevation: number,
  allElements: Map<string, CanonicalElement> | undefined,
): SurfacePrimitive | null {
  if (element.geometry !== 'polygon') return null;
  const el = element as PolygonElement;
  if (el.vertices.length < 3) return null;

  const baseOffset = parseFloat(el.attrs.base_offset) || 0;
  const thickness = parseFloat(el.attrs.thickness) || DEFAULT_SLAB_THICKNESS;

  // Ceiling: height_offset is typically negative (drop below level)
  let baseY = levelElevation + baseOffset;
  if (el.tableName === 'ceiling') {
    const heightOffset = parseFloat(el.attrs.height_offset) || -0.3;
    baseY = levelElevation + baseOffset + heightOffset;
  }

  const openings = collectPolygonOpenings(el.id, allElements);
  const material = resolveBimMaterial(el.attrs.material, el.tableName);

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
    openings: openings.length > 0 ? openings : undefined,
  };
}

/**
 * Find opening polygon elements whose host_id matches the given slab.
 * Handles prefixed IDs ("levelId:rawId") by matching both full and un-prefixed forms.
 */
function collectPolygonOpenings(
  slabId: string,
  allElements: Map<string, CanonicalElement> | undefined,
): PolygonOpening[] {
  if (!allElements) return [];

  // Un-prefixed id for matching CSV host_id
  const colonIdx = slabId.indexOf(':');
  const unprefixed = colonIdx >= 0 ? slabId.substring(colonIdx + 1) : slabId;

  const result: PolygonOpening[] = [];
  for (const op of allElements.values()) {
    if (op.tableName !== 'opening' || op.geometry !== 'polygon') continue;
    const hostId = op.hostId || op.attrs.host_id;
    if (!hostId) continue;
    if (hostId !== slabId && hostId !== unprefixed) continue;
    const opEl = op as PolygonElement;
    if (opEl.vertices.length < 3) continue;
    result.push({
      kind: 'polygon',
      id: op.id,
      vertices: opEl.vertices.map(v => ({ x: v.x, y: v.y })),
    });
  }
  return result;
}
