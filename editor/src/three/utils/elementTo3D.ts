import type { CanonicalElement, LineElement, PointElement, PolygonElement } from '../../model/elements.ts';

export interface BoxParams {
  kind: 'box';
  cx: number; cy: number; cz: number;   // center position
  sx: number; sy: number; sz: number;   // size (width, height, depth)
  rotY: number;                          // rotation around Y axis (radians)
}

export interface ExtrudeParams {
  kind: 'extrude';
  vertices: { x: number; y: number }[]; // 2D footprint (XZ plane in 3D)
  baseY: number;                         // bottom Y
  height: number;                        // extrusion height
}

export type Mesh3DParams = BoxParams | ExtrudeParams;

const DEFAULT_WALL_HEIGHT = 3.0;
const DEFAULT_COLUMN_HEIGHT = 3.0;
const DEFAULT_POINT_HEIGHT = 0.5;
const DEFAULT_ROOM_HEIGHT = 3.0;
const DEFAULT_SLAB_THICKNESS = 0.2;
const DEFAULT_MEP_SIZE = 0.3;

/** Resolve element height from top_level_id / top_offset / base_offset */
export function resolveHeight(
  attrs: Record<string, string>,
  levelElevation: number,
  levelElevations: Map<string, number>,
  fallback: number,
): { height: number; baseOffset: number } {
  const baseOffset = parseFloat(attrs.base_offset) || 0;

  if (attrs.top_level_id && levelElevations.has(attrs.top_level_id)) {
    const topElev = levelElevations.get(attrs.top_level_id)!;
    const topOffset = parseFloat(attrs.top_offset) || 0;
    const height = (topElev + topOffset) - (levelElevation + baseOffset);
    return { height: Math.max(height, 0.01), baseOffset };
  }

  if (attrs.height) {
    const h = parseFloat(attrs.height);
    if (h > 0) return { height: h, baseOffset };
  }

  return { height: fallback, baseOffset };
}

/** Convert a LINE element to a 3D box */
function lineToBox(
  el: LineElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): BoxParams | null {
  const dx = el.end.x - el.start.x;
  const dy = el.end.y - el.start.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (length < 0.001) return null;

  const table = el.tableName;
  let fallbackH = DEFAULT_WALL_HEIGHT;
  if (table === 'door') fallbackH = parseFloat(el.attrs.height) || 2.1;
  else if (table === 'window') fallbackH = parseFloat(el.attrs.height) || 1.2;
  else if (['duct', 'pipe', 'conduit', 'cable_tray'].includes(table)) fallbackH = DEFAULT_MEP_SIZE;
  else if (['beam', 'brace'].includes(table)) fallbackH = DEFAULT_MEP_SIZE;

  // MEP elements with start_z/end_z use absolute Z positioning
  const hasMepZ = el.attrs.start_z !== undefined && el.attrs.start_z !== '';
  let baseY: number;
  let height: number;
  let thickness: number;

  if (hasMepZ) {
    const startZ = parseFloat(el.attrs.start_z) || 0;
    const endZ = parseFloat(el.attrs.end_z) || startZ;
    // For MEP, size_y is the cross-section height
    const sizeY = parseFloat(el.attrs.size_y) || el.strokeWidth;
    baseY = Math.min(startZ, endZ) - sizeY / 2;
    height = sizeY;
    thickness = el.strokeWidth;
  } else {
    const resolved = resolveHeight(el.attrs, levelElevation, levelElevations, fallbackH);
    baseY = levelElevation + resolved.baseOffset;
    height = resolved.height;
    thickness = el.strokeWidth;
  }

  const cx = (el.start.x + el.end.x) / 2;
  // SVG Y is flipped relative to 3D Z
  const cz = -(el.start.y + el.end.y) / 2;
  const cy = baseY + height / 2;
  const rotY = -Math.atan2(dy, dx);

  return {
    kind: 'box',
    cx, cy, cz,
    sx: length,
    sy: height,
    sz: thickness,
    rotY,
  };
}

/** Convert a POINT element to a 3D box */
function pointToBox(
  el: PointElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): BoxParams {
  const fallback = ['column', 'structure_column'].includes(el.tableName)
    ? DEFAULT_COLUMN_HEIGHT
    : DEFAULT_POINT_HEIGHT;

  const { height, baseOffset } = resolveHeight(el.attrs, levelElevation, levelElevations, fallback);
  const baseY = levelElevation + baseOffset;

  return {
    kind: 'box',
    cx: el.position.x,
    cy: baseY + height / 2,
    cz: -el.position.y,
    sx: el.width,
    sy: height,
    sz: el.height,
    rotY: 0,
  };
}

/** Convert a POLYGON element to extrusion params */
function polygonToExtrude(
  el: PolygonElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): ExtrudeParams | null {
  if (el.vertices.length < 3) return null;

  const baseOffset = parseFloat(el.attrs.base_offset) || 0;
  const baseY = levelElevation + baseOffset;
  let height: number;

  if (el.tableName === 'stair') {
    const startZ = parseFloat(el.attrs.start_z) || 0;
    const endZ = parseFloat(el.attrs.end_z) || 0;
    height = Math.abs(endZ - startZ) || DEFAULT_WALL_HEIGHT;
  } else if (['slab', 'structure_slab'].includes(el.tableName)) {
    height = parseFloat(el.attrs.thickness) || DEFAULT_SLAB_THICKNESS;
  } else {
    // Space: use next level height or default
    const resolved = resolveHeight(el.attrs, levelElevation, levelElevations, DEFAULT_ROOM_HEIGHT);
    height = resolved.height;
  }

  return {
    kind: 'extrude',
    // SVG Y → 3D Z (negated)
    vertices: el.vertices.map(v => ({ x: v.x, y: -v.y })),
    baseY,
    height,
  };
}

export function elementTo3DParams(
  element: CanonicalElement,
  levelElevation: number,
  levelElevations: Map<string, number>,
): Mesh3DParams | null {
  switch (element.geometry) {
    case 'line':
      return lineToBox(element, levelElevation, levelElevations);
    case 'point':
      return pointToBox(element, levelElevation, levelElevations);
    case 'polygon':
      return polygonToExtrude(element, levelElevation, levelElevations);
  }
}
