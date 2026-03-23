export type Point = { x: number; y: number };

export interface BaseElement {
  id: string;
  tableName: string;
  discipline: string;
  attrs: Record<string, string>;
}

export interface LineElement extends BaseElement {
  geometry: 'line';
  start: Point;
  end: Point;
  strokeWidth: number;
}

export interface PointElement extends BaseElement {
  geometry: 'point';
  position: Point;
  width: number;
  height: number;
}

export interface PolygonElement extends BaseElement {
  geometry: 'polygon';
  vertices: Point[];
}

export type CanonicalElement = LineElement | PointElement | PolygonElement;

// Which geometry type each table uses
const LINE_TABLES = new Set([
  'wall', 'curtain_wall', 'structure_wall', 'door', 'window',
  'duct', 'pipe', 'conduit', 'cable_tray', 'beam', 'brace',
  'grid',
]);
const POINT_TABLES = new Set([
  'column', 'structure_column', 'equipment', 'terminal',
]);
const POLYGON_TABLES = new Set([
  'space', 'slab', 'structure_slab', 'stair',
]);

export function geometryTypeForTable(tableName: string): 'line' | 'point' | 'polygon' | null {
  if (LINE_TABLES.has(tableName)) return 'line';
  if (POINT_TABLES.has(tableName)) return 'point';
  if (POLYGON_TABLES.has(tableName)) return 'polygon';
  return null;
}

// Hosted element config: which tables can serve as hosts, and which attr holds the width
export const HOSTED_TABLES: Record<string, { hostTables: Set<string>; widthAttr: string }> = {
  door:   { hostTables: new Set(['wall', 'curtain_wall', 'structure_wall']), widthAttr: 'width' },
  window: { hostTables: new Set(['wall', 'curtain_wall', 'structure_wall']), widthAttr: 'width' },
};

export type PlacementType = 'free_line' | 'hosted' | 'free_point' | 'free_polygon' | 'grid';

export function placementTypeForTable(tableName: string): PlacementType {
  if (tableName === 'grid') return 'grid';
  if (HOSTED_TABLES[tableName]) return 'hosted';
  const geo = geometryTypeForTable(tableName);
  if (geo === 'point') return 'free_point';
  if (geo === 'polygon') return 'free_polygon';
  return 'free_line';
}
